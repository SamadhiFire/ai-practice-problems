const API_PREFIX = "/api/v1";
const DEFAULT_PORT = 3000;
const TOKEN_TTL_SECONDS = 7200;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_TAGS = 7;
const MAX_TAG_LENGTH = 12;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_GENERATION_IMAGE_BYTES = 8 * 1024 * 1024;
const GENERATION_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

const ERROR_CODES = {
  BAD_REQUEST: 40001,
  VALIDATION_FAILED: 40002,
  UNAUTHORIZED: 40100,
  FORBIDDEN: 40300,
  NOT_FOUND: 40400,
  CONFLICT: 40900,
  RATE_LIMITED: 42900,
  INTERNAL_ERROR: 50000,
  LLM_FAILED: 50010,
};

const PROVIDERS = [
  { value: "qwen", label: "千问" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
];

const PROVIDER_DEFAULTS = {
  qwen: {
    provider: "qwen",
    apiKey: "",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  deepseek: {
    provider: "deepseek",
    apiKey: "",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
  openai: {
    provider: "openai",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.2",
  },
  gemini: {
    provider: "gemini",
    apiKey: "",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
  },
};

const DEFAULT_LLM_PROVIDER = Object.prototype.hasOwnProperty.call(
  PROVIDER_DEFAULTS,
  process.env.DEFAULT_LLM_PROVIDER
)
  ? process.env.DEFAULT_LLM_PROVIDER
  : "qwen";

const defaultProviderConfig = PROVIDER_DEFAULTS[DEFAULT_LLM_PROVIDER];

const DEFAULT_LLM_CONFIG = {
  provider: DEFAULT_LLM_PROVIDER,
  apiKey: "",
  baseUrl: process.env.LLM_BASE_URL || defaultProviderConfig.baseUrl,
  model: process.env.LLM_MODEL || defaultProviderConfig.model,
  managedKeys: {
    qwen: "",
    deepseek: "",
    openai: "",
    gemini: "",
  },
};

const DEFAULT_STORAGE_DRIVER = process.env.STORAGE_DRIVER || "mongodb";
const DEFAULT_MONGODB_URL =
  process.env.MONGODB_URL ||
  "mongodb://127.0.0.1:27017";
const DEFAULT_MONGODB_DB_NAME = process.env.MONGODB_DB || "ainnn_backend";
const DEFAULT_MONGODB_COLLECTION =
  process.env.MONGODB_COLLECTION || "backend_state";
const DEFAULT_MONGODB_STATE_KEY =
  process.env.MONGODB_STATE_KEY || "default";

module.exports = {
  API_PREFIX,
  DEFAULT_PORT,
  TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  MAX_AVATAR_BYTES,
  MAX_GENERATION_IMAGE_BYTES,
  GENERATION_IMAGE_MIME_TYPES,
  ERROR_CODES,
  PROVIDERS,
  PROVIDER_DEFAULTS,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_CONFIG,
  DEFAULT_STORAGE_DRIVER,
  DEFAULT_MONGODB_URL,
  DEFAULT_MONGODB_DB_NAME,
  DEFAULT_MONGODB_COLLECTION,
  DEFAULT_MONGODB_STATE_KEY,
};
