/**
 * M3 队列：领取任务（SKIP LOCKED + 租约）与尝试次数收口。
 *
 * 只允许 worker 连接调用（app_worker）；业务侧不参与领取。
 */

import type { Pool } from "pg";

export interface ClaimedRun {
  id: string;
  tenantId: string;
  departmentId: string;
  principalId: string;
  threadId: string | null;
  aiEmployeeId: string | null;
  kind: string;
  attempts: number;
  lastSeq: number;
  partialText: string;
  input: Record<string, unknown>;
}

const LEASE_SECONDS = 90;
const MAX_ATTEMPTS = 3;

/**
 * 领取一个可执行的 run：
 * - queued，或 running 但租约已过期（原 worker 失联）；
 * - 不自动领取 interrupted：继续执行需要显式恢复，避免重启后立刻重跑；
 * - attempts 已达上限的由 sweepExhausted 收口为 failed。
 */
export async function claimRun(
  pool: Pool,
  workerId: string,
  options: { leaseSeconds?: number } = {},
): Promise<ClaimedRun | null> {
  const leaseSeconds = options.leaseSeconds ?? LEASE_SECONDS;
  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    department_id: string;
    principal_id: string;
    thread_id: string | null;
    ai_employee_id: string | null;
    kind: string;
    attempts: number;
    last_seq: number;
    partial_text: string;
    input: Record<string, unknown>;
  }>(
    `with picked as (
       select id
         from runs
        where (status = 'queued' or (status = 'running' and lease_until < now()))
          and attempts < $3
        order by created_at
        for update skip locked
        limit 1
     )
     update runs r
        set status = 'running',
            worker_id = $1,
            lease_until = now() + ($2 || ' seconds')::interval,
            heartbeat_at = now(),
            attempts = attempts + 1,
            started_at = coalesce(started_at, now())
       from picked p
      where r.id = p.id
     returning r.id, r.tenant_id, r.department_id, r.principal_id, r.thread_id,
               r.ai_employee_id, r.kind, r.attempts, r.last_seq, r.partial_text, r.input`,
    [workerId, String(leaseSeconds), MAX_ATTEMPTS],
  );

  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    departmentId: row.department_id,
    principalId: row.principal_id,
    threadId: row.thread_id,
    aiEmployeeId: row.ai_employee_id,
    kind: row.kind,
    attempts: row.attempts,
    lastSeq: Number(row.last_seq),
    partialText: row.partial_text,
    input: row.input ?? {},
  };
}

/** 续租 + 心跳：worker 执行期间每 30 秒调用一次 */
export async function heartbeatRun(
  pool: Pool,
  runId: string,
  workerId: string,
  leaseSeconds = LEASE_SECONDS,
): Promise<void> {
  await pool.query(
    `update runs
        set lease_until = now() + ($3 || ' seconds')::interval,
            heartbeat_at = now()
      where id = $1 and worker_id = $2 and status = 'running'`,
    [runId, workerId, String(leaseSeconds)],
  );
}

/** 尝试次数耗尽的队列项直接 failed，不再无限重试 */
export async function sweepExhausted(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `update runs
        set status = 'failed',
            finished_at = now(),
            error = coalesce(error, 'max attempts reached')
      where (
              (status in ('queued', 'interrupted') and attempts >= $1)
              or (status = 'running' and lease_until < now() and attempts >= $1)
            )
      returning id`,
    [MAX_ATTEMPTS],
  );
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    // 派活任务重试耗尽：工作项同步为失败，避免停留在排队 / 执行中
    await pool.query(
      `update work_items
          set status = 'failed', updated_at = now()
        where current_run_id = any($1::uuid[])
          and status in ('queued', 'running')`,
      [ids],
    );
  }
  return ids;
}
