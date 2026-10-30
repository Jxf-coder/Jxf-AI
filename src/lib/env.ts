/**
 * 启动期环境变量校验（fail-closed）。
 *
 * 红线：JXF_AUTH_SECRET 缺失 / 过短 / 弱值时必须拒绝启动，不允许降级放行。
 * 该模块在 instrumentation.register() 中首次调用，健康检查与 DB 连接复用缓存结果。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppEnv {
  nodeEnv: string;
  appEnv: string;
  logLevel: LogLevel;
  version: string;
  authSecret: string;
  databaseUrl: string;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
  };
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

export function loadEnv(): AppEnv {
  if (cached) {
    return cached;
  }

  const authSecret = readSecret("JXF_AUTH_SECRET");
  const databaseUrl = readUrl("APP_DATABASE_URL", ["postgresql:", "postgres:"]);
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
    s3: {
      endpoint: readUrl("S3_ENDPOINT", ["http:", "https:"]).replace(/\/+$/, ""),
      region: process.env.S3_REGION ?? "us-east-1",
      bucket,
      accessKey: readRequired("S3_ACCESS_KEY"),
      secretKey: readRequired("S3_SECRET_KEY"),
    },
  };

  return cached;
}
