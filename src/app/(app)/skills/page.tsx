import { headers } from "next/headers";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { authorize } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import { listSkillRuns, listSkills } from "@/lib/skills";
import { emptyState, pageWrap } from "@/components/knowledge/tokens";

import { SkillsClient } from "./SkillsClient";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  if (!context.accessLevel) {
    return (
      <section className={pageWrap}>
        <div className={emptyState}>当前账号没有有效任用，无法使用技能台。</div>
      </section>
    );
  }

  const permissions = await withUserContext(context, (client) =>
    resolveContextPermissions(client, context),
  );
  const resource = {
    kind: "department" as const,
    id: context.activeDepartmentId ?? undefined,
    departmentId: context.activeDepartmentId,
  };
  const canUse = authorize(permissions, "skill:use", resource).allowed;
  const canEdit = authorize(permissions, "skill:edit", resource).allowed;

  if (!canUse) {
    return (
      <section className={pageWrap}>
        <div className={emptyState}>当前等级没有「使用技能」权限。</div>
      </section>
    );
  }

  const [skills, recentRuns] = await Promise.all([
    listSkills(context),
    listSkillRuns(context, undefined, 8),
  ]);

  return (
    <section className={pageWrap}>
      <SkillsClient skills={skills} canEdit={canEdit} recentRuns={recentRuns} />
    </section>
  );
}
