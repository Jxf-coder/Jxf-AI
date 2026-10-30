import { drizzle } from "drizzle-orm/node-postgres";

import { getPool } from "./pool";

/** Drizzle 实例（懒加载，避免构建期要求数据库环境变量） */
export function getDb() {
  return drizzle(getPool());
}
