"use client";

import type { ReactNode } from "react";

import type { PermissionKey, PermissionScope } from "@/types/permission";

import { usePermission } from "./usePermission";

/**
 * 有权限才渲染 children；无权限渲染 fallback（默认不渲染）。
 * 需要「禁用按钮 + 原因」时，用 usePermission().check() 自行取 reason。
 */
export function Can({
  permission,
  scope,
  fallback = null,
  children,
}: {
  permission: PermissionKey;
  scope?: PermissionScope;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const { can } = usePermission();
  return can(permission, scope) ? <>{children}</> : <>{fallback}</>;
}
