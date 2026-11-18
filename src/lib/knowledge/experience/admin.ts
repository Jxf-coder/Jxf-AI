/**
 * 经验队列的运营入口（失败重试面板）。
 *
 * 与 worker 侧 queue.ts 分开：这里只做 L1/L2 可见范围内的读取与「重新入队」，
 * 不参与领取、心跳与租约，避免业务侧拿到 worker 的连接角色。
 */

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";

export interface ExperienceJobFailure {
  id: string;
  departmentId: string;
  departmentName: string;
  channel: string;
  sourceType: string;
  attempts: number;
  status: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** 列出当前可读范围内进入 dead / failed 的经验任务（默认 50 条） */
export async function listExperienceFailures(
  context: UserContext,
  limit = 50,
): Promise<ExperienceJobFailure[]> {
  const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      department_id: string;
      department_name: string;
      channel: string;
      source_type: string;
      attempts: number;
      status: string;
      error: string | null;
      created_at: Date;
      finished_at: Date | null;
    }>(
      `select j.id, j.department_id, d.name as department_name, j.channel, j.source_type,
              j.attempts, j.status, j.error, j.created_at, j.finished_at
         from experience_jobs j
         join departments d on d.id = j.department_id
        where j.status in ('dead', 'failed')
        order by j.finished_at desc nulls last, j.created_at desc
        limit $1`,
      [safeLimit],
    );
    return rows.map((row) => ({
      id: row.id,
      departmentId: row.department_id,
      departmentName: row.department_name,
      channel: row.channel,
      sourceType: row.source_type,
      attempts: row.attempts,
      status: row.status,
      error: row.error,
      createdAt: row.created_at.toISOString(),
      finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    }));
  });
}

/** 把 dead / failed 任务重新放回队列：清空尝试次数与错误，由 worker 下一轮领取 */
export async function retryExperienceJob(
  context: UserContext,
  jobId: string,
): Promise<void> {
  return withUserContext(context, async (client) => {
    const job = await client.query<{ department_id: string }>(
      `select department_id from experience_jobs
        where id = $1 and status in ('dead', 'failed')`,
      [jobId],
    );
    const target = job.rows[0];
    if (!target) {
      throw new Error("任务不存在、已被处理或不在当前可写范围");
    }
    await requireContextPermission(client, context, "knowledge:write", {
      kind: "experience_job",
      id: jobId,
      departmentId: target.department_id,
    });

    const { rowCount } = await client.query(
      `update experience_jobs
          set status = 'queued',
              attempts = 0,
              error = null,
              not_before = null,
              worker_id = null,
              lease_until = null,
              heartbeat_at = null,
              finished_at = null
        where id = $1 and status in ('dead', 'failed')`,
      [jobId],
    );
    if ((rowCount ?? 0) === 0) {
      throw new Error("任务不存在、已被处理或不在当前可写范围");
    }
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.experience_job_retried",
      targetType: "experience_job",
      targetId: jobId,
      departmentId: context.activeDepartmentId,
      payload: {},
    });
  });
}
