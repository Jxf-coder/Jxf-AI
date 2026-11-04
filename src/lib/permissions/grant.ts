/**
 * 授权上限校验：谁能给谁授予什么。
 *
 * v1 只允许 L1 修改授权；后续开放 L2 时，只需把 `actor.level !== "L1"` 的分支
 * 换成「授予节点必须是自己拥有的节点，且 Scope 不得更宽」即可。
 */

import type { AccessLevel } from "@/types/profile";
import type { PermissionCheckResult, ResolvedPermissions } from "@/types/permission";

import {
  getPermissionModule,
  getPermissionNode,
  isPermissionKey,
  type PermissionKey,
} from "./catalog";
import { isWithinCeiling } from "./ceiling";
import { isPermissionScope, type PermissionScope } from "./scope";

export interface GrantTarget {
  userId: string;
  level: AccessLevel;
}

export interface GrantRequest {
  permissionKey: PermissionKey | string;
  scope: PermissionScope | string;
  effect: "allow" | "deny";
  expiresAt?: string | null;
}

function deny(reason: string): PermissionCheckResult {
  return { allowed: false, reason };
}

function allow(): PermissionCheckResult {
  return { allowed: true, reason: "" };
}

export function canGrant(
  actor: ResolvedPermissions,
  target: GrantTarget,
  request: GrantRequest,
): PermissionCheckResult {
  if (actor.level !== "L1") {
    return deny("当前版本仅 L1 可以修改授权");
  }

  if (!isPermissionKey(request.permissionKey)) {
    return deny("未知权限点");
  }

  const key = request.permissionKey;
  const node = getPermissionNode(key);

  if (!getPermissionModule(node.module).enabled) {
    return deny(`模块「${getPermissionModule(node.module).nameZh}」未启用`);
  }

  if (!node.grantable) {
    return deny(`「${node.nameZh}」是系统保留能力，不能通过勾选授予`);
  }

  if (!isWithinCeiling(target.level, key)) {
    return deny(`目标成员等级 ${target.level} 不允许「${node.nameZh}」`);
  }

  if (!isPermissionScope(request.scope) || !node.allowedScopes.includes(request.scope)) {
    return deny(`「${node.nameZh}」不支持该作用域`);
  }

  if (request.effect === "allow" && node.action !== "read" && request.scope === "DEPT_TREE") {
    return deny("写类动作不能授予「本部门及子部门」作用域");
  }

  if (request.expiresAt) {
    const at = Date.parse(request.expiresAt);
    if (!Number.isFinite(at) || at <= Date.now()) {
      return deny("授权过期时间必须晚于当前时间");
    }
  }

  return allow();
}
