#!/usr/bin/env node
/**
 * 迁移容器入口（一次性执行，退出码即结果）。
 *
 * 步骤：
 *   1. 以 jxf_owner 连接（MIGRATION_DATABASE_URL），带重试
 *   2. drizzle migrate：应用 db/migrations（存在 meta/_journal.json 时）
 *   3. 逐文件应用 db/policies/*.sql，每个文件一个事务；策略必须自身幂等
 *   4. fail-closed 校验 pgvector / pg_bigm / pg_trgm 三个扩展
 *
 * 幂等性：重复执行不会产生结构变更（drizzle 记录已应用哈希，policies 全为幂等 SQL）。
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runDrizzleMigrations } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const SERVICE = "migrate";
const REQUIRED_EXTENSIONS = ["vector", "pg_bigm", "pg_trgm"];
const CONNECT_RETRIES = 10;
const CONNECT_RETRY_DELAY_MS = 2_000;

function log(level, msg, fields = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectWithRetry(connectionString) {
  let lastError;

  for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt += 1) {
    const client = new pg.Client({
      connectionString,
      application_name: "jxf-migrate",
      connectionTimeoutMillis: 5_000,
      query_timeout: 120_000,
    });

    try {
      await client.connect();
      log("info", "db_connected", { attempt });
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      log("warn", "db_connect_retry", {
        attempt,
        max_attempts: CONNECT_RETRIES,
        error: errorMessage(error),
      });
      if (attempt < CONNECT_RETRIES) {
        await sleep(CONNECT_RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(`数据库连接失败（已重试 ${CONNECT_RETRIES} 次）：${errorMessage(lastError)}`);
}

async function applyDrizzleMigrations(client, migrationsDir) {
  const journalPath = path.join(migrationsDir, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    log("warn", "drizzle_migrations_skipped", {
      reason: `未找到 ${journalPath}，P0 阶段允许空迁移目录`,
    });
    return 0;
  }

  await runDrizzleMigrations(drizzle(client), {
    migrationsFolder: migrationsDir,
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });

  const { rows } = await client.query(
    'select count(*)::int as applied from drizzle."__drizzle_migrations"',
  );
  return rows[0]?.applied ?? 0;
}

async function applyPolicies(client, policiesDir) {
  if (!existsSync(policiesDir)) {
    log("info", "policies_skipped", { reason: `${policiesDir} 不存在` });
    return 0;
  }

  const files = (await readdir(policiesDir)).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    const sql = await readFile(path.join(policiesDir, file), "utf8");
    if (!sql.trim()) {
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("COMMIT");
      log("info", "policy_applied", { file });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`策略文件执行失败 ${file}：${errorMessage(error)}`);
    }
  }

  return files.length;
}

async function assertExtensions(client) {
  const { rows } = await client.query(
    "select extname, extversion from pg_extension where extname = any($1::text[])",
    [REQUIRED_EXTENSIONS],
  );
  const installed = new Map(rows.map((row) => [row.extname, row.extversion]));
  const missing = REQUIRED_EXTENSIONS.filter((name) => !installed.has(name));

  if (missing.length > 0) {
    throw new Error(`缺少必装扩展：${missing.join(", ")}（应在本镜像 initdb 阶段创建）`);
  }

  return Object.fromEntries(REQUIRED_EXTENSIONS.map((name) => [name, installed.get(name)]));
}

async function main() {
  const startedAt = Date.now();
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) {
    throw new Error("环境变量 MIGRATION_DATABASE_URL 缺失，拒绝执行迁移");
  }

  const migrationsDir = process.env.MIGRATIONS_DIR ?? "/app/db/migrations";
  const policiesDir = process.env.POLICIES_DIR ?? "/app/db/policies";

  const client = await connectWithRetry(connectionString);

  try {
    const appliedMigrations = await applyDrizzleMigrations(client, migrationsDir);
    const appliedPolicies = await applyPolicies(client, policiesDir);
    const extensions = await assertExtensions(client);

    log("info", "migrate_completed", {
      applied_migrations: appliedMigrations,
      applied_policies: appliedPolicies,
      extensions,
      duration_ms: Date.now() - startedAt,
    });
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  log("error", "migrate_failed", { error: errorMessage(error) });
  process.exit(1);
});
