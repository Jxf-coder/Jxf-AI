import { headers } from "next/headers";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { authorize } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { ResolvedPermissions } from "@/types/permission";

import { ApprovalsClient, type PendingApproval, type DecidedApproval } from "./ApprovalsClient";

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

    if (!canApprove) {
      return { canApprove, pending: [] as PendingApproval[], decided: [] as DecidedApproval[] };
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
            离职交接审批：通过后资产完成转移并停用账号，驳回或撤回则恢复在职。
          </p>
        </div>
      </header>

      {!data.canApprove ? (
        <p className="hint">当前账号没有审批权限，仅 L1 可处理离职交接申请。</p>
      ) : (
        <ApprovalsClient pending={data.pending} decided={data.decided} />
      )}
    </div>
  );
}
