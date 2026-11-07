/**
 * M5 切片 2：审计导出。
 *
 * 边界：
 * - 需要 audit:read；数据范围仍由 audit_events 的 RLS 决定（L1 全量 / L2 子树 / L3 本人）；
 * - 导出动作本身写一条 audit.exported，留存「谁在什么时候导出了什么范围」；
 * - 只读，不修改任何审计记录。
 */

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";

export type AuditExportType = "all" | "permission" | "system";

export interface AuditExportFilters {
  type: AuditExportType;
  from?: Date | null;
  to?: Date | null;
  limit?: number;
}

export interface AuditExportRow {
  id: number;
  createdAt: string;
  action: string;
  actorName: string | null;
  actorEmail: string | null;
  departmentName: string | null;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  payload: Record<string, unknown>;
}

const MAX_LIMIT = 50_000;
const DEFAULT_LIMIT = 10_000;

export interface AuditExportResult {
  rows: AuditExportRow[];
  filters: {
    type: AuditExportType;
    from: string | null;
    to: string | null;
    limit: number;
  };
}

export async function exportAuditEvents(
  context: UserContext,
  filters: AuditExportFilters,
): Promise<AuditExportResult> {
  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const type: AuditExportType = ["all", "permission", "system"].includes(filters.type)
    ? filters.type
    : "all";

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "audit:read", {
      kind: "department",
      id: context.activeDepartmentId ?? undefined,
      departmentId: context.activeDepartmentId,
    });

    const { rows } = await client.query<{
      id: number;
      created_at: Date;
      action: string;
      actor_name: string | null;
      actor_email: string | null;
      department_name: string | null;
      target_type: string | null;
      target_id: string | null;
      request_id: string | null;
      payload: Record<string, unknown> | null;
    }>(
      `select a.id, a.created_at, a.action,
              u.name as actor_name, u.email as actor_email,
              d.name as department_name,
              a.target_type, a.target_id, a.request_id, a.payload
         from audit_events a
         left join users u on u.id = a.actor_user_id
         left join departments d on d.id = a.department_id
        where (
          $1::text = 'all'
          or ($1::text = 'permission' and a.action like 'permission.%')
          or ($1::text = 'system' and a.action not like 'permission.%')
        )
          and ($2::timestamptz is null or a.created_at >= $2)
          and ($3::timestamptz is null or a.created_at <= $3)
        order by a.created_at desc, a.id desc
        limit $4`,
      [type, filters.from ?? null, filters.to ?? null, limit],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      departmentId: context.activeDepartmentId,
      action: "audit.exported",
      targetType: "audit_events",
      payload: {
        type,
        from: filters.from?.toISOString() ?? null,
        to: filters.to?.toISOString() ?? null,
        limit,
        exported: rows.length,
      },
    });

    return {
      rows: rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at.toISOString(),
        action: row.action,
        actorName: row.actor_name,
        actorEmail: row.actor_email,
        departmentName: row.department_name,
        targetType: row.target_type,
        targetId: row.target_id,
        requestId: row.request_id,
        payload: row.payload ?? {},
      })),
      filters: {
        type,
        from: filters.from?.toISOString() ?? null,
        to: filters.to?.toISOString() ?? null,
        limit,
      },
    };
  });
}
