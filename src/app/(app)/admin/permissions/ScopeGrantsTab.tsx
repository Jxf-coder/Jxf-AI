import { headers } from "next/headers";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { authorizeProtected } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { ResolvedPermissions } from "@/types/permission";

import { ScopeGrantsPanel, type ResourceShareRow, type ScopeGrantRow } from "./ScopeGrantsPanel";

interface ScopeQueryRow {
  id: string;
  grantee_user_id: string;
  grantee_name: string | null;
  domain: string;
  scope_type: string;
  scope_refs: string[];
  capability: string;
  valid_until: Date | null;
  reason: string | null;
}

interface ShareQueryRow {
  id: string;
  resource_id: string;
  account_code: string | null;
  account_name: string | null;
  grantee_user_id: string;
  grantee_name: string | null;
  capability: string;
  valid_until: Date | null;
  reason: string | null;
}

/** 数据范围例外：例外授权（跨人 / 跨部门）与单条资源共享（仅 L1） */
export async function ScopeGrantsTab() {
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
    const canManage =
      actor !== null && authorizeProtected(actor, "protected:permission_grant").allowed;
    if (!canManage) {
      return null;
    }

    const [scopes, shares, members, departments, accounts] = await Promise.all([
      client.query<ScopeQueryRow>(
        `select g.id, g.grantee_user_id, u.name as grantee_name, g.domain, g.scope_type,
                g.scope_refs, g.capability, g.valid_until, g.reason
           from data_scope_grants g
           left join users u on u.id = g.grantee_user_id
          where g.tenant_id = $1
          order by g.created_at desc`,
        [context.tenantId],
      ),
      client.query<ShareQueryRow>(
        `select s.id, s.resource_id, a.code as account_code, a.name as account_name,
                s.grantee_user_id, u.name as grantee_name, s.capability, s.valid_until, s.reason
           from resource_shares s
           left join crm_accounts a on a.id = s.resource_id and s.resource_type = 'crm_account'
           left join users u on u.id = s.grantee_user_id
          where s.tenant_id = $1
          order by s.created_at desc`,
        [context.tenantId],
      ),
      client.query<{ id: string; name: string | null; department_name: string }>(
        `select u.id, u.name, d.name as department_name
           from memberships m
           join users u on u.id = m.user_id
           join departments d on d.id = m.department_id
          where m.tenant_id = $1
            and m.status = 'active'
            and u.status = 'active'
          order by d.name, u.name nulls last`,
        [context.tenantId],
      ),
      client.query<{ id: string; name: string }>(
        "select id, name from departments where tenant_id = $1 order by name",
        [context.tenantId],
      ),
      client.query<{ id: string; code: string; name: string }>(
        `select id, code, name
           from crm_accounts
          where tenant_id = $1 and archived_at is null
          order by updated_at desc
          limit 300`,
        [context.tenantId],
      ),
    ]);

    const userNames = new Map(members.rows.map((row) => [row.id, row.name ?? ""]));
    const departmentNames = new Map(departments.rows.map((row) => [row.id, row.name]));

    return {
      scopes: scopes.rows.map((row) => ({
        id: row.id,
        granteeUserId: row.grantee_user_id,
        granteeName: row.grantee_name?.trim() || userNames.get(row.grantee_user_id) || "未知成员",
        domain: row.domain,
        scopeType: row.scope_type,
        scopeRefs: row.scope_refs ?? [],
        refNames: (row.scope_refs ?? []).map((ref) =>
          row.scope_type === "DEPARTMENTS"
            ? departmentNames.get(ref) ?? "已删除部门"
            : userNames.get(ref) || "已离职成员",
        ),
        capability: row.capability,
        validUntil: row.valid_until ? row.valid_until.toISOString() : null,
        reason: row.reason ?? "",
      })),
      shares: shares.rows.map((row) => ({
        id: row.id,
        resourceId: row.resource_id,
        accountLabel: row.account_code
          ? `${row.account_name ?? "未命名"}（${row.account_code}）`
          : "已删除客户",
        granteeUserId: row.grantee_user_id,
        granteeName: row.grantee_name?.trim() || "未知成员",
        capability: row.capability,
        validUntil: row.valid_until ? row.valid_until.toISOString() : null,
        reason: row.reason ?? "",
      })),
      members: members.rows.map((row) => ({
        id: row.id,
        name: row.name?.trim() || "未命名成员",
        departmentName: row.department_name,
      })),
      departments: departments.rows,
      accounts: accounts.rows,
    };
  });

  if (!data) {
    return <div className="alert-error">仅 L1 老板可以维护数据范围例外。</div>;
  }

  const scopes: ScopeGrantRow[] = data.scopes;
  const shares: ResourceShareRow[] = data.shares;

  return (
    <ScopeGrantsPanel
      scopes={scopes}
      shares={shares}
      members={data.members}
      departments={data.departments}
      accounts={data.accounts}
    />
  );
}
