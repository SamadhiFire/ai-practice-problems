const OpenAI = require("openai");
const { ERROR_CODES, PROVIDER_DEFAULTS } = require("./constants");

const REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_TOP_P = 0.95;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const MIN_MAX_OUTPUT_TOKENS = 256;
const MAX_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_QWEN_VISION_MODEL = process.env.QWEN_VISION_MODEL || "qwen-vl-plus";

const CHAT_COMPLETION_PROVIDERS = new Set(["qwen", "deepseek"]);
const RESPONSES_PROVIDERS = new Set(["openai"]);
const GENERATE_CONTENT_PROVIDERS = new Set(["gemini"]);
const VISION_CHAT_COMPLETION_PROVIDERS = new Set(["qwen"]);
const VISION_RESPONSES_PROVIDERS = new Set(["openai"]);
const VISION_GENERATE_CONTENT_PROVIDERS = new Set(["gemini"]);
const REMOTE_CAPABLE_PROVIDERS = new Set([
  ...CHAT_COMPLETION_PROVIDERS,
  ...RESPONSES_PROVIDERS,
  ...GENERATE_CONTENT_PROVIDERS,
]);

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function resolveEnvApiKey(provider) {
  if (provider === "qwen") {
    return process.env.DASHSCOPE_API_KEY || "";
  }
  if (provider === "deepseek") {
    return process.env.DEEPSEEK_API_KEY || "";
  }
  if (provider === "openai") {
    return process.env.OPENAI_API_KEY || "";
  }
  if (provider === "gemini") {
    return process.env.GEMINI_API_KEY || "";
  }
  return "";
}

function resolveLlmConfig(config = {}) {
  const provider = Object.prototype.hasOwnProperty.call(
    PROVIDER_DEFAULTS,
    config.provider
  )
    ? config.provider
    : "qwen";
  const defaults = PROVIDER_DEFAULTS[provider];
  const managedKeys =
    config && typeof config.managedKeys === "object" && config.managedKeys
      ? config.managedKeys
      : {};

  return {
    provider,
    apiKey: firstNonEmptyString(
      config.apiKey,
      managedKeys[provider],
      resolveEnvApiKey(provider)
    ),
    baseUrl: firstNonEmptyString(config.baseUrl, defaults.baseUrl),
    model: firstNonEmptyString(config.model, defaults.model),
    managedKeys: { ...managedKeys },
  };
}

function isProviderRemoteCapable(provider) {
  return REMOTE_CAPABLE_PROVIDERS.has(provider);
}

function clampMaxOutputTokens(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }
  return Math.min(
    MAX_MAX_OUTPUT_TOKENS,
    Math.max(MIN_MAX_OUTPUT_TOKENS, Math.round(parsed))
  );
}

function clampTopP(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TOP_P;
  }
  return Math.min(1, Math.max(0.01, parsed));
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item.text === "string") {
          return item.text;
        }
        if (item && item.type === "text" && typeof item.value === "string") {
          return item.value;
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((message) => ({
      role: ["system", "developer", "user", "assistant"].includes(message?.role)
        ? message.role
        : "user",
      content: extractTextContent(message?.content),
    }))
    .filter((message) => message.content);
}

function normalizeChatRole(role) {
  if (role === "system" || role === "developer") {
    return "system";
  }
  if (role === "assistant") {
    return "assistant";
  }
  return "user";
}

function normalizeResponseRole(role) {
  if (role === "system" || role === "developer") {
    return "developer";
  }
  if (role === "assistant") {
    return "assistant";
  }
  return "user";
}

function normalizeGeminiRole(role) {
  return role === "assistant" ? "model" : "user";
}

function extractChatCompletionText(completion) {
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item.text === "string") {
          return item.text;
        }
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function extractResponseText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const output = Array.isArray(response?.output) ? response.output : [];
  return output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((item) => (typeof item?.text === "string" ? item.text : ""))
    .join("")
    .trim();
}

