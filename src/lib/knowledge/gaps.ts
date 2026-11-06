/**
 * 知识缺口：问答未命中时自动沉淀，也可以手动记一条。
 * 补完文档 / 卡片后把缺口置「已补」，需要重新补充时再「重开」。
 */

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";

export type GapStatus = "open" | "answered" | "closed";
export type GapSource = "manual" | "qa_miss" | "expired";

export interface GapView {
  id: string;
  question: string;
  status: GapStatus;
  source: string | null;
  departmentId: string;
  createdAt: Date;
  /** 因这个问题被追问的次数（qa_logs.gap_id 关联） */
  repeatCount: number;
}

export async function listGaps(
  context: UserContext,
  status: "open" | "closed" | "all" = "open",
): Promise<GapView[]> {
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      question: string;
      status: GapStatus;
      source: string | null;
      department_id: string;
      created_at: Date;
      repeat_count: number;
    }>(
      `select g.id, g.question, g.status, g.source, g.department_id, g.created_at,
              (select count(*) from qa_logs q where q.gap_id = g.id)::int as repeat_count
         from knowledge_gaps g
        where case
                when $1 = 'all' then true
                when $1 = 'closed' then g.status <> 'open'
                when $1 = 'open' then g.status = 'open'
                else false
              end
        order by g.created_at desc
        limit 200`,
      [status],
    );

    return rows.map((row) => ({
      id: row.id,
      question: row.question,
      status: row.status,
      source: row.source,
      departmentId: row.department_id,
      createdAt: row.created_at,
      repeatCount: row.repeat_count,
    }));
  });
}

export async function addGap(
  context: UserContext,
  rawQuestion: string,
  source: GapSource = "manual",
): Promise<string> {
  const question = rawQuestion.trim();
  if (question.length < 2) {
    throw new Error("缺口问题太短（至少 2 个字）");
  }
  if (question.length > 300) {
    throw new Error("缺口问题太长（≤ 300 字）");
  }

  const departmentId = context.activeDepartmentId;
  if (!departmentId) {
    throw new Error("当前账号没有有效部门上下文");
  }

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    const created = await client.query<{ id: string }>(
      `insert into knowledge_gaps (tenant_id, department_id, question, status, source)
       values ($1, $2, $3, 'open', $4)
       returning id`,
      [context.tenantId, departmentId, question, source],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.gap_added",
      targetType: "knowledge_gap",
      targetId: created.rows[0].id,
      departmentId,
      payload: { source },
    });

    return created.rows[0].id;
  });
}

async function setGapStatus(
  context: UserContext,
  gapId: string,
  status: "open" | "closed",
): Promise<void> {
  await withUserContext(context, async (client) => {
    const { rows } = await client.query<{ department_id: string }>(
      "select department_id from knowledge_gaps where id = $1",
      [gapId],
    );
    const departmentId = rows[0]?.department_id;
    if (!departmentId) {
      throw new Error("缺口不存在");
    }

    await requireContextPermission(client, context, "knowledge:write", {
      kind: "knowledge_gap",
      id: gapId,
      departmentId,
    });

    await client.query("update knowledge_gaps set status = $2 where id = $1", [gapId, status]);

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: status === "closed" ? "knowledge.gap_closed" : "knowledge.gap_reopened",
      targetType: "knowledge_gap",
      targetId: gapId,
      departmentId,
    });
  });
}

export async function closeGap(context: UserContext, gapId: string): Promise<void> {
  await setGapStatus(context, gapId, "closed");
}

export async function reopenGap(context: UserContext, gapId: string): Promise<void> {
  await setGapStatus(context, gapId, "open");
}
