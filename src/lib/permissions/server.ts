/**
 * 服务端上下文鉴权：把 UserContext 解析成 ResolvedPermissions，并执行守卫。
 *
 * 所有写入口都应在 withUserContext 事务内调用 requireContextPermission。
 * 支持影子模式：JXF_PERMISSION_SHADOW=1 时只记录差异，不阻断（仅用于灰度）。
 */

import type { PoolClient } from "pg";

import type { UserContext } from "@/lib/db/user-context";
import { log } from "@/lib/logger";
import type {
  PermissionCheckResult,
  PermissionResource,
  ResolvedPermissions,
} from "@/types/permission";

import type { PermissionKey } from "./catalog";
import { PermissionDeniedError, requirePermission } from "./guard";
import { loadGrantRules, resolveEffectivePermissions } from "./resolve";

export async function resolveContextPermissions(
  client: PoolClient,
  context: UserContext,
): Promise<ResolvedPermissions> {
  const level = context.accessLevel;
  const membershipId = context.activeMembershipId;
  const departmentId = context.activeDepartmentId;

  if (!level || !membershipId || !departmentId) {
    throw new PermissionDeniedError({
      allowed: false,
      reason: "当前账号没有有效任用，无法执行该操作",
    });
  }

  const loaded = await loadGrantRules(client, {
    tenantId: context.tenantId,
    userId: context.userId,
    level,
  });

  return resolveEffectivePermissions({
    userId: context.userId,
    level,
    activeMembershipId: membershipId,
    activeDepartmentId: departmentId,
    subtreeDepartmentIds: context.subtreeDepartmentIds,
    templateGrants: loaded.templateGrants,
    userGrants: loaded.userGrants,
    version: loaded.version,
  });
}

function shadowMode(): boolean {
  return process.env.JXF_PERMISSION_SHADOW === "1";
}

export async function requireContextPermission(
  client: PoolClient,
  context: UserContext,
  key: PermissionKey,
  resource?: PermissionResource | null,
): Promise<PermissionCheckResult> {
  let actor: ResolvedPermissions;
  try {
    actor = await resolveContextPermissions(client, context);
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      log("warn", "permission_denied", {
        user_id: context.userId,
        permission: key,
        reason: error.result.reason,
        level: context.accessLevel,
        resource_kind: resource?.kind ?? null,
        resource_id: resource?.id ?? null,
        resource_department_id: resource?.departmentId ?? null,
        resource_owner_user_id: resource?.ownerUserId ?? null,
        shadow: shadowMode(),
        request_id: context.requestId ?? null,
      });
      if (shadowMode()) {
        return error.result;
      }
    }
    throw error;
  }

  try {
    return requirePermission(actor, key, resource);
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      log("warn", "permission_denied", {
        user_id: context.userId,
        permission: key,
        reason: error.result.reason,
        level: actor.level,
        resource_kind: resource?.kind ?? null,
        resource_id: resource?.id ?? null,
        resource_department_id: resource?.departmentId ?? null,
        resource_owner_user_id: resource?.ownerUserId ?? null,
        shadow: shadowMode(),
        request_id: context.requestId ?? null,
      });
      if (shadowMode()) {
        return error.result;
      }
    }
    throw error;
  }
}

export function isPermissionShadowMode(): boolean {
  return shadowMode();
}