function extractGeminiText(response) {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  return candidates
    .flatMap((candidate) =>
      Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
    )
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function formatProviderError(error) {
  const parts = [];
  if (error && Number.isFinite(error.status)) {
    parts.push(`HTTP ${error.status}`);
  }
  if (error && typeof error.name === "string" && error.name.trim()) {
    parts.push(error.name.trim());
  }
  if (error && typeof error.message === "string" && error.message.trim()) {
    parts.push(error.message.trim());
  }
  return parts.join(": ") || "provider request failed";
}

function assertRemoteConfig(resolved) {
  if (!isProviderRemoteCapable(resolved.provider)) {
    const error = new Error(
      `provider ${resolved.provider} does not support live verification in this backend`
    );
    error.code = ERROR_CODES.VALIDATION_FAILED;
    throw error;
  }

  if (!resolved.apiKey) {
    const error = new Error(
      `missing API key for provider ${resolved.provider}; set it in /llm/config or the corresponding environment variable`
    );
    error.code = ERROR_CODES.VALIDATION_FAILED;
    throw error;
  }
}

function isQwenVisionModel(model) {
  return /(?:vl|vision|omni)/i.test(String(model || ""));
}

function resolveVisionLlmConfig(config = {}) {
  const resolved = resolveLlmConfig(config);
  if (resolved.provider === "qwen" && !isQwenVisionModel(resolved.model)) {
    return {
      ...resolved,
      model: DEFAULT_QWEN_VISION_MODEL,
      textModel: resolved.model,
      visionModelFallback: true,
    };
  }
  return resolved;
}

function assertVisionConfig(resolved) {
  assertRemoteConfig(resolved);

  if (
    !VISION_CHAT_COMPLETION_PROVIDERS.has(resolved.provider) &&
    !VISION_RESPONSES_PROVIDERS.has(resolved.provider) &&
    !VISION_GENERATE_CONTENT_PROVIDERS.has(resolved.provider)
  ) {
    const error = new Error(
      `当前 ${resolved.provider} 配置不支持图片解析，请切换到 OpenAI、Gemini 或千问视觉模型`
    );
    error.code = ERROR_CODES.VALIDATION_FAILED;
    throw error;
  }

  if (resolved.provider === "qwen" && !isQwenVisionModel(resolved.model)) {
    resolved.model = DEFAULT_QWEN_VISION_MODEL;
  }
}

async function createOpenAICompatibleChatCompletion({
  resolved,
  messages,
  temperature,
  topP,
  maxOutputTokens,
}) {
  const client = new OpenAI({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseUrl,
    timeout: REQUEST_TIMEOUT_MS,
  });
  const completion = await client.chat.completions.create({
    model: resolved.model,
    messages: normalizeMessages(messages).map((message) => ({
      role: normalizeChatRole(message.role),
      content: message.content,
    })),
    temperature,
    top_p: clampTopP(topP),
    max_tokens: clampMaxOutputTokens(maxOutputTokens),
  });

  return {
    config: resolved,
    transport: "chat_completions",
    raw: completion,
    text: extractChatCompletionText(completion),
  };
}

async function createOpenAICompatibleVisionChatCompletion({
  resolved,
  prompt,
  imageDataUrl,
  temperature,
  topP,
  maxOutputTokens,
}) {
  const client = new OpenAI({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseUrl,
    timeout: REQUEST_TIMEOUT_MS,
  });
  const completion = await client.chat.completions.create({
    model: resolved.model,
    messages: [
      {
        role: "system",
        content: "You extract study material from images faithfully.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: { url: imageDataUrl },
          },
        ],
      },
    ],
    temperature,
    top_p: clampTopP(topP),
    max_tokens: clampMaxOutputTokens(maxOutputTokens),
  });

  return {
    config: resolved,
    transport: "chat_completions_vision",
    raw: completion,
    text: extractChatCompletionText(completion),
  };
}

