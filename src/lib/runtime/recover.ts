/**
 * M3 收口：进程重启 / 心跳超时。
 *
 * interrupted 与 failed 必须分开：前者是「被打断、可继续」，后者需要人介入。
 */

import type { Pool } from "pg";

async function closeStale(
  pool: Pool,
  reason: string,
  where: string,
  params: unknown[],
): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `select id from runs where ${where}`,
    params,
  );
  const closed: string[] = [];

  for (const row of rows) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const updated = await client.query(
        `update runs
            set status = 'interrupted',
                finished_at = now(),
                lease_until = null,
                error = coalesce(error, $2)
          where id = $1 and status = 'running'`,
        [row.id, reason],
      );
      if ((updated.rowCount ?? 0) > 0) {
        const seqRow = (
          await client.query<{ last_seq: number; department_id: string }>(
            `update runs set last_seq = last_seq + 1 where id = $1 returning last_seq, department_id`,
            [row.id],
          )
        ).rows[0];
        await client.query(
          `insert into run_events (run_id, seq, department_id, type, payload)
           values ($1, $2, $3, 'status', $4::jsonb)`,
          [row.id, Number(seqRow.last_seq), seqRow.department_id, JSON.stringify({ status: "interrupted", reason })],
        );
        closed.push(row.id);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return closed;
}

/** 启动时：不属于本进程的 running 一律收口（worker 重启后原任务不会假装还在跑） */
export async function markInterruptedForOthers(
  pool: Pool,
  workerId: string,
): Promise<string[]> {
  return closeStale(
    pool,
    "worker restarted",
    `status = 'running' and (worker_id is distinct from $1)`,
    [workerId],
  );
}

/** 心跳巡检：60 秒未心跳视为失联 */
export async function sweepStaleHeartbeat(pool: Pool, seconds = 60): Promise<string[]> {
  return closeStale(
    pool,
    "heartbeat timeout",
    `status = 'running'
       and lease_until is not null
       and heartbeat_at < now() - ($1 || ' seconds')::interval`,
    [String(seconds)],
  );
}
