/**
 * 结构化日志：单行 JSON 输出到 stdout / stderr。
 * 私有化现场排障统一按 request_id / run_id 检索，禁止输出明文密钥。
 */

import type { LogLevel } from "./env";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const VALID_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function threshold(): number {
  const raw = (process.env.JXF_LOG_LEVEL ?? "info").toLowerCase();
  return LEVEL_WEIGHT[VALID_LEVELS.includes(raw as LogLevel) ? (raw as LogLevel) : "info"];
}

export type LogFields = Record<string, unknown>;

export function log(level: LogLevel, msg: string, fields: LogFields = {}): void {
  if (LEVEL_WEIGHT[level] < threshold()) {
    return;
  }

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: "web",
    msg,
    ...fields,
  });

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
