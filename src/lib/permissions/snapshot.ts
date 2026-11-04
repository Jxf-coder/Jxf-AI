/**
 * 权限快照：服务端解析结果 → 客户端只读快照；以及客户端预检的纯函数。
 *
 * 客户端 `can()` 只是体验层：真正的放行仍由服务端 `requirePermission` 与数据库 RLS 决定。
 */

import type {
  PermissionCheckResult,
  PermissionKey,
  PermissionScope,
  PermissionSnapshot,
  ResolvedPermissions,
} from "@/types/permission";

import { PERMISSION_SCOPE_LABEL, scopeRank } from "./scope";

/** 只下发「允许的 key + 最宽 Scope」与显式拒绝，不下发目录元数据。 */
export function toPermissionSnapshot(actor: ResolvedPermissions): PermissionSnapshot {
  const grants: Partial<Record<PermissionKey, PermissionScope>> = {};
  for (const [key, scope] of actor.grants) {
    grants[key] = scope;
  }

  return {
    version: actor.version,
    level: actor.level,
    activeDepartmentId: actor.activeDepartmentId,
    activeMembershipId: actor.activeMembershipId,
    grants,
    denies: [...actor.denies],
  };
}

/**
 * 客户端预检：只判断「是否拥有节点 + Scope 是否够宽」。
 * 不做资源归属判定，因此不能替代服务端守卫。
 */
export function checkSnapshot(
  snapshot: PermissionSnapshot | null,
  key: PermissionKey,
  scope?: PermissionScope,
): PermissionCheckResult {
  if (!snapshot) {
    return { allowed: false, reason: "当前账号没有有效任用", missingKey: key };
  }

  if (snapshot.level === "L1") {
    return { allowed: true, reason: "", grantedScope: snapshot.grants[key] ?? "ALL" };
  }

  if (snapshot.denies.includes(key)) {
    return { allowed: false, reason: `权限「${key}」已被显式拒绝`, missingKey: key };
  }

  const granted = snapshot.grants[key];
  if (!granted) {
    return { allowed: false, reason: `缺少权限点「${key}」`, missingKey: key };
  }

  if (scope && scopeRank(scope) > scopeRank(granted)) {
    return {
      allowed: false,
      reason: `需要${PERMISSION_SCOPE_LABEL[scope]}范围，当前仅${PERMISSION_SCOPE_LABEL[granted]}`,
      missingKey: key,
      requiredScope: scope,
      grantedScope: granted,
    };
  }

  return { allowed: true, reason: "", grantedScope: granted };
}
