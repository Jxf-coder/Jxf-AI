import { headers } from "next/headers";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { authorizeProtected } from "@/lib/permissions/authorize";
import {
  LEVEL_CEILING,
  enabledPermissionModules,
  getPermissionNode,
  isPermissionKey,
  permissionKeysForModule,
} from "@/lib/permissions/catalog";
import { isPermissionScope } from "@/lib/permissions/scope";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type {
  AdminAuditEvent,
  AdminGrantMap,
  AdminMember,
  AdminModule,
  AdminTemplate,
} from "@/types/permission-admin";
import type { PermissionScope, ResolvedPermissions } from "@/types/permission";
import type { AccessLevel } from "@/types/profile";

import { PermissionAdminClient } from "./PermissionAdminClient";

export const dynamic = "force-dynamic";

interface TemplateRow {
  id: string;
  name: string;
  level: AccessLevel;
  is_system: boolean;
}

interface GrantRow {
  template_id?: string;
  user_id?: string;
  permission_key: string;
  scope_type: string;
  effect: string;
}

interface MemberRow {
  user_id: string;
  membership_id: string;
  department_id: string;
  department_name: string;
  level: AccessLevel;
  name: string | null;
  phone: string | null;
}

interface AuditRow {
  id: number;
  action: string;
  payload: Record<string, unknown> | null;
  occurred_at: string;
  actor_name: string | null;
}

function buildModules(): AdminModule[] {
  return enabledPermissionModules().map((module) => ({
    key: module.key,
    nameZh: module.nameZh,
    description: module.description,
    nodes: permissionKeysForModule(module.key).map((key) => {
      const node = getPermissionNode(key);
      return {
        key,
        nameZh: node.nameZh,
        description: node.description,
        action: node.action,
        risk: node.risk,
        allowedScopes: [...node.allowedScopes],
        defaultEnabled: node.defaultEnabled,
        grantable: node.grantable,
        requiresApproval: node.requiresApproval,
      };
    }),
  }));
}

function toGrantMap(rows: GrantRow[]): AdminGrantMap {
  const map: AdminGrantMap = {};
  for (const row of rows) {
    if (!isPermissionKey(row.permission_key) || !isPermissionScope(row.scope_type)) {
      continue;
    }
    map[row.permission_key] = {
      scope: row.scope_type as PermissionScope,
      effect: row.effect === "deny" ? "deny" : "allow",
    };
  }
  return map;
}

export default async function PermissionSettingsPage() {
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
    if (!canManage || !actor) {
      return { canManage, templates: [], members: [], auditEvents: [] };
    }

    const templateRows = await client.query<TemplateRow>(
      "select id, name, level, is_system from role_templates order by sort_order, id",
    );
    const templateGrants = await client.query<GrantRow>(
      `select template_id, permission_key, scope_type, effect
         from role_template_grants`,
    );
    const memberRows = await client.query<MemberRow>(
      `select m.user_id, m.id as membership_id, m.department_id,
              d.name as department_name, m.access_level as level,
              u.name, u.phone
         from memberships m
         join departments d on d.id = m.department_id
         join users u on u.id = m.user_id
        where m.status = 'active'
          and m.tenant_id = $1
        order by m.access_level, u.name nulls last, m.created_at`,
      [context.tenantId],
    );
    const userGrants = await client.query<GrantRow>(
      `select user_id, permission_key, scope_type, effect
         from user_permission_grants
        where tenant_id = $1`,
      [context.tenantId],
    );
    const auditRows = await client.query<AuditRow>(
      `select a.id, a.action, a.payload,
              to_char(a.created_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') as occurred_at,
              u.name as actor_name
         from audit_events a
         left join users u on u.id = a.actor_user_id
        where a.action like 'permission.%'
        order by a.id desc
        limit 50`,
    );

    const templates: AdminTemplate[] = templateRows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      level: row.level,
      isSystem: row.is_system,
      grants: toGrantMap(templateGrants.rows.filter((grant) => grant.template_id === row.id)),
    }));

    const grantsByUser = new Map<string, GrantRow[]>();
    for (const grant of userGrants.rows) {
      if (!grant.user_id) {
        continue;
      }
      const bucket = grantsByUser.get(grant.user_id);
      if (bucket) {
        bucket.push(grant);
      } else {
        grantsByUser.set(grant.user_id, [grant]);
      }
    }

    const members: AdminMember[] = memberRows.rows.map((row) => ({
      userId: row.user_id,
      name: row.name ?? "",
      phone: row.phone,
      departmentId: row.department_id,
      departmentName: row.department_name,
      membershipId: row.membership_id,
      level: row.level,
      grants: toGrantMap(grantsByUser.get(row.user_id) ?? []),
    }));

    const auditEvents: AdminAuditEvent[] = auditRows.rows.map((row) => {
      const payload = row.payload ?? {};
      const targetName =
        typeof payload.targetName === "string"
          ? payload.targetName
          : typeof payload.templateName === "string"
            ? payload.templateName
            : null;
      return {
        id: row.id,
        action: row.action,
        targetName,
        actorName: row.actor_name,
        occurredAt: row.occurred_at,
        payload,
      };
    });

    return { canManage, templates, members, auditEvents };
  });

  return (
    <section>
      <header className="section-header">
        <div>
          <h1 className="section-title">权限管理</h1>
          <p className="section-subtitle">
            角色模板、成员授权与变更记录 · 仅 L1 可编辑 · 保存后下一次请求生效
          </p>
        </div>
        <span className={`badge ${data.canManage ? "badge-accent" : "badge-error"}`}>
          {data.canManage ? "L1" : "NO ACCESS"}
        </span>
      </header>

      {!data.canManage ? (
        <div className="alert-error">仅 L1 老板可以管理权限。</div>
      ) : (
        <PermissionAdminClient
          modules={buildModules()}
          templates={data.templates}
          members={data.members}
          auditEvents={data.auditEvents}
          currentUserId={session.userId}
          ceilings={{
            L1: [...LEVEL_CEILING.L1],
            L2: [...LEVEL_CEILING.L2],
            L3: [...LEVEL_CEILING.L3],
          }}
        />
      )}
    </section>
  );
}
