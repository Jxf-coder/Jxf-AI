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

  const [detail, candidates] = await Promise.all([
    selectedId ? loadAiEmployee(context, selectedId) : Promise.resolve(null),
    canManage ? listAiEmployeeGrantCandidates(context) : Promise.resolve(null),
  ]);

  return (
    <section className={pageWrap}>
      <header className={headerRow}>
        <div>
          <h1 className={pageTitle}>AI 员工</h1>
          <p className={pageSubtitle}>
            目录与使用授权。未授权账号看不到任何 AI 员工（含名称与描述）；AI
            员工自身不携带数据权限，运行时能力在 M3 接入。
          </p>
        </div>
      </header>

      <AiEmployeesClient
        key={detail?.id ?? "empty"}
        employees={employees}
        detail={detail}
        candidates={candidates}
        canManage={canManage}
      />
    </section>
  );
}