async function createOpenAIResponsesCompletion({
  resolved,
  messages,
  temperature,
  topP,
  maxOutputTokens,
}) {
  const client = new OpenAI({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseUrl,
    timeout: REQUEST_TIMEOUT_MS,
  });
  const response = await client.responses.create({
    model: resolved.model,
    input: normalizeMessages(messages).map((message) => ({
      role: normalizeResponseRole(message.role),
      content: [{ type: "input_text", text: message.content }],
    })),
    temperature,
    top_p: clampTopP(topP),
    max_output_tokens: clampMaxOutputTokens(maxOutputTokens),
  });

  return {
    config: resolved,
    transport: "responses",
    raw: response,
    text: extractResponseText(response),
  };
}

async function createOpenAIResponsesVisionCompletion({
  resolved,
  prompt,
  imageDataUrl,
  temperature,
  topP,
  maxOutputTokens,
}) {
  const client = new OpenAI({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseUrl,
    timeout: REQUEST_TIMEOUT_MS,
  });
  const response = await client.responses.create({
    model: resolved.model,
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "You extract study material from images faithfully.",
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: imageDataUrl, detail: "high" },
        ],
      },
    ],
    temperature,
    top_p: clampTopP(topP),
    max_output_tokens: clampMaxOutputTokens(maxOutputTokens),
  });

  return {
    config: resolved,
    transport: "responses_vision",
    raw: response,
    text: extractResponseText(response),
  };
}

function buildGeminiRequestBody(messages, temperature, topP, maxOutputTokens) {
  const normalized = normalizeMessages(messages);
  const systemText = normalized
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
  const contents = normalized
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .map((message) => ({
      role: normalizeGeminiRole(message.role),
      parts: [{ text: message.content }],
    }));

  return {
    ...(systemText
      ? {
          systemInstruction: {
            parts: [{ text: systemText }],
          },
        }
      : {}),
    contents:
      contents.length > 0
        ? contents
        : [{ role: "user", parts: [{ text: "" }] }],
    generationConfig: {
      temperature,
      topP: clampTopP(topP),
      maxOutputTokens: clampMaxOutputTokens(maxOutputTokens),
    },
  };
}

function buildGeminiVisionRequestBody(
  prompt,
  imageBase64,
  mimeType,
  temperature,
  topP,
  maxOutputTokens
) {
  return {
    systemInstruction: {
      parts: [{ text: "You extract study material from images faithfully." }],
    },
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature,
      topP: clampTopP(topP),
      maxOutputTokens: clampMaxOutputTokens(maxOutputTokens),
    },
  };
}

