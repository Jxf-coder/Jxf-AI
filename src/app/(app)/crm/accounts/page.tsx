import { headers } from "next/headers";

import { emptyState, pageWrap } from "@/components/knowledge/tokens";
import { requireSession } from "@/lib/auth/session";
import { buildCrmDictionaryOptions } from "@/lib/crm/dictionary";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { resolveContextPermissions } from "@/lib/permissions/server";

import { AccountsClient, type AccountRow, type AssignCandidate, type ClaimRequestView } from "./AccountsClient";

export const dynamic = "force-dynamic";

type PoolView = "mine" | "pool" | "key";

interface DictionaryQueryRow {
  dict_type: string;
  code: string;
  label: string;
}

interface AccountQueryRow {
  id: string;
  code: string;
  name: string;
  company_name: string | null;
  country: string | null;
  region: string | null;
  source: string | null;
  grade: string | null;
  email: string | null;
  contact_status: string;
  pool_status: string;
  icp_score: number | null;
  owner_user_id: string | null;
  protection_until: Date | null;
  released_reason: string | null;
  owner_name: string | null;
  updated_at: Date;
  created_at: Date;
}

const VIEW_FILTER: Record<PoolView, string> = {
  mine: "a.pool_status = 'private'",
  pool: "a.pool_status = 'public'",
  key: "a.pool_status in ('key_pending', 'key')",
};

export default async function CrmAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view: rawView } = await searchParams;
  const view: PoolView = rawView === "pool" || rawView === "key" ? rawView : "mine";

  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  if (!context.accessLevel) {
    return (
      <section className={pageWrap}>
        <div className={emptyState}>当前账号没有有效任用，无法查看客户。</div>
      </section>
    );
  }

  const data = await withUserContext(context, async (client) => {
    const permissions = await resolveContextPermissions(client, context);
    const canAssign =
      (context.accessLevel === "L1" || context.accessLevel === "L2") &&
      permissions.grants.has("crm:assign");

    const [rows, quota, members, claimRequests, dictionaryRows] = await Promise.all([
      client.query<AccountQueryRow>(
        `select a.id, a.code, a.name, a.company_name, a.country, a.region,
                a.source, a.grade, a.email, a.contact_status, a.pool_status, a.icp_score,
                a.owner_user_id, a.protection_until, a.released_reason,
                u.name as owner_name, a.updated_at, a.created_at
           from crm_accounts a
           left join users u on u.id = a.owner_user_id
          where a.archived_at is null
            and ${VIEW_FILTER[view]}
          order by a.updated_at desc
          limit 100`,
      ),
      client.query<{ held: number; cap: number | null }>(
        "select app.crm_held_count($1) as held, app.crm_effective_holder_cap($1) as cap",
        [context.userId],
      ),
      canAssign
        ? client.query<{ id: string; name: string; department_name: string }>(
            `select distinct u.id, u.name, d.name as department_name
               from users u
               join memberships m
                 on m.user_id = u.id
                and m.status = 'active'
                and m.tenant_id = $1
               join departments d on d.id = m.department_id
              where u.status = 'active'
              order by u.name`,
            [context.tenantId],
          )
        : Promise.resolve({ rows: [] as { id: string; name: string; department_name: string }[] }),
      client.query<{
        id: string;
        account_id: string;
        requester_user_id: string;
        requester_name: string | null;
        requester_level: string | null;
        created_at: Date;
      }>(
        `select r.id, r.account_id, r.requester_user_id,
                u.name as requester_name,
                app.effective_access_level(r.requester_user_id) as requester_level,
                r.created_at
           from crm_claim_requests r
           join crm_accounts a on a.id = r.account_id
           left join users u on u.id = r.requester_user_id
          where r.tenant_id = $1
            and r.status = 'pending'
            and a.pool_status = 'public'
            and a.archived_at is null
          order by r.created_at`,
        [context.tenantId],
      ),
      client.query<DictionaryQueryRow>(
        `select dict_type, code, label
           from trade_dictionaries
          where tenant_id = $1 and enabled
          order by dict_type, sort, code`,
        [context.tenantId],
      ),
    ]);

    return {
      canWrite: permissions.grants.has("crm:write"),
      canClaim: permissions.grants.has("crm:claim"),
      canAssign,
      rows: rows.rows,
      held: quota.rows[0]?.held ?? 0,
      cap: quota.rows[0]?.cap ?? null,
      members: members.rows,
      claimRequests: claimRequests.rows,
      dictionaryRows: dictionaryRows.rows,
    };
  });

  const accounts: AccountRow[] = data.rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    companyName: row.company_name ?? "",
    country: row.country ?? "",
    region: row.region ?? "",
    source: row.source ?? "",
    grade: row.grade ?? "",
    email: row.email ?? "",
    contactStatus: row.contact_status,
    poolStatus: row.pool_status,
    icpScore: row.icp_score,
    ownerId: row.owner_user_id,
    ownerName: row.owner_name ?? "未分配",
    releasedReason: row.released_reason ?? "",
    protectionUntil: row.protection_until ? row.protection_until.toISOString() : null,
    updatedAt: row.updated_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  }));

  const members: AssignCandidate[] = data.members.map((member) => ({
    id: member.id,
    name: member.name,
    departmentName: member.department_name,
  }));

  const claimRequests: ClaimRequestView[] = data.claimRequests.map((request) => ({
    id: request.id,
    accountId: request.account_id,
    requesterUserId: request.requester_user_id,
    requesterName: request.requester_name?.trim() || "未命名成员",
    requesterLevel: request.requester_level ?? "L3",
    createdAt: request.created_at.toISOString(),
  }));

  return (
    <AccountsClient
      accounts={accounts}
      view={view}
      canWrite={data.canWrite}
      canClaim={data.canClaim}
      canAssign={data.canAssign}
      myUserId={context.userId}
      myLevel={context.accessLevel}
      isManager={context.accessLevel === "L1" || context.accessLevel === "L2"}
      held={data.held}
      cap={data.cap}
      members={members}
      claimRequests={claimRequests}
      dictOptions={buildCrmDictionaryOptions(data.dictionaryRows)}
    />
  );
}
