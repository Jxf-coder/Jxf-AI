/**
 * 启动期环境变量校验（fail-closed）。
 *
 * 红线：JXF_AUTH_SECRET 缺失 / 过短 / 弱值时必须拒绝启动，不允许降级放行。
 * 该模块在 instrumentation.register() 中首次调用，健康检查与 DB 连接复用缓存结果。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * AI 配置（OpenAI 标准兼容）。
 * 与数据库 / S3 不同，AI 缺失不拒绝启动：无 Key 时检索降级为 pg_bigm 纯关键词。
 */
/** 备用 LLM 节点：主节点重试耗尽后自动接续（同协议，可直接是另一家 OpenAI 兼容服务） */
export interface AiFallbackConfig {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  fastModel: string;
}

export interface AiEnvConfig {
  /** 对话生成总开关；false 或缺少 Key 时只做检索，不生成答案 */
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  /** 深度推理模型：顾问问答、复杂检索生成 */
  chatModel: string;
  /** 高频轻量模型：文档巡读抽取、蒸馏建卡、摘要 */
  fastModel: string;
  timeoutMs: number;
  topK: number;
  maxTokens: number;
  /** 瞬时故障（503 / 超时 / 连接重置）的指数避让重试次数，0 表示不重试 */
  retryAttempts: number;
  retryBaseMs: number;
  /** 未配置备用节点时为 null：重试耗尽即安静降级，不阻断前端 */
  fallback: AiFallbackConfig | null;
  embedding: {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions: number;
  };
}

/** 扫描件 OCR（Gemini 视觉）：未配置 Key 或显式关闭时不外发任何文档内容 */
export interface OcrEnvConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** 单次提交给视觉模型的最大字节数（base64 后仍受请求体限制） */
  maxBytes: number;
}

export interface AppEnv {
  nodeEnv: string;
  appEnv: string;
  logLevel: LogLevel;
  version: string;
  authSecret: string;
  databaseUrl: string;
  /** 私有化交付下恒为单值；仅作未来 SaaS 预留 */
  tenantId: string;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
  };
  ai: AiEnvConfig;
  ocr: OcrEnvConfig;
}

const VALID_LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** 明显的占位值 / 弱值，命中即拒绝启动 */
const WEAK_VALUE_PATTERNS: readonly RegExp[] = [
  /change[-_\s]?me/i,
  /placeholder/i,
  /your[-_\s]?secret/i,
  /^secret$/i,
  /^password$/i,
  /^changeme$/i,
];

const MIN_SECRET_LENGTH = 32;

let cached: AppEnv | null = null;

function readRequired(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`环境变量 ${name} 缺失，拒绝启动（fail-closed）`);
  }
  return value;
}

function readSecret(name: string): string {
  const value = readRequired(name);
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`环境变量 ${name} 长度不足 ${MIN_SECRET_LENGTH} 字符，拒绝启动`);
  }
  if (WEAK_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(`环境变量 ${name} 命中弱值黑名单，拒绝启动（请使用随机值）`);
  }
  return value;
}

