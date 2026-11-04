/**
 * 服务端守卫：所有写入口都必须在第一行调用。
 * 前端 usePermission 只负责体验，不能替代这里。
 */

import type {
  PermissionCheckResult,
  PermissionResource,
  ResolvedPermissions,
} from "@/types/permission";

import {
  getPermissionNode,
  isPermissionKey,
  type PermissionKey,
  type ProtectedCapabilityKey,
} from "./catalog";
import { authorize, authorizeAny, authorizeProtected } from "./authorize";

export class PermissionDeniedError extends Error {
  readonly status = 403 as const;
  readonly code = "PERMISSION_DENIED" as const;
  readonly result: PermissionCheckResult;

  constructor(result: PermissionCheckResult) {
    super(result.reason || "没有权限执行该操作");
    this.name = "PermissionDeniedError";
    this.result = result;
  }
}

/**
 * 断言某个动作允许；不允许时抛 403。
 *
 * 注意：对于非 ALL 作用域的节点，必须传 resource。
 * 这是为了避免调用方只传一个 id 就跳过作用域校验。
 */
export function requirePermission(
  actor: ResolvedPermissions,
  key: PermissionKey,
  resource?: PermissionResource | null,
): PermissionCheckResult {
  const result = authorize(actor, key, resource);
  if (!result.allowed) {
    throw new PermissionDeniedError(result);
  }

  if (
    isPermissionKey(key) &&
    !resource &&
    getPermissionNode(key).allowedScopes.some((scope) => scope !== "ALL")
  ) {
    throw new PermissionDeniedError({
      allowed: false,
      reason: `「${getPermissionNode(key).nameZh}」需要资源上下文才能校验作用域`,
      missingKey: key,
    });
  }

  return result;
}

export function requireAnyPermission(
  actor: ResolvedPermissions,
  keys: readonly PermissionKey[],
  resource?: PermissionResource | null,
): PermissionCheckResult {
  const result = authorizeAny(actor, keys, resource);
  if (!result.allowed) {
    throw new PermissionDeniedError(result);
  }
  return result;
}

export function requireProtectedCapability(
  actor: ResolvedPermissions,
  capability: ProtectedCapabilityKey | string,
): PermissionCheckResult {
  const result = authorizeProtected(actor, capability);
  if (!result.allowed) {
    throw new PermissionDeniedError(result);
  }
  return result;
}

/** 统一把 Server Action 的错误转成可读返回值。 */
export function toPermissionMessage(error: unknown): string {
  if (error instanceof PermissionDeniedError) {
    return error.result.reason || "没有权限执行该操作";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "操作失败，请稍后重试";
}
