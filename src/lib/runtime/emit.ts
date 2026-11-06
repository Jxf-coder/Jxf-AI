/**
 * M3 事件写入：seq 单调递增 + durable 落库。
 *
 * 红线：
 * - 取序号与写事件必须在同一事务里（update runs set last_seq = last_seq + 1 returning）；
 * - 只有 durable 事件落库（status / step / tool / done / error / cancelled）；
 * - delta 等瞬时内容写 runs.partial_text 快照，不产生事件行；
 * - 事件流只追加：不提供删除 / 更新入口。
 */

import type { PoolClient } from "pg";

export type DurableEventType =
  | "status"
  | "step"
  | "tool"
  | "done"
  | "error"
  | "cancelled"
  | "deposited";

export async function emitEvent(
  client: PoolClient,
  runId: string,
  type: DurableEventType,
  payload: Record<string, unknown> = {},
): Promise<number> {
  const run = await client.query<{ last_seq: number; department_id: string }>(
    `update runs set last_seq = last_seq + 1 where id = $1 returning last_seq, department_id`,
    [runId],
  );
  const row = run.rows[0];
  if (!row) {
    throw new Error("执行不存在，事件无法落库");
  }
  const seq = Number(row.last_seq);
  await client.query(
    `insert into run_events (run_id, seq, department_id, type, payload)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [runId, seq, row.department_id, type, JSON.stringify(payload)],
  );
  return seq;
}

/** 累积文本快照：断线重连先推它，再按 after=seq 补发事件 */
export async function savePartialText(
  client: PoolClient,
  runId: string,
  text: string,
): Promise<void> {
  await client.query(
    `update runs set partial_text = $2, partial_updated_at = now() where id = $1`,
    [runId, text],
  );
}
