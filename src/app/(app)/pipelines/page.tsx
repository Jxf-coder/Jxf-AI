import { headers } from "next/headers";

import {
  emptyState,
  headerRow,
  pageSubtitle,
  pageTitle,
  pageWrap,
} from "@/components/knowledge/tokens";
import { listAiEmployees } from "@/lib/ai-employees";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { PIPELINE_EVENT_LABELS, PIPELINE_EVENT_TYPES } from "@/lib/pipeline-events";
import { listPipelineRuns, listPipelines } from "@/lib/pipelines";
import { authorize } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";

import { PipelinesClient } from "./PipelinesClient";

export const dynamic = "force-dynamic";

export default async function PipelinesPage() {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const header = (
    <header className={headerRow}>
      <div>
        <h1 className={pageTitle}>自动化产线</h1>
        <p className={pageSubtitle}>
          把一组派活步骤固化成产线：运行只派第一步，上一步完成后由 runner 自动推进；
          可设置定时触发、可选步骤，并用 {"{{previous}}"} 把上一步交付传给下一步。
          每一步复用现有任务队列，交付物仍在 AI 员工页人工验收。
        </p>
      </div>
    </header>
  );

  if (!context.accessLevel) {
    return (
      <section className={pageWrap}>
        {header}
        <div className={`mt-5 ${emptyState}`}>当前账号没有有效任用，无法使用产线。</div>
      </section>
    );
  }

  const permissions = await withUserContext(context, (client) =>
    resolveContextPermissions(client, context),
  );
  const canUse = authorize(permissions, "pipeline:use").allowed;
  const canManage = authorize(permissions, "pipeline:manage").allowed;

  if (!canUse) {
    return (
      <section className={pageWrap}>
        {header}
        <div className={`mt-5 ${emptyState}`}>缺少「运行产线」权限，请联系管理员授权。</div>
      </section>
    );
  }

  const [pipelines, runs, employees] = await Promise.all([
    listPipelines(context),
    listPipelineRuns(context),
    listAiEmployees(context),
  ]);

  return (
    <section className={pageWrap}>
      {header}
      <div className="mt-5">
        <PipelinesClient
          pipelines={pipelines}
          runs={runs}
          employees={employees
            .filter((employee) => employee.status === "active")
            .map((employee) => ({ id: employee.id, name: employee.name }))}
          canManage={canManage}
          eventOptions={PIPELINE_EVENT_TYPES.map((value) => ({
            value,
            label: PIPELINE_EVENT_LABELS[value],
          }))}
        />
      </div>
    </section>
  );
}
