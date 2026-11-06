/**
 * M3 取消：用户显式中止。
 *
 * 语义：SSE / 轮询断开 ≠ 取消；只有这里写入 cancel_requested_at 才算取消，
 * worker 在 step 边界检查并写 cancelled 事件后结束。
 */

import type { Pool } from "pg";

import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";

export async function requestCancel(context: UserContext, runId: string): Promise<boolean> {
  return withUserContext(context, async (client) => {
    const run = await client.query<{ department_id: string; status: string }>(
      `select department_id, status from runs where id = $1`,
      [runId],
    );
    const row = run.rows[0];
    if (!row) {
      throw new Error("执行不存在或无权操作");
    }
    await requireContextPermission(client, context, "skill:use", {
      kind: "department",
      id: row.department_id,
      departmentId: row.department_id,
    });

    if (!["queued", "running", "interrupted"].includes(row.status)) {
      return false;
    }

    await client.query(
      `update runs set cancel_requested_at = now() where id = $1 and cancel_requested_at is null`,
      [runId],
    );
    return true;
  });
}

export async function isCancelRequested(pool: Pool, runId: string): Promise<boolean> {
  const { rows } = await pool.query<{ cancel_requested_at: Date | null }>(
    `select cancel_requested_at from runs where id = $1`,
    [runId],
  );
  return Boolean(rows[0]?.cancel_requested_at);
}
