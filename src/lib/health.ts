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

export interface AppVersionInfo {
  version: string;
  gitSha: string | null;
  appliedAt: string;
}

export interface ReadinessReport {
  status: "ok" | "degraded";
  service: "web";
  version: string;
  /** 数据库版本表记录的应用版本（迁移容器写入） */
  db_version: AppVersionInfo | null;
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

async function checkSchemaVersion(): Promise<{
  check: CheckResult;
  info: AppVersionInfo | null;
}> {
  const startedAt = Date.now();
  try {
    const { rows } = await getPool().query<{
      value: { version?: string; git_sha?: string | null; applied_at?: string } | null;
    }>("select app.current_app_version() as value");
    const value = rows[0]?.value;

    if (!value?.version) {
      return {
        check: {
          name: "schema",
          status: "error",
          latency_ms: Date.now() - startedAt,
          detail: "版本表为空：请执行 migrate 容器",
        },
        info: null,
      };
    }

    const info: AppVersionInfo = {
      version: value.version,
      gitSha: value.git_sha ?? null,
      appliedAt: value.applied_at ?? "",
    };
    return {
      check: {
        name: "schema",
        status: "ok",
        latency_ms: Date.now() - startedAt,
        detail: `v${info.version}${info.gitSha ? ` · ${info.gitSha.slice(0, 8)}` : ""} · ${info.appliedAt}`,
      },
      info,
    };
  } catch (error) {
    return {
      check: {
        name: "schema",
        status: "error",
        latency_ms: Date.now() - startedAt,
        detail: errorMessage(error),
      },
      info: null,
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
  const [database, storage, schema] = await Promise.all([
    checkDatabase(),
    checkObjectStorage(),
    checkSchemaVersion(),
  ]);
  const checks = [database, storage, schema.check];

  return {
    status: checks.every((check) => check.status === "ok") ? "ok" : "degraded",
    service: "web",
    version: env.version,
    db_version: schema.info,
    app_env: env.appEnv,
    uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
    timestamp: new Date().toISOString(),
    checks,
  };
}