function readUrl(name: string, protocols: readonly string[]): string {
  const value = readRequired(name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`环境变量 ${name} 不是合法 URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`环境变量 ${name} 协议必须是 ${protocols.join(" / ")}`);
  }
  return value;
}

function readLogLevel(): LogLevel {
  const raw = (process.env.JXF_LOG_LEVEL ?? "info").toLowerCase();
  if (!VALID_LOG_LEVELS.includes(raw as LogLevel)) {
    throw new Error(`JXF_LOG_LEVEL 非法：${raw}，可选 ${VALID_LOG_LEVELS.join(" / ")}`);
  }
  return raw as LogLevel;
}

/** AI 相关均为可选项：缺失时安静降级，不阻断启动 */
function readOptional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function readOptionalInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 允许 0 的计数型配置（如重试次数 0 = 关闭重试） */
function readOptionalCount(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * 备用 LLM 节点：baseUrl 与 apiKey 同时具备才启用。
 * 留空即视为「无备用节点」，重试耗尽后按原逻辑安静降级。
 */
function readAiFallback(chatModel: string, fastModel: string): AiFallbackConfig | null {
  const fallbackBaseUrl = readOptional("JXF_AI_FALLBACK_BASE_URL", "").replace(/\/+$/, "");
  const fallbackApiKey = readOptional("JXF_AI_FALLBACK_API_KEY", "");
  if (!fallbackBaseUrl || !fallbackApiKey) {
    return null;
  }
  return {
    baseUrl: fallbackBaseUrl,
    apiKey: fallbackApiKey,
    // 未单独指定时沿用主节点模型名（同厂商备用节点场景）
    chatModel: readOptional("JXF_AI_FALLBACK_MODEL_PRO", chatModel),
    fastModel: readOptional("JXF_AI_FALLBACK_MODEL_FLASH", fastModel),
  };
}

function readAiConfig(): AiEnvConfig {
  const apiKey = readOptional("JXF_AI_API_KEY", "");
  // 对话服务不一定提供 embedding 接口（如 DeepSeek），因此不复用 chat key：
  // 未显式配置 JXF_EMBEDDING_API_KEY 时，向量通道保持关闭，页面如实显示「仅关键词」。
  const embeddingApiKey = readOptional("JXF_EMBEDDING_API_KEY", "");

  // 深度推理（pro）：问答、复杂检索生成；JXF_AI_CHAT_MODEL 为向后兼容旧名
  const chatModel = readOptional("JXF_AI_MODEL_PRO", readOptional("JXF_AI_CHAT_MODEL", "deepseek-v4-pro"));
  // 高频轻量（flash）：巡读抽取、蒸馏建卡、摘要
  const fastModel = readOptional("JXF_AI_MODEL_FLASH", "deepseek-flash");

  return {
    enabled: readOptional("JXF_AI_ENABLED", "false") === "true" && apiKey !== "",
    baseUrl: readOptional("JXF_AI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey,
    chatModel,
    fastModel,
    timeoutMs: readOptionalInt("JXF_AI_TIMEOUT_MS", 30_000),
    topK: readOptionalInt("JXF_AI_TOP_K", 6),
    maxTokens: readOptionalInt("JXF_AI_MAX_TOKENS", 1024),
    retryAttempts: readOptionalCount("JXF_AI_RETRY_ATTEMPTS", 2),
    retryBaseMs: readOptionalInt("JXF_AI_RETRY_BASE_MS", 500),
    fallback: readAiFallback(chatModel, fastModel),
    embedding: {
      baseUrl: readOptional("JXF_EMBEDDING_BASE_URL", readOptional("JXF_AI_BASE_URL", "https://api.openai.com/v1")).replace(/\/+$/, ""),
      apiKey: embeddingApiKey,
      // 维度必须与 doc_chunks.embedding 的 vector(1024) 一致，改动需迁移并重建 hnsw 索引
      model: readOptional("JXF_EMBEDDING_MODEL", "text-embedding-3-small"),
      dimensions: readOptionalInt("JXF_EMBEDDING_DIM", 1024),
    },
  };
}

/**
 * OCR 默认复用 Gemini embedding 的 Key（同一个 AI Studio 项目），
 * 但允许 JXF_OCR_API_KEY 单独覆盖；默认关闭，避免私有化部署悄悄外发文档。
 */
function readOcrConfig(): OcrEnvConfig {
  const apiKey = readOptional(
    "JXF_OCR_API_KEY",
    readOptional("JXF_EMBEDDING_API_KEY", ""),
  );
  return {
    enabled: readOptional("JXF_OCR_ENABLED", "false") === "true" && apiKey !== "",
    baseUrl: readOptional(
      "JXF_OCR_BASE_URL",
      "https://generativelanguage.googleapis.com/v1beta",
    ).replace(/\/+$/, ""),
    apiKey,
    model: readOptional("JXF_OCR_MODEL", "gemini-3.1-flash-lite"),
    timeoutMs: readOptionalInt("JXF_OCR_TIMEOUT_MS", 90_000),
    maxBytes: readOptionalInt("JXF_OCR_MAX_BYTES", 15_000_000),
  };
}

export function loadEnv(): AppEnv {
  if (cached) {
    return cached;
  }

  const authSecret = readSecret("JXF_AUTH_SECRET");
  const databaseUrl = readUrl("APP_DATABASE_URL", ["postgresql:", "postgres:"]);
  const tenantId = readRequired("JXF_TENANT_ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new Error(`JXF_TENANT_ID 必须是 UUID：${tenantId}`);
  }
  const bucket = readRequired("S3_BUCKET");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error(`S3_BUCKET 不符合对象存储桶命名规则：${bucket}`);
  }

  cached = {
    nodeEnv: process.env.NODE_ENV ?? "development",
    appEnv: process.env.JXF_ENV ?? "production",
    logLevel: readLogLevel(),
    version: process.env.JXF_VERSION ?? "0.1.0",
    authSecret,
    databaseUrl,
    tenantId,
    s3: {
      endpoint: readUrl("S3_ENDPOINT", ["http:", "https:"]).replace(/\/+$/, ""),
      region: process.env.S3_REGION ?? "us-east-1",
      bucket,
      accessKey: readRequired("S3_ACCESS_KEY"),
      secretKey: readRequired("S3_SECRET_KEY"),
    },
    ai: readAiConfig(),
    ocr: readOcrConfig(),
  };

  return cached;
}
