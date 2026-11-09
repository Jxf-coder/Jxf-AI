import { Pool } from "pg";

import { loadEnv } from "@/lib/env";
import { errorMessage, log } from "@/lib/logger";

/**
 * 认证连接池：Auth.js（Drizzle Adapter + 凭证校验）专用，只持有
 * users / accounts / sessions / verification_tokens 的最小 DML 权限。
 *
 * 未配置 AUTH_DATABASE_URL 时回退到业务连接池，保证旧部署升级后仍可登录；
 * 完成 db/ops/auth-role-cutover.sql 的收权后必须配置本变量。
 */
let pool: Pool | null = null;

export function getAuthPool(): Pool {
  if (pool) {
    return pool;
  }

  const env = loadEnv();
  pool = new Pool({
    connectionString: env.authDatabaseUrl,
    application_name: "jxf-auth",
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    query_timeout: 3_000,
  });

  pool.on("error", (error) => {
    log("error", "auth_db_pool_error", { error: errorMessage(error) });
  });

  return pool;
}
