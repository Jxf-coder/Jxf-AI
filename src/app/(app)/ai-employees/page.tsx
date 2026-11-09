import { headers } from "next/headers";

import {
  headerRow,
  pageSubtitle,
  pageTitle,
  pageWrap,
} from "@/components/knowledge/tokens";
import {
  listAiEmployeeGrantCandidates,
  listAiEmployees,
  loadAiEmployee,
} from "@/lib/ai-employees";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import { listMcpToolOptions } from "@/lib/mcp/connectors";
import { listSkillOptions } from "@/lib/skills";
import { canAssignWork, listWorkItems } from "@/lib/work-items";

import { AiEmployeesClient } from "./AiEmployeesClient";

export default async function AiEmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ ai?: string }>;
}) {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);
  const canManage = context.accessLevel === "L1";

  const params = await searchParams;
  const employees = await listAiEmployees(context);
  const requested = typeof params.ai === "string" ? params.ai : undefined;
  const selectedId = employees.some((item) => item.id === requested) ? requested : employees[0]?.id;

  const [detail, candidates, workItems, mcpTools, skillOptions] = await Promise.all([
    selectedId ? loadAiEmployee(context, selectedId) : Promise.resolve(null),
    canManage ? listAiEmployeeGrantCandidates(context) : Promise.resolve(null),
    selectedId ? listWorkItems(context, selectedId) : Promise.resolve([]),
    canManage ? listMcpToolOptions(context) : Promise.resolve([]),
    canManage ? listSkillOptions(context).catch(() => []) : Promise.resolve([]),
  ]);

  return (
    <section className={pageWrap}>
      <header className={headerRow}>
        <div>
          <h1 className={pageTitle}>AI 员工</h1>
          <p className={pageSubtitle}>
            给 AI 员工安排工作、跟踪执行、验收交付物。未授权账号看不到任何 AI 员工（含名称与描述）；
            AI 员工自身不携带数据权限，运行时继承派发者的部门上下文。
          </p>
        </div>
      </header>

      <AiEmployeesClient
        key={detail?.id ?? "empty"}
        employees={employees}
        detail={detail}
        candidates={candidates}
        workItems={workItems}
        mcpTools={mcpTools}
        skillOptions={skillOptions}
        accessLevel={context.accessLevel}
        canManage={canManage}
        canAssign={canAssignWork(context)}
      />
    </section>
  );
}
