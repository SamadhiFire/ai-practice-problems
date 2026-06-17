const { createHash, randomUUID, scryptSync, timingSafeEqual } = require("crypto");
const {
  DEFAULT_LLM_CONFIG,
  ERROR_CODES,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  PROVIDERS,
} = require("./constants");

function now() {
  return Date.now();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function generateId(prefix) {
  return `${prefix}_${now()}_${randomUUID().slice(0, 8)}`;
}

function makeToken(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function hashText(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];

  for (const tag of tags) {
    const value = String(tag || "").trim();
    if (!value || value.length > MAX_TAG_LENGTH || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
    if (normalized.length >= MAX_TAGS) {
      break;
    }
  }

  return normalized;
}

function createDefaultLlmConfig() {
  return clone(DEFAULT_LLM_CONFIG);
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function splitMaterial(material) {
  const cleaned = String(material || "")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join(" ");

  if (!cleaned) {
    return [];
  }

  const primaryChunks = cleaned
    .split(/[.!?;:\u3002\uFF01\uFF1F\uFF1B\uFF1A]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (primaryChunks.length > 1) {
    return primaryChunks;
  }

  const secondaryChunks = cleaned
    .split(/[,\uFF0C\u3001]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 8);

  if (secondaryChunks.length > 1) {
    return secondaryChunks;
  }

  if (cleaned.length <= 120) {
    return [cleaned];
  }

  const chunks = [];
  let cursor = 0;
  while (cursor < cleaned.length) {
    const hardEnd = Math.min(cursor + 120, cleaned.length);
    let end = hardEnd;

    if (hardEnd < cleaned.length) {
      const searchWindow = cleaned.slice(cursor, Math.min(cursor + 160, cleaned.length));
      const boundaryPattern = /[s,??;?.!????:?]/g;
      let match;
      let boundary = -1;
      while ((match = boundaryPattern.exec(searchWindow))) {
        if (match.index >= 72) {
          boundary = match.index;
        }
      }
      if (boundary >= 0) {
        end = cursor + boundary + 1;
      }
    }

    const piece = cleaned.slice(cursor, end).trim();
    if (piece) {
      chunks.push(piece);
    }
    cursor = end;
  }

  return chunks.length > 0 ? chunks : [cleaned.slice(0, 200)];
}

function normalizeAccount(account) {
  const raw = String(account || "").trim();
  if (!raw) {
    return "";
  }

  if (raw.includes("@")) {
    return raw.toLowerCase();
  }

  return raw.replace(/[\s-]/g, "");
}

function validateAccount(account) {
  const normalized = normalizeAccount(account);
  if (!normalized) {
    return {
      ok: false,
      message: "account is required",
    };
  }

  if (normalized.includes("@")) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
      ? { ok: true, normalized }
      : { ok: false, message: "account must be a valid email or phone number" };
  }

  return /^\+?\d{6,20}$/.test(normalized)
    ? { ok: true, normalized }
    : { ok: false, message: "account must be a valid email or phone number" };
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 6) {
    return {
      ok: false,
      message: "password must be at least 6 characters",
    };
  }

  return {
    ok: true,
    value,
  };
}

function createPasswordHash(password) {
  const salt = randomUUID().replace(/-/g, "");
  const hash = scryptSync(String(password || ""), salt, 64).toString("hex");
  return {
    salt,
    hash,
  };
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) {
    return false;
  }

  const computed = scryptSync(String(password || ""), salt, 64);
  const expected = Buffer.from(String(expectedHash || ""), "hex");
  return (
    computed.length === expected.length &&
    timingSafeEqual(computed, expected)
  );
}

function createUserProfile({ account, nickname, avatarUrl }) {
  const timestamp = now();
  const normalizedAccount = normalizeAccount(account);
  const fallbackNickname = normalizedAccount || "Guest User";

  return {
    userId: generateId("u"),
    nickname: String(nickname || fallbackNickname).trim() || fallbackNickname,
    avatarUrl: String(avatarUrl || ""),
    ...(normalizedAccount ? { account: normalizedAccount } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
    lastLoginAt: timestamp,
  };
}

function compareChoices(userChoice, correctAnswer) {
  return normalizeAnswer(userChoice) === normalizeAnswer(correctAnswer);
}

function normalizeAnswer(answer) {
  return String(answer || "")
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
    .sort()
    .join(",");
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function buildIdempotencyKey(userId, payload) {
  const fingerprint = [
    userId,
    payload.requestNonce || 0,
    hashText(payload.material || ""),
    payload.image?.fingerprint || "",
    payload.type || "",
    payload.difficulty || "",
    payload.mode || "",
    payload.feedbackMode || "",
    payload.targetCount || 0,
  ].join("|");
  return hashText(fingerprint);
}

function ensureStoredQuestion(question, defaults = {}) {
  return {
    id: String(question.id || defaults.id || generateId("q")),
    type: question.type === "multi" ? "multi" : "single",
    stem: String(question.stem || defaults.stem || ""),
    tag: String(question.tag || defaults.tag || "untagged"),
    options: Array.isArray(question.options)
      ? question.options.map((option, index) => ({
          key: String(option.key || String.fromCharCode(65 + index)),
          text: String(option.text || ""),
          ...(typeof option.isCorrect === "boolean"
            ? { isCorrect: option.isCorrect }
            : {}),
        }))
      : [],
    answer: normalizeAnswer(question.answer || defaults.answer || ""),
    explanation: String(question.explanation || defaults.explanation || ""),
    evidence_quote: String(
      question.evidence_quote || defaults.evidence_quote || ""
    ),
    keypoint_id: String(question.keypoint_id || defaults.keypoint_id || ""),
    difficulty: ["easy", "medium", "hard"].includes(question.difficulty)
      ? question.difficulty
      : defaults.difficulty || "medium",
    createdAt: Number.isFinite(question.createdAt)
      ? question.createdAt
      : defaults.createdAt || now(),
    mode: ["modeA", "modeB"].includes(question.mode)
      ? question.mode
      : defaults.mode || "modeA",
    practiceCount: Number.isFinite(question.practiceCount)
      ? question.practiceCount
      : defaults.practiceCount || 0,
    wrongCount: Number.isFinite(question.wrongCount)
      ? question.wrongCount
      : defaults.wrongCount || 0,
    isMastered:
      typeof question.isMastered === "boolean"
        ? question.isMastered
        : defaults.isMastered || false,
    ...(Number.isFinite(question.category_order)
      ? { category_order: question.category_order }
      : Number.isFinite(defaults.category_order)
      ? { category_order: defaults.category_order }
      : {}),
    ...(Number.isFinite(question.lastWrongAt)
      ? { lastWrongAt: question.lastWrongAt }
      : Number.isFinite(defaults.lastWrongAt)
      ? { lastWrongAt: defaults.lastWrongAt }
      : {}),
    ...(String(question.question_angle || defaults.question_angle || "").trim()
      ? { question_angle: String(question.question_angle || defaults.question_angle || "").trim() }
      : {}),
    ...(String(question.question_category || defaults.question_category || "").trim()
      ? {
          question_category: String(
            question.question_category || defaults.question_category || ""
          ).trim(),
        }
      : {}),
  };
}

function validateStoredQuestion(question) {
  const errors = [];
  if (!question.id) {
    errors.push("question.id is required");
  }
  if (!["single", "multi"].includes(question.type)) {
    errors.push("question.type must be single or multi");
  }
  if (!question.stem) {
    errors.push("question.stem is required");
  }
  if (!question.answer) {
    errors.push("question.answer is required");
  }
  if (!question.evidence_quote) {
    errors.push("question.evidence_quote is required");
  }
  if (!question.keypoint_id) {
    errors.push("question.keypoint_id is required");
  }

  const optionKeys = new Set((question.options || []).map((option) => option.key));
  for (const choice of normalizeAnswer(question.answer).split(",").filter(Boolean)) {
    if (!optionKeys.has(choice)) {
      errors.push(`question.answer contains unknown option ${choice}`);
    }
  }

  return errors;
}

function deriveGoalTags(goal) {
  const text = String(goal || "").trim();
  if (!text) {
    return [];
  }

  const keywordMap = [
    ["english", "english"],
    ["\u82f1\u8bed", "english"],
    ["reading", "reading"],
    ["\u9605\u8bfb", "reading"],
    ["math", "math"],
    ["\u6570\u5b66", "math"],
    ["logic", "logic"],
    ["\u903b\u8f91", "logic"],
    ["essay", "essay"],
    ["\u5199\u4f5c", "essay"],
    ["\u4f5c\u6587", "essay"],
    ["vocabulary", "vocabulary"],
    ["\u8bcd\u6c47", "vocabulary"],
    ["grammar", "grammar"],
    ["\u8bed\u6cd5", "grammar"],
    ["exam", "exam"],
    ["\u8003\u8bd5", "exam"],
    ["\u5237\u9898", "practice"],
    ["\u7ec3\u4e60", "practice"],
  ];

  const lowered = text.toLowerCase();
  const tags = [];

  for (const [keyword, label] of keywordMap) {
    if (lowered.includes(keyword) && !tags.includes(label)) {
      tags.push(label);
    }
  }

  if (tags.length > 0) {
    return normalizeTags(tags);
  }

  const latinTokens = text
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => /[A-Za-z0-9]/.test(item))
    .filter((item) => item.length >= 2 && item.length <= MAX_TAG_LENGTH);

  const hanTokens = (text.match(/[\u3400-\u9fff]{2,}/g) || [])
    .map((item) => item.slice(0, MAX_TAG_LENGTH))
    .filter((item) => item.length >= 2 && item.length <= MAX_TAG_LENGTH);

  const fallback = normalizeTags([...latinTokens, ...hanTokens]).slice(0, MAX_TAGS);

  return normalizeTags(fallback.length > 0 ? fallback : ["study", "practice"]);
}

function verifyApiKeyBasic(provider, apiKey) {
  if (!PROVIDERS.some((item) => item.value === provider)) {
    return {
      ok: false,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: `unsupported provider: ${provider}`,
    };
  }

  if (typeof apiKey !== "string" || apiKey.trim().length < 6) {
    return {
      ok: false,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: "apiKey is too short for basic validation",
    };
  }

  return {
    ok: true,
    code: 0,
    message: "basic local validation passed; provider-side verification is pending",
  };
}

module.exports = {
  now,
  clone,
  generateId,
  makeToken,
  hashText,
  normalizeTags,
  createDefaultLlmConfig,
  safeJsonParse,
  splitMaterial,
  normalizeAccount,
  validateAccount,
  validatePassword,
  createPasswordHash,
  verifyPassword,
  createUserProfile,
  compareChoices,
  normalizeAnswer,
  toPositiveInt,
  buildIdempotencyKey,
  ensureStoredQuestion,
  validateStoredQuestion,
  deriveGoalTags,
  verifyApiKeyBasic,
};
