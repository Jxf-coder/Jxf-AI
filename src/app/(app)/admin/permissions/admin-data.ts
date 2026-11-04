import type { PoolClient } from "pg";

import {
  enabledPermissionModules,
  getPermissionNode,
  isPermissionKey,
  permissionKeysForModule,
} from "@/lib/permissions/catalog";
import { isPermissionScope } from "@/lib/permissions/scope";
import type {
  AdminGrantMap,
  AdminMember,
  AdminModule,
  AdminTemplate,
} from "@/types/permission-admin";
import type { PermissionScope } from "@/types/permission";
import type { AccessLevel } from "@/types/profile";

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

export function buildModules(): AdminModule[] {
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

/** 角色管理 / 成员授权共用：一次性加载模板与成员授权 */
export async function loadRoleTemplatesAndMembers(
  client: PoolClient,
  tenantId: string,
): Promise<{ templates: AdminTemplate[]; members: AdminMember[] }> {
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
    [tenantId],
  );
  const userGrants = await client.query<GrantRow>(
    `select user_id, permission_key, scope_type, effect
       from user_permission_grants
      where tenant_id = $1`,
    [tenantId],
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

  return { templates, members };
}
