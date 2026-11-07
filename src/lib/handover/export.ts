/**
 * M5 切片 2：交接包导出。
 *
 * 用途：成员离岗或岗位交接时，把「这个人留下了什么」打包成一份可离线归档的 JSON。
 * 边界：
 * - 需要 member:manage（L1 / 部门负责人）且只能在目标任用可见范围内导出；
 * - 资产通过既有适配器汇总，不另建资产清单；
 * - 审计、令牌、工作项都按当前身份 RLS 过滤，导出不会绕过数据权限。
 */

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { listHandoverAssets, type HandoverAsset } from "@/lib/handover/registry";
import { requireContextPermission } from "@/lib/permissions/server";

export interface HandoverBundle {
  format: "jxf.handover";
  formatVersion: 1;
  generatedAt: string;
  generatedBy: string;
  appVersion: string;
  member: {
    membershipId: string;
    userId: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    departmentId: string;
    departmentName: string;
    title: string;
    level: string;
    status: string;
    joinedAt: string;
  };
  assets: HandoverAsset[];
  workItems: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    createdAt: string;
    deliverableExcerpt: string;
  }>;
  mcpTokens: Array<{
    id: string;
    name: string;
    tokenPrefix: string;
    status: "active" | "revoked" | "expired";
    lastUsedAt: string | null;
    createdAt: string;
  }>;
  pendingApprovals: Array<{ id: string; type: string; createdAt: string }>;
  auditTrail: Array<{
    id: number;
    action: string;
    targetType: string | null;
    targetId: string | null;
    createdAt: string;
  }>;
  counts: {
    assets: number;
    workItems: number;
    mcpTokens: number;
    pendingApprovals: number;
    auditTrail: number;
  };
}

export interface HandoverBundleResult {
  bundle: HandoverBundle;
  filename: string;
}

const MAX_WORK_ITEMS = 100;
const MAX_AUDIT_EVENTS = 100;

interface MembershipRow {
  membership_id: string;
  user_id: string;
  department_id: string;
  department_name: string;
  title: string;
  level_text: string;
  status: string;
  joined_at: Date;
  name: string | null;
  email: string | null;
  phone: string | null;
}

function safeSegment(value: string): string {
  return value.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 40) || "member";
}

/**
 * 读取交接包。目标任用不可见时返回 null（不泄露存在性）。
 */
export async function buildHandoverBundle(
  context: UserContext,
  membershipId: string,
): Promise<HandoverBundleResult | null> {
  return withUserContext(context, async (client) => {
    const membershipResult = await client.query<MembershipRow>(
      `select m.id as membership_id, m.user_id, m.department_id,
              d.name as department_name, m.title,
              m.access_level::text as level_text, m.status::text as status, m.created_at as joined_at,
              u.name, u.email, u.phone
         from memberships m
         join departments d on d.id = m.department_id
         join users u on u.id = m.user_id
        where m.id = $1`,
      [membershipId],
    );
    const membership = membershipResult.rows[0];
    if (!membership) {
      return null;
    }

    await requireContextPermission(client, context, "member:manage", {
      kind: "department",
      id: membership.department_id,
      departmentId: membership.department_id,
    });

    // 同一个事务连接不能并发查询（pg 客户端会警告并可能交错），按顺序取数
    const assets = await listHandoverAssets(client, membership.user_id);
    const workItems = await client.query<{
      id: string;
      title: string;
      status: string;
      priority: string;
      created_at: Date;
      deliverable_text: string | null;
    }>(
      `select id, title, status::text as status, priority, created_at,
              deliverable->>'text' as deliverable_text
         from work_items
        where assigned_by = $1
        order by created_at desc
        limit $2`,
      [membership.user_id, MAX_WORK_ITEMS],
    );
    const tokens = await client.query<{
      id: string;
      name: string;
      token_prefix: string;
      last_used_at: Date | null;
      created_at: Date;
      revoked_at: Date | null;
      expires_at: Date | null;
    }>(
      `select id, name, token_prefix, last_used_at, created_at, revoked_at, expires_at
         from mcp_tokens
        where membership_id = $1
        order by created_at desc`,
      [membershipId],
    );
    const approvals = await client.query<{ id: string; type: string; created_at: Date }>(
      `select id, type, created_at
         from approval_requests
        where subject_id = $1 and status = 'pending'
        order by created_at desc`,
      [membershipId],
    );
    const audit = await client.query<{
      id: number;
      action: string;
      target_type: string | null;
      target_id: string | null;
      created_at: Date;
    }>(
      `select id, action, target_type, target_id, created_at
         from audit_events
        where actor_user_id = $1
        order by created_at desc, id desc
        limit $2`,
      [membership.user_id, MAX_AUDIT_EVENTS],
    );

    const tokenStatus = (row: { revoked_at: Date | null; expires_at: Date | null }) => {
      if (row.revoked_at) {
        return "revoked" as const;
      }
      if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
        return "expired" as const;
      }
      return "active" as const;
    };

    const bundle: HandoverBundle = {
      format: "jxf.handover",
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      generatedBy: context.userId,
      appVersion: process.env.JXF_VERSION ?? "0.1.0",
      member: {
        membershipId: membership.membership_id,
        userId: membership.user_id,
        name: membership.name,
        email: membership.email,
        phone: membership.phone,
        departmentId: membership.department_id,
        departmentName: membership.department_name,
        title: membership.title,
        level: membership.level_text,
        status: membership.status,
        joinedAt: membership.joined_at.toISOString(),
      },
      assets,
      workItems: workItems.rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        priority: row.priority,
        createdAt: row.created_at.toISOString(),
        deliverableExcerpt: (row.deliverable_text ?? "").slice(0, 300),
      })),
      mcpTokens: tokens.rows.map((row) => ({
        id: row.id,
        name: row.name,
        tokenPrefix: row.token_prefix,
        status: tokenStatus(row),
        lastUsedAt: row.last_used_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      })),
      pendingApprovals: approvals.rows.map((row) => ({
        id: row.id,
        type: row.type,
        createdAt: row.created_at.toISOString(),
      })),
      auditTrail: audit.rows.map((row) => ({
        id: row.id,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        createdAt: row.created_at.toISOString(),
      })),
      counts: {
        assets: assets.length,
        workItems: workItems.rows.length,
        mcpTokens: tokens.rows.length,
        pendingApprovals: approvals.rows.length,
        auditTrail: audit.rows.length,
      },
    };

    await auditInTx(client, context, {
      actorUserId: context.userId,
      departmentId: membership.department_id,
      action: "handover.exported",
      targetType: "membership",
      targetId: membership.membership_id,
      payload: { counts: bundle.counts },
    });

    const date = bundle.generatedAt.slice(0, 10);
    const filename = `handover-${safeSegment(membership.department_name)}-${safeSegment(
      membership.name ?? membership.user_id.slice(0, 8),
    )}-${date}.json`;

    return { bundle, filename };
  });
}
