import { headers } from "next/headers";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { authorize } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { ResolvedPermissions } from "@/types/permission";

import { ApprovalsClient, type PendingApproval, type DecidedApproval } from "./ApprovalsClient";
import { ClaimApprovals, type ClaimApprovalItem } from "./ClaimApprovals";

export const dynamic = "force-dynamic";

interface ApprovalRow {
  id: string;
  status: string;
  created_at: Date;
  decided_at: Date | null;
  membership_id: string;
  department_id: string;
  access_level: "L1" | "L2" | "L3";
  title: string;
  member_name: string | null;
  phone: string | null;
  department_name: string;
  requester_name: string | null;
  asset_count: number;
}

interface HandoverRow {
  approval_id: string;
  asset_type: string;
  asset_id: string;
  asset_label: string;
  to_name: string | null;
}

interface ClaimQueryRow {
  id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  department_name: string | null;
  requester_name: string | null;
  requester_level: string | null;
  created_at: Date;
}

const TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatTime(value: Date | null): string {
  return value ? TIME_FORMATTER.format(value) : "—";
}

const APPROVAL_SELECT = `
  select ar.id, ar.status, ar.created_at, ar.decided_at,
         m.id as membership_id, m.department_id, m.access_level, m.title,
         u.name as member_name, u.phone,
         d.name as department_name,
         ru.name as requester_name,
         (select count(*)::int from handover_items hi where hi.approval_id = ar.id) as asset_count
    from approval_requests ar
    join memberships m on m.id = ar.subject_id
    join users u on u.id = m.user_id
    join departments d on d.id = m.department_id
    join users ru on ru.id = ar.requester_id
   where ar.type = 'membership_removal'
`;

export default async function ApprovalsPage() {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const data = await withUserContext(context, async (client) => {
    let actor: ResolvedPermissions | null = null;
    try {
      actor = await resolveContextPermissions(client, context);
    } catch {
      actor = null;
    }

    const canApprove = actor
      ? authorize(actor, "member:manage", {
          kind: "department",
          id: context.activeDepartmentId ?? undefined,
          departmentId: context.activeDepartmentId,
        }).allowed
      : false;

    const claimRows = await client.query<ClaimQueryRow>(
      `select r.id, r.account_id, a.code as account_code, a.name as account_name,
              d.name as department_name, u.name as requester_name,
              app.effective_access_level(r.requester_user_id) as requester_level,
              r.created_at
         from crm_claim_requests r
         join crm_accounts a
           on a.id = r.account_id
          and a.pool_status = 'public'
          and a.archived_at is null
         left join users u on u.id = r.requester_user_id
         left join departments d on d.id = r.department_id
        where r.tenant_id = $1
          and r.status = 'pending'
          and r.requester_user_id <> app.current_user_id()
          and (
            app.current_access_level() = 'L1'
            or (app.current_access_level() = 'L2'
                and app.can_write(r.department_id)
                and app.effective_access_level(r.requester_user_id) = 'L3')
          )
        order by r.created_at`,
      [context.tenantId],
    );

    const claims: ClaimApprovalItem[] = claimRows.rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountLabel: `${row.account_name}（${row.account_code}）`,
      departmentName: row.department_name ?? "未知部门",
      requesterName: row.requester_name?.trim() || "未命名成员",
      requesterLevel: row.requester_level ?? "L3",
      submittedAt: formatTime(row.created_at),
    }));

    if (!canApprove) {
      return {
        canApprove,
        claims,
        pending: [] as PendingApproval[],
        decided: [] as DecidedApproval[],
      };
    }

    const pendingRows = await client.query<ApprovalRow>(
      `${APPROVAL_SELECT} and ar.status = 'pending' order by ar.created_at asc`,
    );
    const decidedRows = await client.query<ApprovalRow>(
      `${APPROVAL_SELECT} and ar.status <> 'pending' order by ar.decided_at desc nulls last limit 20`,
    );

    const approvalIds = [...pendingRows.rows, ...decidedRows.rows].map((row) => row.id);
    const itemResult =
      approvalIds.length > 0
        ? await client.query<HandoverRow>(
            `select hi.approval_id, hi.asset_type, hi.asset_id,
                    coalesce(hi.asset_id, '') as asset_label,
                    tu.name as to_name
               from handover_items hi
               left join users tu on tu.id = hi.to_user_id
              where hi.approval_id = any($1::uuid[])
              order by hi.asset_type, hi.asset_id`,
            [approvalIds],
          )
        : { rows: [] as HandoverRow[] };

    const itemsByApproval = new Map<string, HandoverRow[]>();
    for (const item of itemResult.rows) {
      const bucket = itemsByApproval.get(item.approval_id) ?? [];
      bucket.push(item);
      itemsByApproval.set(item.approval_id, bucket);
    }

    const toPending = (row: ApprovalRow): PendingApproval => ({
      id: row.id,
      membershipId: row.membership_id,
      memberName: row.member_name ?? row.phone ?? "未命名成员",
      departmentName: row.department_name ?? "未知部门",
      title: row.title ?? "—",
      level: row.access_level ?? "L3",
      requesterName: row.requester_name ?? "系统",
      submittedAt: formatTime(row.created_at),
      assetCount: row.asset_count ?? 0,
      items: (itemsByApproval.get(row.id) ?? []).map((item) => ({
        assetType: item.asset_type ?? "资产",
        assetId: item.asset_id,
        toName: item.to_name ?? "未知接收人",
      })),
    });

    const toDecided = (row: ApprovalRow): DecidedApproval => ({
      id: row.id,
      memberName: row.member_name ?? row.phone ?? "未命名成员",
      departmentName: row.department_name,
      status: row.status,
      decidedAt: row.decided_at ? formatTime(row.decided_at) : null,
      assetCount: row.asset_count,
    });

    return {
      canApprove,
      claims,
      pending: pendingRows.rows.map(toPending),
      decided: decidedRows.rows.map(toDecided),
    };
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">审批中心</h1>
          <p className="page-subtitle">
            客户领用申请与离职交接审批统一在这里处理；处理结果立即生效，其他审批人的列表同步消失。
          </p>
        </div>
      </header>

      {/* 常驻挂载：处理完最后一条后列表会清空，成功提示仍需展示 */}
      <ClaimApprovals requests={data.claims} />

      {!data.canApprove ? (
        data.claims.length === 0 ? <p className="hint">当前账号没有待处理的审批。</p> : null
      ) : (
        <ApprovalsClient pending={data.pending} decided={data.decided} />
      )}
    </div>
  );
}
