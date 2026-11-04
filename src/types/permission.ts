/**
 * 权限系统的标准数据结构。
 * 页面、Server Action、Provider 快照与后续「权限管理」面板都以这里为准。
 */

import type { PermissionKey } from "@/lib/permissions/catalog";
import type { PermissionScope } from "@/lib/permissions/scope";

export type { PermissionKey } from "@/lib/permissions/catalog";
export type { PermissionModuleKey, PermissionRisk, PermissionAction } from "@/lib/permissions/catalog";
export type { PermissionScope } from "@/lib/permissions/scope";

export type AccessLevel = "L1" | "L2" | "L3";

export type PermissionEffect = "allow" | "deny";

export type PermissionSource = "level" | "template" | "user" | "deny";

/** 一条用户级授权（对应 user_permission_grants 一行） */
export interface PermissionGrant {
  id?: string;
  userId: string;
  permissionKey: PermissionKey;
  scope: PermissionScope;
  effect: PermissionEffect;
  /** DEPT / DEPT_TREE 时必填 */
  scopeId?: string | null;
  grantedBy?: string | null;
  expiresAt?: string | null;
}

/** 解析后的单条有效权限 */
export interface EffectivePermission {
  key: PermissionKey;
  scope: PermissionScope;
  source: PermissionSource;
}

/** 服务端下发给前端的权限快照；不包含目录元数据 */
export interface PermissionSnapshot {
  version: number;
  level: AccessLevel;
  activeDepartmentId: string;
  activeMembershipId: string;
  /** 允许的节点 → 最宽作用域 */
  grants: Partial<Record<PermissionKey, PermissionScope>>;
  /** 显式拒绝的节点 */
  denies: PermissionKey[];
}

export interface PermissionCheckResult {
  allowed: boolean;
  /** 面向用户的可读原因；allowed=true 时为空 */
  reason: string;
  /** 该动作需要的 Scope */
  requiredScope?: PermissionScope;
  /** 当前实际授予的 Scope */
  grantedScope?: PermissionScope;
  /** 缺失的节点 */
  missingKey?: PermissionKey;
}

/** 判定作用域时必须传入的「已从数据库读出的资源」 */
export interface PermissionResource {
  kind: string;
  id?: string;
  /** 资源所属部门；全局资源传 null */
  departmentId: string | null;
  /** SELF 判定用：资源归属人 */
  ownerUserId?: string | null;
}

/** 服务端解析后的有效权限；不直接下发客户端 */
export interface ResolvedPermissions {
  userId: string;
  level: AccessLevel;
  activeMembershipId: string;
  activeDepartmentId: string;
  subtreeDepartmentIds: readonly string[];
  version: number;
  grants: ReadonlyMap<PermissionKey, PermissionScope>;
  denies: ReadonlySet<PermissionKey>;
  /** 目录中不存在、等级不允许或 Scope 非法的授权行，便于日志与排查 */
  ignoredKeys: readonly string[];
}

export interface PermissionGrantInput {
  targetUserId: string;
  permissionKey: PermissionKey;
  scope: PermissionScope;
  effect: PermissionEffect;
  scopeId?: string | null;
  expiresAt?: string | null;
}
