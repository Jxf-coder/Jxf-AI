import { Pool } from "pg";

import { loadEnv } from "@/lib/env";
import { errorMessage, log } from "@/lib/logger";

/**
 * 应用连接池：只能使用受限业务角色（jxf_app），禁止 owner / superuser。
 * P1 起所有业务查询必须通过事务 + SET LOCAL 注入用户身份，见 Master Plan §3.1。
 */
let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) {
    return pool;
  }

  const env = loadEnv();
  pool = new Pool({
    connectionString: env.databaseUrl,
    application_name: "jxf-web",
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    query_timeout: 3_000,
  });

  pool.on("error", (error) => {
    log("error", "db_pool_error", { error: errorMessage(error) });
  });

  return pool;
}
