/**
 * 有效权限解析：把「等级上限 + 模板授权 + 用户授权」合并成一份 ResolvedPermissions。
 *
 * 规则：
 * - 先取等级上限（ceiling）
 * - 模板 allow → 写入
 * - 用户 allow → 取更宽 Scope
 * - 用户 deny → 移除
 * - 任何超出上限、未知节点、非法 Scope、已过期授权 → 忽略并记录
 * - L1 默认全量（保护区由 authorizeProtected 单独判定）
 *
 * 本文件同时提供数据库读取函数；读取必须在 withUserContext 事务内执行。
 */

import type { PoolClient } from "pg";

import type { AccessLevel } from "@/types/profile";
import type { PermissionKey, ResolvedPermissions } from "@/types/permission";

import {
  ALL_PERMISSION_KEYS,
  getPermissionModule,
  getPermissionNode,
  isPermissionKey,
} from "./catalog";
import { ceilingSet } from "./ceiling";
import { isPermissionScope, scopeRank, widestScope, type PermissionScope } from "./scope";

export interface GrantRule {
  permissionKey: string;
  scope: string;
  effect: "allow" | "deny";
  expiresAt?: string | null;
}

export interface ResolvePermissionsInput {
  userId: string;
  level: AccessLevel;
  activeMembershipId: string;
  activeDepartmentId: string;
  subtreeDepartmentIds: readonly string[];
  templateGrants: readonly GrantRule[];
  userGrants: readonly GrantRule[];
  version?: number;
}

export interface LoadedGrantRules {
  templateGrants: GrantRule[];
  userGrants: GrantRule[];
  version: number;
}

interface TemplateGrantRow {
  permission_key: string;
  scope_type: string;
  effect: string;
}

interface UserGrantRow extends TemplateGrantRow {
  expires_at: Date | null;
}

function expired(rule: GrantRule): boolean {
  if (!rule.expiresAt) {
    return false;
  }
  const at = Date.parse(rule.expiresAt);
  if (!Number.isFinite(at)) {
    return true;
  }
  return at <= Date.now();
}

function widestFor(key: PermissionKey): PermissionScope {
  const scope = widestScope(getPermissionNode(key).allowedScopes);
  if (!scope) {
    throw new Error(`权限节点缺少 Scope：${key}`);
  }
  return scope;
}

/** 纯函数：不访问数据库，便于单元测试与前端预览。 */
export function resolveEffectivePermissions(input: ResolvePermissionsInput): ResolvedPermissions {
  const level = input.level;

  // L1 是根用户：默认拥有全部非保护区节点，不受模板与用户 deny 影响。
  if (level === "L1") {
    const grants = new Map<PermissionKey, PermissionScope>();
    for (const key of ALL_PERMISSION_KEYS) {
      grants.set(key, widestFor(key));
    }
    return {
      userId: input.userId,
      level,
      activeMembershipId: input.activeMembershipId,
      activeDepartmentId: input.activeDepartmentId,
      subtreeDepartmentIds: input.subtreeDepartmentIds,
      version: input.version ?? 0,
      grants,
      denies: new Set<PermissionKey>(),
      ignoredKeys: [],
    };
  }

  const ceiling = ceilingSet(level);
  const grants = new Map<PermissionKey, PermissionScope>();
  const denies = new Set<PermissionKey>();
  const ignored = new Set<string>();

  function apply(rule: GrantRule, source: "template" | "user"): void {
    if (!isPermissionKey(rule.permissionKey)) {
      ignored.add(rule.permissionKey);
      return;
    }

    const key = rule.permissionKey;

    if (!ceiling.has(key)) {
      ignored.add(key);
      return;
    }

    const node = getPermissionNode(key);
    if (!getPermissionModule(node.module).enabled) {
      ignored.add(key);
      return;
    }

    if (!isPermissionScope(rule.scope) || !node.allowedScopes.includes(rule.scope)) {
      ignored.add(key);
      return;
    }

    if (expired(rule)) {
      ignored.add(key);
      return;
    }

    if (rule.effect === "deny") {
      grants.delete(key);
      denies.add(key);
      return;
    }

    const previous = grants.get(key);
    if (!previous || scopeRank(rule.scope) > scopeRank(previous)) {
      grants.set(key, rule.scope);
    }

    // 用户显式 allow 可以覆盖此前的 deny（deny 只在最后生效顺序中更靠后时保留）
    if (source === "user") {
      denies.delete(key);
    }
  }

  for (const rule of input.templateGrants) {
    apply(rule, "template");
  }

  for (const rule of input.userGrants) {
    apply(rule, "user");
  }

  return {
    userId: input.userId,
    level,
    activeMembershipId: input.activeMembershipId,
    activeDepartmentId: input.activeDepartmentId,
    subtreeDepartmentIds: input.subtreeDepartmentIds,
    version: input.version ?? 0,
    grants,
    denies,
    ignoredKeys: [...ignored],
  };
}

/** 读取模板授权 + 用户授权 + 版本号；调用方必须已在用户上下文事务内。 */
export async function loadGrantRules(
  client: PoolClient,
  input: { tenantId: string; userId: string; level: AccessLevel },
): Promise<LoadedGrantRules> {
  const template = await client.query<TemplateGrantRow>(
    `select g.permission_key, g.scope_type, g.effect
       from role_template_grants g
       join role_templates t on t.id = g.template_id
      where t.level = $1`,
    [input.level],
  );

  const user = await client.query<UserGrantRow>(
    `select permission_key, scope_type, effect, expires_at
       from user_permission_grants
      where tenant_id = $1
        and user_id = $2`,
    [input.tenantId, input.userId],
  );

  const revision = await client.query<{ version: string | number }>(
    "select version from permission_revisions where user_id = $1",
    [input.userId],
  );

  return {
    templateGrants: template.rows.map((row) => ({
      permissionKey: row.permission_key,
      scope: row.scope_type,
      effect: row.effect === "deny" ? "deny" : "allow",
    })),
    userGrants: user.rows.map((row) => ({
      permissionKey: row.permission_key,
      scope: row.scope_type,
      effect: row.effect === "deny" ? "deny" : "allow",
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    })),
    version: Number(revision.rows[0]?.version ?? 0),
  };
}
