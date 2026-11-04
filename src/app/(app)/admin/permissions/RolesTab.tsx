import { headers } from "next/headers";

import { PermissionAdminClient } from "./PermissionAdminClient";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { authorizeProtected } from "@/lib/permissions/authorize";
import { LEVEL_CEILING } from "@/lib/permissions/catalog";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { AdminMember, AdminTemplate } from "@/types/permission-admin";
import type { ResolvedPermissions } from "@/types/permission";

import { buildModules, loadRoleTemplatesAndMembers } from "./admin-data";

/** 角色管理：L1/L2/L3 等级模板配置（仅 L1） */
export async function RolesTab() {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const data = await withUserContext(context, async (client) => {
    let actor: ResolvedPermissions | null = null;
    try {
      actor = await resolveContextPermissions(client, context);
    } catch {
      actor = null;
    }

    const canManage =
      actor !== null && authorizeProtected(actor, "protected:permission_grant").allowed;
    if (!canManage) {
      return { canManage, templates: [] as AdminTemplate[], members: [] as AdminMember[] };
    }

    return { canManage, ...(await loadRoleTemplatesAndMembers(client, context.tenantId)) };
  });

  if (!data.canManage) {
    return <div className="alert-error">仅 L1 老板可以管理权限。</div>;
  }

  return (
    <PermissionAdminClient
      mode="roles"
      modules={buildModules()}
      templates={data.templates}
      members={data.members}
      currentUserId={session.userId}
      ceilings={{
        L1: [...LEVEL_CEILING.L1],
        L2: [...LEVEL_CEILING.L2],
        L3: [...LEVEL_CEILING.L3],
      }}
    />
  );
}
