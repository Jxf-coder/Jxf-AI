/**
 * 公司共享审批：文档 / 知识卡进入共享区前的申请与审批。
 *
 * 红线：
 * - visibility 只有在 L1 审批通过后才允许变成 shared；申请期间保持 department，
 *   不进入公共检索，也不出现在「公司资料（共享）」；
 * - L1 本人操作视为直接审批通过（根用户，无需再自审）；
 * - 收回共享 / 撤回申请后一律回到 department，残留的申请与审批字段必须清空；
 * - 全部读写走 withUserContext + RLS，写操作先校验本部门 knowledge:write。
 */

import type { PoolClient } from "pg";

import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { auditInTx } from "@/lib/audit";
import { requireContextPermission } from "@/lib/permissions/server";

export type ShareTargetKind = "document" | "card";

export type ShareStatusValue = "none" | "pending_approval" | "approved" | "rejected";

interface TableSpec {
  table: "documents" | "knowledge_cards";
  label: string;
  unsharedAction: string;
  sharedAction: string;
}

const TABLES: Record<ShareTargetKind, TableSpec> = {
  document: {
    table: "documents",
    label: "文档",
    unsharedAction: "knowledge.document_unshared",
    sharedAction: "knowledge.document_shared",
  },
  card: {
    table: "knowledge_cards",
    label: "知识卡",
    unsharedAction: "knowledge.card_unshared",
    sharedAction: "knowledge.card_shared",
  },
};

export interface ShareStateResult {
  /** 当前是否已对公司共享 */
  shared: boolean;
  /** 是否处于待审批 */
  pending: boolean;
  message: string;
}

export interface ShareRequestView {
  kind: ShareTargetKind;
  id: string;
  title: string;
  departmentId: string;
  departmentName: string;
  requesterName: string | null;
  requestedAt: string;
}

interface ShareRow {
  department_id: string;
  visibility: string;
  share_status: ShareStatusValue;
  status?: string;
  deleted_at?: Date | null;
}

/** 只有 L1 可以直接放行；其他人一律走审批 */
function canApproveDirectly(context: UserContext): boolean {
  return context.accessLevel === "L1";
}