async function createGeminiGenerateContent({
  resolved,
  messages,
  temperature,
  topP,
  maxOutputTokens,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const endpoint = `${resolved.baseUrl.replace(/\/$/, "")}/models/${resolved.model}:generateContent`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": resolved.apiKey,
      },
      body: JSON.stringify(
        buildGeminiRequestBody(messages, temperature, topP, maxOutputTokens)
      ),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(
        payload?.error?.message || `Gemini request failed with status ${response.status}`
      );
      error.status = response.status;
      error.code = ERROR_CODES.VALIDATION_FAILED;
      error.data = payload;
      throw error;
    }

    return {
      config: resolved,
      transport: "generateContent",
      raw: payload,
      text: extractGeminiText(payload),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function createGeminiVisionGenerateContent({
  resolved,
  prompt,
  imageBase64,
  mimeType,
  temperature,
  topP,
  maxOutputTokens,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const endpoint = `${resolved.baseUrl.replace(/\/$/, "")}/models/${resolved.model}:generateContent`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": resolved.apiKey,
      },
      body: JSON.stringify(
        buildGeminiVisionRequestBody(
          prompt,
          imageBase64,
          mimeType,
          temperature,
          topP,
          maxOutputTokens
        )
      ),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(
        payload?.error?.message || `Gemini request failed with status ${response.status}`
      );
      error.status = response.status;
      error.code = ERROR_CODES.VALIDATION_FAILED;
      error.data = payload;
      throw error;
    }

    return {
      config: resolved,
      transport: "generateContent_vision",
      raw: payload,
      text: extractGeminiText(payload),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function createProviderText({
  config,
  messages,
  temperature = DEFAULT_TEMPERATURE,
  topP = DEFAULT_TOP_P,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
}) {
  const resolved = resolveLlmConfig(config);
  assertRemoteConfig(resolved);

  if (CHAT_COMPLETION_PROVIDERS.has(resolved.provider)) {
    return createOpenAICompatibleChatCompletion({
      resolved,
      messages,
      temperature,
      topP,
      maxOutputTokens,
    });
  }

  if (RESPONSES_PROVIDERS.has(resolved.provider)) {
    return createOpenAIResponsesCompletion({
      resolved,
      messages,
      temperature,
      topP,
      maxOutputTokens,
    });
  }

  if (GENERATE_CONTENT_PROVIDERS.has(resolved.provider)) {
    return createGeminiGenerateContent({
      resolved,
      messages,
      temperature,
      topP,
      maxOutputTokens,
    });
  }

  const error = new Error(`provider ${resolved.provider} is not supported`);
  error.code = ERROR_CODES.VALIDATION_FAILED;
  throw error;
}

async function createProviderVisionText({
  config,
  prompt,
  imageDataUrl,
  imageBase64,
  mimeType,
  temperature = DEFAULT_TEMPERATURE,
  topP = DEFAULT_TOP_P,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
}) {
  const resolved = resolveVisionLlmConfig(config);
  assertVisionConfig(resolved);

  if (VISION_CHAT_COMPLETION_PROVIDERS.has(resolved.provider)) {
    return createOpenAICompatibleVisionChatCompletion({
      resolved,
      prompt,
      imageDataUrl,
      temperature,
      topP,
      maxOutputTokens,
    });
  }

  if (VISION_RESPONSES_PROVIDERS.has(resolved.provider)) {
    return createOpenAIResponsesVisionCompletion({
      resolved,
      prompt,
      imageDataUrl,
      temperature,
      topP,
      maxOutputTokens,
    });
  }

  if (VISION_GENERATE_CONTENT_PROVIDERS.has(resolved.provider)) {
    return createGeminiVisionGenerateContent({
      resolved,
      prompt,
      imageBase64,
      mimeType,
      temperature,
      topP,
      maxOutputTokens,
    });
  }

  const error = new Error(`provider ${resolved.provider} is not supported`);
  error.code = ERROR_CODES.VALIDATION_FAILED;
  throw error;
}

async function verifyProviderConfig(config = {}) {
  const resolved = resolveLlmConfig(config);

  if (!isProviderRemoteCapable(resolved.provider)) {
    return {
      ok: false,
      status: "unknown",
      code: ERROR_CODES.VALIDATION_FAILED,
      message: `provider ${resolved.provider} is not wired for live verification`,
      provider: resolved.provider,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
    };
  }

  try {
    const result = await createProviderText({
      config: resolved,
      messages: [
        {
          role: "system",
          content: "You are a connectivity check. Reply with OK only.",
        },
        {
          role: "user",
          content: "Reply with OK only.",
        },
      ],
      temperature: 0,
      topP: 1,
      maxOutputTokens: 256,
    });

    return {
      ok: true,
      status: "success",
      code: 0,
      message: `provider verification passed: ${result.text || "OK"}`,
      provider: resolved.provider,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
    };
  } catch (error) {
    return {
      ok: false,
      status: "error",
      code: error.code || ERROR_CODES.VALIDATION_FAILED,
      message: formatProviderError(error),
      provider: resolved.provider,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
    };
  }
}

module.exports = {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TOP_P,
  REQUEST_TIMEOUT_MS,
  createProviderVisionText,
  createProviderText,
  createChatCompletion: createProviderText,
  formatProviderError,
  isProviderRemoteCapable,
  resolveLlmConfig,
  verifyProviderConfig,
};
