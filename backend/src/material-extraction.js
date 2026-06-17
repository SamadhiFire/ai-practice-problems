const {
  ERROR_CODES,
  GENERATION_IMAGE_MIME_TYPES,
  MAX_GENERATION_IMAGE_BYTES,
} = require("./constants");
const {
  createProviderVisionText,
  formatProviderError,
} = require("./llm-provider");
const { hashText } = require("./utils");

const DATA_URL_IMAGE_PATTERN = /^data:([^;,]+);base64,([\s\S]+)$/i;
const IMAGE_EXTRACTION_TEMPERATURE = 0.1;
const IMAGE_EXTRACTION_TOP_P = 0.8;
const IMAGE_EXTRACTION_MAX_OUTPUT_TOKENS = 2200;
const MIN_EXTRACTED_MATERIAL_LENGTH = 12;

function createValidationError(message) {
  const error = new Error(message);
  error.code = ERROR_CODES.VALIDATION_FAILED;
  return error;
}

function normalizeMimeType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "image/jpg") return "image/jpeg";
  return raw;
}

function compactBase64(value) {
  return String(value || "").replace(/\s+/g, "");
}

function normalizeGenerationImageDataUrl(value) {
  const raw = String(value || "").trim();
  const match = DATA_URL_IMAGE_PATTERN.exec(raw);
  if (!match) {
    throw createValidationError("Invalid image data. Please choose the image again.");
  }

  const mimeType = normalizeMimeType(match[1]);
  if (!GENERATION_IMAGE_MIME_TYPES.includes(mimeType)) {
    throw createValidationError("Only JPG, PNG, WEBP, or GIF images are supported.");
  }

  const imageBase64 = compactBase64(match[2]);
  if (!imageBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
    throw createValidationError("Image data is not valid base64 content.");
  }

  const buffer = Buffer.from(imageBase64, "base64");
  if (buffer.length === 0 || buffer.length > MAX_GENERATION_IMAGE_BYTES) {
    throw createValidationError("The image is empty or larger than 8MB.");
  }

  return {
    dataUrl: `data:${mimeType};base64,${imageBase64}`,
    imageBase64,
    mimeType,
    byteLength: buffer.length,
    fingerprint: hashText(`${mimeType}:${imageBase64}`),
  };
}

function stripCodeFence(text) {
  return String(text || "")
    .replace(/^```(?:text|markdown|md|json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function normalizeExtractedMaterial(text) {
  return stripCodeFence(text)
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function assertExtractedMaterialUsable(material) {
  const clean = normalizeExtractedMaterial(material);
  if (clean.length < MIN_EXTRACTED_MATERIAL_LENGTH) {
    throw createValidationError("Too little study material could be recognized from the image.");
  }
  if (/^(?:insufficient|unclear|cannot recognize|no readable|无法识别|看不清|图片不清晰|没有可识别)/i.test(clean)) {
    throw createValidationError("The image is not clear enough to extract stable study material.");
  }
}

function buildImageExtractionPrompt(request) {
  const userMaterial = String(request.material || "").trim();
  return [
    "Read the uploaded image carefully and extract study material for quiz generation.",
    "",
    "Critical rules:",
    "1. Use only visible image content while extracting. Do not add outside knowledge during this extraction step.",
    "2. Preserve original terms, abbreviations, formulas, numbers, table relationships, steps, and confusable points.",
    "3. If an acronym appears without its full form, keep only the acronym. Do not infer or expand it.",
    "4. If a formula or relationship is visible, copy it precisely.",
    "5. If the image is too blurry to read, reply with exactly: INSUFFICIENT_IMAGE_MATERIAL.",
    "6. Output plain text only. No JSON. No code fence.",
    "",
    "Output format:",
    "OCR text:",
    "- ...",
    "",
    "Testable points:",
    "- Point: ... | Evidence: ...",
    "",
    "Later quiz generation will use these extracted knowledge points and may add reasonable answer choices, explanations, and related context.",
    userMaterial ? `User supplemental text:\n${userMaterial}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function mergeImageMaterial(userMaterial, extractedMaterial) {
  const cleanUserMaterial = String(userMaterial || "").trim();
  const cleanExtracted = normalizeExtractedMaterial(extractedMaterial);
  if (!cleanUserMaterial) return cleanExtracted;
  return [
    "User supplemental material:",
    cleanUserMaterial,
    "",
    "Extracted image material:",
    cleanExtracted,
  ].join("\n");
}

async function extractMaterialFromGenerationImage({ request, llmConfig }) {
  if (!request?.image) {
    return String(request?.material || "").trim();
  }

  let result;
  try {
    result = await createProviderVisionText({
      config: llmConfig,
      prompt: buildImageExtractionPrompt(request),
      imageDataUrl: request.image.dataUrl,
      imageBase64: request.image.imageBase64,
      mimeType: request.image.mimeType,
      temperature: IMAGE_EXTRACTION_TEMPERATURE,
      topP: IMAGE_EXTRACTION_TOP_P,
      maxOutputTokens: IMAGE_EXTRACTION_MAX_OUTPUT_TOKENS,
    });
  } catch (error) {
    const wrapped = new Error(`Image parsing failed: ${formatProviderError(error)}`);
    wrapped.code = error.code || ERROR_CODES.LLM_FAILED;
    throw wrapped;
  }

  const material = mergeImageMaterial(request.material, result?.text || "");
  assertExtractedMaterialUsable(material);
  return material;
}

module.exports = {
  extractMaterialFromGenerationImage,
  normalizeGenerationImageDataUrl,
};
