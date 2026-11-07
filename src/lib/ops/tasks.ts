/**
 * 运维任务领域层（P5 切片 2）。
 *
 * Web 容器不持有 docker 权限，因此设置页只「落单」：
 *   L1 写入 ops_tasks（queued）→ 宿主机 `npm run ops:runner` 领取并执行 → 回写状态。
 * 任务类型固定为 backup / restore_verify，参数只允许 cold 布尔值，不接受任意命令。
 */

import { auditInTx } from "@/lib/audit";
import { withUserContext, type UserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";
import type { PermissionResource } from "@/types/permission";

import type { OpsTaskKind, OpsTaskStatus, OpsTaskView } from "./types";

export class OpsTaskError extends Error {}

interface OpsTaskRow {
  id: string;
  kind: OpsTaskKind;
  status: OpsTaskStatus;
  params: { cold?: boolean } | null;
  result: Record<string, unknown> | null;
  error: string | null;
  requested_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

function settingsResource(context: UserContext): PermissionResource {
  const departmentId = context.activeDepartmentId;
  return { kind: "department", id: departmentId ?? undefined, departmentId };
}

function toIso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function mapRow(row: OpsTaskRow): OpsTaskView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    cold: row.params?.cold === true,
    result: row.result ?? null,
    error: row.error,
    // requested_at 非空
    requestedAt: new Date(row.requested_at).toISOString(),
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
  };
}

const TASK_COLUMNS = `id, kind, status, params, result, error, requested_at, started_at, finished_at`;

export async function listOpsTasks(context: UserContext, limit = 8): Promise<OpsTaskView[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings", settingsResource(context));
    const { rows } = await client.query<OpsTaskRow>(
      `select ${TASK_COLUMNS}
         from ops_tasks
        order by requested_at desc
        limit $1`,
      [safeLimit],
    );
    return rows.map(mapRow);
  });
}

export interface CreateOpsTaskInput {
  kind: OpsTaskKind;
  /** 仅 backup 有意义：停应用做一致性快照 */
  cold?: boolean;
}

export async function createOpsTask(
  context: UserContext,
  input: CreateOpsTaskInput,
): Promise<OpsTaskView> {
  if (input.kind !== "backup" && input.kind !== "restore_verify") {
    throw new OpsTaskError("不支持的运维任务类型");
  }
  const params = input.kind === "backup" ? { cold: input.cold === true } : {};

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings", settingsResource(context));

    const active = await client.query<{ id: string }>(
      `select id from ops_tasks
        where tenant_id = $1 and kind = $2 and status in ('queued', 'running')
        limit 1`,
      [context.tenantId, input.kind],
    );
    if (active.rows[0]) {
      throw new OpsTaskError("已有同类任务在执行或排队，请等待完成");
    }

    const { rows } = await client.query<OpsTaskRow>(
      `insert into ops_tasks (tenant_id, kind, status, params, requested_by_user_id)
       values ($1, $2, 'queued', $3::jsonb, $4)
       returning ${TASK_COLUMNS}`,
      [context.tenantId, input.kind, JSON.stringify(params), context.userId],
    );
    const task = rows[0];
    if (!task) {
      throw new OpsTaskError("任务创建失败");
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "ops.task_requested",
      targetType: "ops_task",
      targetId: task.id,
      departmentId: context.activeDepartmentId,
      payload: { kind: input.kind, cold: params.cold ?? false },
    });

    return mapRow(task);
  });
}
