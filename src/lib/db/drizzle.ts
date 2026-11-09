import { drizzle } from "drizzle-orm/node-postgres";

import { getAuthPool } from "./auth-pool";

/** Drizzle 实例（懒加载，避免构建期要求数据库环境变量）：仅用于 Auth.js 适配器 */
export function getAuthDb() {
  return drizzle(getAuthPool());
}
