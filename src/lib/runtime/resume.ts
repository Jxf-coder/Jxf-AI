/**
 * M3 继续执行：把 interrupted 放回队列。
 *
 * 只有用户显式点「继续」才恢复；worker 重启后不会自动重跑，避免连环失败。
 */

import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";

export async function resumeRun(context: UserContext, runId: string): Promise<boolean> {
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

    if (row.status !== "interrupted") {
      return false;
    }

    await client.query(
      `update runs
          set status = 'queued',
              worker_id = null,
              lease_until = null,
              cancel_requested_at = null,
              finished_at = null
        where id = $1 and status = 'interrupted'`,
      [runId],
    );
    return true;
  });
}
