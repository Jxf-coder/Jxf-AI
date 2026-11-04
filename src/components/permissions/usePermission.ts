"use client";

import { createContext, useContext } from "react";

import type {
  AccessLevel,
  PermissionCheckResult,
  PermissionKey,
  PermissionScope,
  PermissionSnapshot,
} from "@/types/permission";

export interface PermissionContextValue {
  /** 服务端注入的只读快照；无有效任用时为 null */
  snapshot: PermissionSnapshot | null;
  level: AccessLevel | null;
  can: (key: PermissionKey, scope?: PermissionScope) => boolean;
  check: (key: PermissionKey, scope?: PermissionScope) => PermissionCheckResult;
}

export const PermissionContext = createContext<PermissionContextValue | null>(null);

/**
 * 只读消费服务端快照，不发请求、不重新推导等级。
 * 客户端判定只用于隐藏 / 禁用入口，不能替代服务端守卫。
 */
export function usePermission(): PermissionContextValue {
  const value = useContext(PermissionContext);
  if (!value) {
    throw new Error("usePermission 必须在 PermissionProvider 内使用");
  }
  return value;
}
