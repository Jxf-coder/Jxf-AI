import type { PoolClient } from "pg";

import { getPool } from "@/lib/db/pool";
import { loadEnv } from "@/lib/env";

export type AccessLevel = "L1" | "L2" | "L3";

export interface UserContext {
  userId: string;
  tenantId: string;
  departmentIds: string[];
  accessLevel: AccessLevel | null;
  requestId?: string;
}

interface RawContextRow {
  department_ids: string[] | null;
  access_level: string | null;
}

/** 请求入口解析一次身份：有效任用 → department_ids + 最高等级 */
export async function resolveUserContext(userId: string, requestId?: string): Promise<UserContext> {
  const env = loadEnv();
  const client = await getPool().connect();

  try {
    const { rows } = await client.query<RawContextRow>(
      "select app.user_department_ids($1) as department_ids, app.effective_access_level($1) as access_level",
      [userId],
    );
    const row = rows[0];

    return {
      userId,
      tenantId: env.tenantId,
      departmentIds: row?.department_ids ?? [],
      accessLevel: (row?.access_level as AccessLevel | null) ?? null,
      requestId,
    };
  } finally {
    client.release();
  }
}

function toPgUuidArray(ids: string[]): string {
  return `{${ids.join(",")}}`;
}

/**
 * 每个请求一个事务，事务内注入 SET LOCAL 上下文。
 * 未登录 / 无有效任用时 access_level 为空、department_ids 为空 → 所有策略不命中（fail-closed）。
 */
export async function withUserContext<T>(
  context: UserContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query("begin");
    await client.query(
      `select
         set_config('app.user_id', $1, true),
         set_config('app.tenant_id', $2, true),
         set_config('app.access_level', $3, true),
         set_config('app.department_ids', $4, true)`,
      [
        context.userId,
        context.tenantId,
        context.accessLevel ?? "",
        toPgUuidArray(context.departmentIds),
      ],
    );

    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
