import { headers } from "next/headers";

import { PermissionProvider } from "@/components/permissions/PermissionProvider";
import { Shell } from "@/components/shell/Shell";
import { ToastViewport } from "@/components/ui/toast";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext, type ActiveMembership } from "@/lib/db/user-context";
import { errorMessage, log } from "@/lib/logger";
import { resolveContextPermissions } from "@/lib/permissions/server";
import { toPermissionSnapshot } from "@/lib/permissions/snapshot";
import { getPublicBranding } from "@/lib/settings/store";
import type { PermissionSnapshot } from "@/types/permission";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const branding = await getPublicBranding();

  let accessLevel: string | null = null;
  let activeDepartmentId: string | null = null;
  let memberships: ActiveMembership[] = [];
  let snapshot: PermissionSnapshot | null = null;
  let pendingApprovals = 0;
  let pendingWorkReviews = 0;

  try {
    const context = await resolveUserContext(user.userId, requestId);
    accessLevel = context.accessLevel;
    activeDepartmentId = context.activeDepartmentId;
    memberships = context.activeMemberships;

    if (context.accessLevel) {
      try {
        snapshot = await withUserContext(context, async (client) => {
          const actor = await resolveContextPermissions(client, context);
          // 顶栏待审批铃铛：非 L1 由数据库函数直接返回 0
          const countResult = await client.query<{ count: number }>(
            "select app.pending_approval_count() as count",
          );
          pendingApprovals = countResult.rows[0]?.count ?? 0;
          // AI 员工「待验收」数字：工作项表未建时降级为 0
          const workCount = await client.query<{ count: number }>(
            `select case when to_regclass('public.work_items') is null then 0
                         else (select count(*)::int from work_items where status = 'waiting_review')
                    end as count`,
          );
          pendingWorkReviews = workCount.rows[0]?.count ?? 0;
          return toPermissionSnapshot(actor);
        });
      } catch (error) {
        log("error", "layout_permissions_failed", {
          error: errorMessage(error),
          request_id: requestId ?? null,
        });
      }
    }
  } catch (error) {
    log("error", "layout_context_failed", { error: errorMessage(error), request_id: requestId ?? null });
  }

  return (
    <PermissionProvider snapshot={snapshot}>
      <Shell
        email={user.email}
        name={user.name}
        siteName={branding.siteName}
        accessLevel={accessLevel}
        activeDepartmentId={activeDepartmentId}
        memberships={memberships.map((membership) => ({
          departmentId: membership.departmentId,
          departmentName: membership.departmentName,
          level: membership.level,
        }))}
        pendingApprovals={pendingApprovals}
        pendingWorkReviews={pendingWorkReviews}
      >
        {children}
      </Shell>
      <ToastViewport />
    </PermissionProvider>
  );
}
