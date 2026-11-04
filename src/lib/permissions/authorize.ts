/**
 * 单次动作判定。
 *
 * 调用方必须传入「已从数据库读出的资源」，不能把客户端参数直接当作用域依据。
 * 这是纯函数，不访问数据库；服务端守卫见 guard.ts。
 */

import type {
  PermissionCheckResult,
  PermissionResource,
  ResolvedPermissions,
} from "@/types/permission";

import {
  getPermissionModule,
  getPermissionNode,
  getProtectedCapability,
  isPermissionKey,
  isProtectedCapabilityKey,
  type ProtectedCapabilityKey,
  type PermissionKey,
} from "./catalog";
import { isWithinCeiling } from "./ceiling";
import {
  PERMISSION_SCOPE_LABEL,
  scopeCoversResource,
} from "./scope";

function deny(reason: string, extra: Partial<PermissionCheckResult> = {}): PermissionCheckResult {
  return { allowed: false, reason, ...extra };
}

function allow(extra: Partial<PermissionCheckResult> = {}): PermissionCheckResult {
  return { allowed: true, reason: "", ...extra };
}

/**
 * 判定某个 PermissionNode 是否允许。
 *
 * @param actor  resolveEffectivePermissions 的结果
 * @param key    权限节点
 * @param resource 目标资源；UI 预检可省略，服务端写操作必须传
 */
export function authorize(
  actor: ResolvedPermissions,
  key: PermissionKey,
  resource?: PermissionResource | null,
): PermissionCheckResult {
  if (!isPermissionKey(key)) {
    return deny("未知权限点", { missingKey: key });
  }

  const node = getPermissionNode(key);
  if (!getPermissionModule(node.module).enabled) {
    return deny(`模块「${getPermissionModule(node.module).nameZh}」未启用`, {
      missingKey: key,
    });
  }

  // L1 是根用户：默认通过全部非保护区节点。
  if (actor.level === "L1") {
    return allow();
  }

  if (!isWithinCeiling(actor.level, key)) {
    return deny(`当前等级 ${actor.level} 不允许「${node.nameZh}」`, { missingKey: key });
  }

  if (actor.denies.has(key)) {
    return deny(`权限「${node.nameZh}」已被显式拒绝`, { missingKey: key });
  }

  const scope = actor.grants.get(key);
  if (!scope) {
    return deny(`缺少权限点「${node.nameZh}」(${key})`, { missingKey: key });
  }

  // 没有资源上下文时只做「是否拥有该权限点」的预检；
  // 服务端写操作必须通过 guard 传入资源。
  if (!resource) {
    return allow({ grantedScope: scope });
  }

  const covered = scopeCoversResource({
    scope,
    activeDepartmentId: actor.activeDepartmentId,
    resourceDepartmentId: resource.departmentId,
    subtreeDepartmentIds: actor.subtreeDepartmentIds,
    isOwnResource: Boolean(resource.ownerUserId && resource.ownerUserId === actor.userId),
  });

  if (!covered) {
    return deny(
      `「${node.nameZh}」仅允许${PERMISSION_SCOPE_LABEL[scope]}，目标资源不在范围内`,
      { missingKey: key, grantedScope: scope },
    );
  }

  return allow({ grantedScope: scope });
}

/** 保护区能力：只绑定 L1，不参与权限勾选。 */
export function authorizeProtected(
  actor: ResolvedPermissions,
  capability: ProtectedCapabilityKey | string,
): PermissionCheckResult {
  if (!isProtectedCapabilityKey(capability)) {
    return deny("未知保护区能力");
  }

  const def = getProtectedCapability(capability);
  if (actor.level !== "L1") {
    return deny(`「${def.nameZh}」属于系统保护区，仅 L1 可操作`);
  }

  return allow({ grantedScope: "ALL" });
}

/** 任一节点允许即通过；用于「查看或编辑」这类入口。 */
export function authorizeAny(
  actor: ResolvedPermissions,
  keys: readonly PermissionKey[],
  resource?: PermissionResource | null,
): PermissionCheckResult {
  let last: PermissionCheckResult = deny("没有可用权限点");
  for (const key of keys) {
    const result = authorize(actor, key, resource);
    if (result.allowed) {
      return result;
    }
    last = result;
  }
  return last;
}