async function loadShareRow(
  client: PoolClient,
  kind: ShareTargetKind,
  id: string,
): Promise<ShareRow | null> {
  const extra = kind === "document" ? ", deleted_at" : ", status, null::timestamptz as deleted_at";
  const { rows } = await client.query<ShareRow>(
    `select department_id, visibility, share_status${extra}
       from ${TABLES[kind].table}
      where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

function assertTargetUsable(kind: ShareTargetKind, row: ShareRow): void {
  if (kind === "document" && row.deleted_at) {
    throw new Error("文档在回收站中，不能申请共享");
  }
  if (kind === "card" && row.status === "dropped") {
    throw new Error("知识卡已作废，不能申请共享");
  }
}

/**
 * 开关共享：
 * - 目标打开：L1 直接通过；其他人只提交申请，visibility 保持 department；
 * - 目标关闭：已共享的收回、待审批的撤回，均回到部门隔离。
 */
export async function setShareState(
  context: UserContext,
  kind: ShareTargetKind,
  id: string,
  desired: boolean,
): Promise<ShareStateResult> {
  const spec = TABLES[kind];

  return withUserContext(context, async (client) => {
    const row = await loadShareRow(client, kind, id);
    if (!row) {
      throw new Error(`${spec.label}不存在或无权操作`);
    }
    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: row.department_id,
      departmentId: row.department_id,
    });
    assertTargetUsable(kind, row);

    if (desired) {
      if (row.visibility === "shared" && row.share_status === "approved") {
        return { shared: true, pending: false, message: "已处于公司共享" };
      }
      if (row.share_status === "pending_approval") {
        return { shared: false, pending: true, message: "共享申请已提交，等待 L1 审批" };
      }

      if (canApproveDirectly(context)) {
        await client.query(
          `update ${spec.table}
              set visibility = 'shared',
                  share_status = 'approved',
                  share_requested_by = null,
                  share_requested_at = null,
                  share_reviewed_by = $2,
                  share_reviewed_at = now()
            where id = $1`,
          [id, context.userId],
        );
        await auditInTx(client, context, {
          actorUserId: context.userId,
          action: spec.sharedAction,
          targetType: kind === "document" ? "document" : "knowledge_card",
          targetId: id,
          departmentId: row.department_id,
        });
        return { shared: true, pending: false, message: "已加入公司共享" };
      }

      await client.query(
        `update ${spec.table}
            set share_status = 'pending_approval',
                share_requested_by = $2,
                share_requested_at = now(),
                share_reviewed_by = null,
                share_reviewed_at = null
          where id = $1`,
        [id, context.userId],
      );
      await auditInTx(client, context, {
        actorUserId: context.userId,
        action: "knowledge.share_requested",
        targetType: kind === "document" ? "document" : "knowledge_card",
        targetId: id,
        departmentId: row.department_id,
      });
      return { shared: false, pending: true, message: "已提交公司共享申请，等待 L1 审批" };
    }

    const wasPending = row.share_status === "pending_approval";
    await client.query(
      `update ${spec.table}
          set visibility = 'department',
              share_status = 'none',
              share_requested_by = null,
              share_requested_at = null,
              share_reviewed_by = null,
              share_reviewed_at = null
        where id = $1`,
      [id],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: wasPending ? "knowledge.share_cancelled" : spec.unsharedAction,
      targetType: kind === "document" ? "document" : "knowledge_card",
      targetId: id,
      departmentId: row.department_id,
    });
    return {
      shared: false,
      pending: false,
      message: wasPending ? "已撤回共享申请" : "已收回共享，恢复部门隔离",
    };
  });
}

/** 审批：仅 L1；通过才把 visibility 置为 shared */
export async function reviewShare(
  context: UserContext,
  kind: ShareTargetKind,
  id: string,
  approve: boolean,
): Promise<ShareStateResult> {
  if (context.accessLevel !== "L1") {
    throw new Error("仅 L1 可以审批公司共享申请");
  }
  const spec = TABLES[kind];

  return withUserContext(context, async (client) => {
    const row = await loadShareRow(client, kind, id);
    if (!row) {
      throw new Error(`${spec.label}不存在或无权操作`);
    }
    if (row.share_status !== "pending_approval") {
      throw new Error("该条目没有待审批的共享申请");
    }

    if (approve) {
      await client.query(
        `update ${spec.table}
            set visibility = 'shared',
                share_status = 'approved',
                share_requested_by = null,
                share_requested_at = null,
                share_reviewed_by = $2,
                share_reviewed_at = now()
          where id = $1`,
        [id, context.userId],
      );
    } else {
      await client.query(
        `update ${spec.table}
            set visibility = 'department',
                share_status = 'rejected',
                share_requested_by = null,
                share_requested_at = null,
                share_reviewed_by = $2,
                share_reviewed_at = now()
          where id = $1`,
        [id, context.userId],
      );
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: approve ? "knowledge.share_approved" : "knowledge.share_rejected",
      targetType: kind === "document" ? "document" : "knowledge_card",
      targetId: id,
      departmentId: row.department_id,
    });

    return approve
      ? { shared: true, pending: false, message: "已通过共享审批，全公司可读" }
      : { shared: false, pending: false, message: "已驳回共享申请" };
  });
}

/**
 * 待审批清单：文档 + 知识卡；RLS 决定可见范围（L1 全租户，其余本部门子树）。
 */
export async function listShareRequests(context: UserContext): Promise<ShareRequestView[]> {
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      kind: ShareTargetKind;
      id: string;
      title: string;
      department_id: string;
      department_name: string;
      requester_name: string | null;
      requested_at: Date;
    }>(
      `select 'document'::text as kind, d.id, d.title, d.department_id,
              dep.name as department_name, u.name as requester_name, d.share_requested_at as requested_at
         from documents d
         join departments dep on dep.id = d.department_id
         left join users u on u.id = d.share_requested_by
        where d.share_status = 'pending_approval' and d.deleted_at is null
        union all
       select 'card'::text as kind, c.id, c.title, c.department_id,
              dep.name as department_name, u.name as requester_name, c.share_requested_at as requested_at
         from knowledge_cards c
         join departments dep on dep.id = c.department_id
         left join users u on u.id = c.share_requested_by
        where c.share_status = 'pending_approval' and c.status <> 'dropped'
        order by requested_at nulls last
        limit 50`,
    );

    return rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      title: row.title,
      departmentId: row.department_id,
      departmentName: row.department_name,
      requesterName: row.requester_name,
      requestedAt: row.requested_at.toISOString(),
    }));
  });
}
