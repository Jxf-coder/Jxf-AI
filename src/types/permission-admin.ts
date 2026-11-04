/**
 * 权限管理面板的标准数据结构。
 * 服务端只下发渲染所需字段，客户端不回传目录元数据。
 */

import type {
  AccessLevel,
  PermissionAction,
  PermissionKey,
  PermissionModuleKey,
  PermissionRisk,
  PermissionScope,
} from "./permission";

export type GrantEffect = "allow" | "deny";

export interface AdminGrant {
  scope: PermissionScope;
  effect: GrantEffect;
}

export type AdminGrantMap = Partial<Record<PermissionKey, AdminGrant>>;

export interface AdminNode {
  key: PermissionKey;
  nameZh: string;
  description: string;
  action: PermissionAction;
  risk: PermissionRisk;
  allowedScopes: PermissionScope[];
  defaultEnabled: boolean;
  grantable: boolean;
  requiresApproval: boolean;
}

export interface AdminModule {
  key: PermissionModuleKey;
  nameZh: string;
  description: string;
  nodes: AdminNode[];
}

export interface AdminTemplate {
  id: string;
  name: string;
  level: AccessLevel;
  isSystem: boolean;
  grants: AdminGrantMap;
}

export interface AdminMember {
  userId: string;
  name: string;
  phone: string | null;
  departmentId: string;
  departmentName: string;
  membershipId: string;
  level: AccessLevel;
  grants: AdminGrantMap;
}

export interface AdminPayloadGrant {
  permissionKey: PermissionKey;
  scope: PermissionScope;
  effect: GrantEffect;
}
