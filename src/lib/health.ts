import { getPool } from "@/lib/db/pool";
import { loadEnv } from "@/lib/env";
import { errorMessage } from "@/lib/logger";

export type CheckStatus = "ok" | "error";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  latency_ms: number;
  detail: string;
}

export interface ReadinessReport {
  status: "ok" | "degraded";
  service: "web";
  version: string;
  app_env: string;
  uptime_s: number;
  timestamp: string;
  checks: CheckResult[];
}

const REQUIRED_EXTENSIONS = ["vector", "pg_bigm", "pg_trgm"] as const;
const STARTED_AT = Date.now();

async function checkDatabase(): Promise<CheckResult> {
  const startedAt = Date.now();
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ extname: string; extversion: string }>(
      "select extname, extversion from pg_extension where extname = any($1::text[])",
      [REQUIRED_EXTENSIONS],
    );
    const installed = new Map(rows.map((row) => [row.extname, row.extversion]));
    const missing = REQUIRED_EXTENSIONS.filter((name) => !installed.has(name));

    if (missing.length > 0) {
      return {
        name: "postgres",
        status: "error",
        latency_ms: Date.now() - startedAt,
        detail: `缺少扩展：${missing.join(", ")}`,
      };
    }

    return {
      name: "postgres",
      status: "ok",
      latency_ms: Date.now() - startedAt,
      detail: REQUIRED_EXTENSIONS.map((name) => `${name}@${installed.get(name)}`).join(" · "),
    };
  } catch (error) {
    return {
      name: "postgres",
      status: "error",
      latency_ms: Date.now() - startedAt,
      detail: errorMessage(error),
    };
  }
}

async function checkObjectStorage(): Promise<CheckResult> {
  const startedAt = Date.now();
  try {
    const { s3 } = loadEnv();
    const response = await fetch(`${s3.endpoint}/minio/health/live`, {
      method: "GET",
      signal: AbortSignal.timeout(2_000),
      cache: "no-store",
    });

    return {
      name: "object-storage",
      status: response.ok ? "ok" : "error",
      latency_ms: Date.now() - startedAt,
      detail: response.ok ? `bucket=${s3.bucket}` : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      name: "object-storage",
      status: "error",
      latency_ms: Date.now() - startedAt,
      detail: errorMessage(error),
    };
  }
}

export async function runReadinessChecks(): Promise<ReadinessReport> {
  const env = loadEnv();
  const checks = await Promise.all([checkDatabase(), checkObjectStorage()]);

  return {
    status: checks.every((check) => check.status === "ok") ? "ok" : "degraded",
    service: "web",
    version: env.version,
    app_env: env.appEnv,
    uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
    timestamp: new Date().toISOString(),
    checks,
  };
}
