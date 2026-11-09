/**
 * 经验队列的 worker 侧操作：领取 / 心跳 / 重试 / 死信 / 崩溃恢复。
 *
 * 与 M3 运行时（src/lib/runtime/claim.ts）保持同一形状：
 *   - SKIP LOCKED + 租约 90s + 30s 心跳；
 *   - 崩溃（租约过期）只回队列、不计失败次数；
 *   - 失败 3 次进 dead，可在待确认工作台手动重试。
 *
 * 只允许 worker 连接（app_worker）调用；业务侧不参与领取。
 */

import type { Pool } from "pg";

const LEASE_SECONDS = 90;
const MAX_ATTEMPTS = 3;

export interface ClaimedExperienceJob {
  id: string;
  tenantId: string;
  departmentId: string;
  channel: string;
  sourceType: string;
  sourceId: string;
  sourceVersion: string;
  fingerprint: string | null;
  attempts: number;
  sourceText: string;
  sourceMeta: Record<string, unknown>;
  cooldownBucket: string;
}

export async function claimExperienceJob(
  pool: Pool,
  workerId: string,
  options: { leaseSeconds?: number } = {},
): Promise<ClaimedExperienceJob | null> {
  const leaseSeconds = options.leaseSeconds ?? LEASE_SECONDS;
  const { rows } = await pool.query<{
    id: string;
    tenant_id: string;
    department_id: string;
    channel: string;
    source_type: string;
    source_id: string;
    source_version: string;
    fingerprint: string | null;
    attempts: number;
    source_text: string | null;
    source_meta: Record<string, unknown> | null;
    cooldown_bucket: string;
  }>(
    `with picked as (
       select id
         from experience_jobs
        where (
                (status = 'queued' and (not_before is null or not_before <= now()))
                or (status = 'running' and lease_until < now())
              )
          and attempts < $3
        order by created_at
        for update skip locked
        limit 1
     )
     update experience_jobs j
        set status = 'running',
            worker_id = $1,
            lease_until = now() + ($2 || ' seconds')::interval,
            heartbeat_at = now(),
            attempts = attempts + 1,
            started_at = coalesce(started_at, now())
       from picked p
      where j.id = p.id
     returning j.id, j.tenant_id, j.department_id, j.channel, j.source_type,
               j.source_id, j.source_version, j.fingerprint, j.attempts,
               j.source_text, j.source_meta, j.cooldown_bucket`,
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
    channel: row.channel,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    fingerprint: row.fingerprint,
    attempts: row.attempts,
    sourceText: row.source_text ?? "",
    sourceMeta: row.source_meta ?? {},
    cooldownBucket: row.cooldown_bucket,
  };
}

/** 执行期间每 30 秒续租 */
export async function heartbeatExperienceJob(
  pool: Pool,
  jobId: string,
  workerId: string,
  leaseSeconds = LEASE_SECONDS,
): Promise<void> {
  await pool.query(
    `update experience_jobs
        set lease_until = now() + ($3 || ' seconds')::interval,
            heartbeat_at = now()
      where id = $1 and worker_id = $2 and status = 'running'`,
    [jobId, workerId, String(leaseSeconds)],
  );
}

/**
 * 崩溃恢复：租约过期的 running 回 queued。
 * attempts 回退 1（领取时 +1），避免把崩溃算成一次失败。
 */
export async function sweepExperienceJobs(
  pool: Pool,
): Promise<{ requeued: number; dead: number }> {
  const requeued = await pool.query(
    `update experience_jobs
        set status = 'queued',
            worker_id = null,
            lease_until = null,
            attempts = greatest(attempts - 1, 0)
      where status = 'running' and lease_until < now()`,
  );
  const dead = await pool.query(
    `update experience_jobs
        set status = 'dead',
            finished_at = now(),
            error = coalesce(error, 'max attempts reached')
      where status = 'queued' and attempts >= $1`,
    [MAX_ATTEMPTS],
  );
  return { requeued: requeued.rowCount ?? 0, dead: dead.rowCount ?? 0 };
}

/** 限额命中：把 job 放回队列并推迟到下一次窗口，不计失败 */
export async function deferExperienceJob(
  pool: Pool,
  jobId: string,
  reason: string,
  notBefore: "next_hour" | "next_day",
): Promise<void> {
  const offset = notBefore === "next_hour" ? "1 hour" : "1 day";
  await pool.query(
    `update experience_jobs
        set status = 'queued',
            not_before = date_trunc($2, now()) + ($3)::interval,
            attempts = greatest(attempts - 1, 0),
            worker_id = null,
            lease_until = null,
            error = $4
      where id = $1`,
    [jobId, notBefore === "next_hour" ? "hour" : "day", offset, reason.slice(0, 500)],
  );
}

/** 正常收口（done / skipped）：写结果卡与成本摘要 */
export async function completeExperienceJob(
  pool: Pool,
  jobId: string,
  status: "done" | "skipped",
  input: {
    cardIds: string[];
    meta?: Record<string, unknown>;
    reason?: string;
  } = { cardIds: [] },
): Promise<void> {
  await pool.query(
    `update experience_jobs
        set status = $2,
            result_card_ids = $3::uuid[],
            finished_at = now(),
            worker_id = null,
            lease_until = null,
            error = null,
            source_meta = source_meta || $4::jsonb
      where id = $1`,
    [
      jobId,
      status,
      input.cardIds,
      JSON.stringify({
        ...(input.meta ?? {}),
        skip_reason: input.reason ?? null,
      }),
    ],
  );
}

/** 执行失败：按尝试次数指数退避，3 次后进 dead */
export async function failExperienceJob(
  pool: Pool,
  job: ClaimedExperienceJob,
  error: string,
): Promise<"queued" | "dead"> {
  if (job.attempts >= MAX_ATTEMPTS) {
    await pool.query(
      `update experience_jobs
          set status = 'dead',
              error = $2,
              finished_at = now(),
              worker_id = null,
              lease_until = null
        where id = $1`,
      [job.id, error.slice(0, 2000)],
    );
    return "dead";
  }

  const backoffMinutes = 2 ** job.attempts;
  await pool.query(
    `update experience_jobs
        set status = 'queued',
            error = $2,
            not_before = now() + make_interval(mins => $3),
            worker_id = null,
            lease_until = null
      where id = $1`,
    [job.id, error.slice(0, 2000), backoffMinutes],
  );
  return "queued";
}
