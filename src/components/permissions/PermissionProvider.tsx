"use client";

import { useMemo, type ReactNode } from "react";

import { checkSnapshot } from "@/lib/permissions/snapshot";
import type { PermissionSnapshot } from "@/types/permission";

import { PermissionContext, type PermissionContextValue } from "./usePermission";

/**
 * 服务端在 layout 内注入快照；客户端只读，不请求、不再推导等级。
 * 权限变更后由服务端重新渲染 layout 下发新快照（动态页面，无需额外缓存标签）。
 */
export function PermissionProvider({
  snapshot,
  children,
}: {
  snapshot: PermissionSnapshot | null;
  children: ReactNode;
}) {
  const value = useMemo<PermissionContextValue>(
    () => ({
      snapshot,
      level: snapshot?.level ?? null,
      check: (key, scope) => checkSnapshot(snapshot, key, scope),
      can: (key, scope) => checkSnapshot(snapshot, key, scope).allowed,
    }),
    [snapshot],
  );

  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}
