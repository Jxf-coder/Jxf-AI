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
    // 服务端 15s 主动中止语句，客户端 30s 兜底。知识库入库与证据回归属于秒级到十几秒的
    // 重查询，原 3s 上限会在慢盘上误杀；两层超时可避免单条语句长期占住连接。
    query_timeout: 30_000,
    options: "-c statement_timeout=15000",
  });

  pool.on("error", (error) => {
    log("error", "db_pool_error", { error: errorMessage(error) });
  });

  return pool;
}
