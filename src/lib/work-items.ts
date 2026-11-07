/**
 * AI 员工派活（M3.5）：工作项的创建、列表与人工验收。
 *
 * 边界：
 * - AI 员工是执行体，不提供对话；对话属于 Agent 工作台；
 * - 派发仅 L1 / 部门负责人（L2）；
 * - 一次派发 = work_item + run(kind='task')；执行、事件、用量全部复用 M3 运行时；
 * - 交付物默认人工验收（waiting_review → done / returned）；员工可配自动验收，
 *   派发时把验收门槛快照进工作项，worker 达标即置 done，否则仍转人工。
 */

import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { auditInTx } from "@/lib/audit";
import { parseReviewConfig } from "@/lib/ai-employees";
import { PermissionDeniedError } from "@/lib/permissions/guard";
import { requireContextPermission } from "@/lib/permissions/server";
import { acceptRun } from "@/lib/runtime/accept";

export type WorkItemStatus =
  | "draft"
  | "queued"
  | "running"
  | "waiting_review"
  | "done"
  | "returned"
  | "failed"
  | "cancelled";

export type WorkPriority = "low" | "normal" | "high" | "urgent";

export interface WorkItemView {
  id: string;
  title: string;
  brief: string;
  aiEmployeeId: string | null;
  aiEmployeeName: string | null;
  assignedByName: string | null;
  reviewerName: string | null;
  priority: WorkPriority;
  status: WorkItemStatus;
  currentRunId: string | null;
  deliverableText: string;
  deliverableModel: string | null;
  reviewNote: string | null;
  dueAt: string | null;
  createdAt: string;
  reviewedAt: string | null;
  canReview: boolean;
}

export interface AssignWorkInput {
  aiEmployeeId: string;
  title: string;
  brief: string;
  priority?: WorkPriority;
  dueAt?: string | null;
}

const PRIORITIES: readonly WorkPriority[] = ["low", "normal", "high", "urgent"];

function isPriority(value: string): value is WorkPriority {
  return (PRIORITIES as readonly string[]).includes(value);
}

/** 派活仅 L1 / 部门负责人（L2） */
export function canAssignWork(context: UserContext): boolean {
  return context.accessLevel === "L1" || context.accessLevel === "L2";
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export async function listWorkItems(
  context: UserContext,
  aiEmployeeId?: string | null,
): Promise<WorkItemView[]> {
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      title: string;
      brief: string;
      ai_employee_id: string | null;
      ai_employee_name: string | null;
      assigned_by_name: string | null;
      reviewer_name: string | null;
      priority: string;
      status: WorkItemStatus;
      current_run_id: string | null;
      deliverable_text: string | null;
      deliverable_model: string | null;
      review_note: string | null;
      due_at: Date | null;
      created_at: Date;
      reviewed_at: Date | null;
    }>(
      `select w.id, w.title, w.brief, w.ai_employee_id,
              e.name as ai_employee_name,
              u.name as assigned_by_name,
              r.name as reviewer_name,
              w.priority, w.status, w.current_run_id,
              w.deliverable->>'text' as deliverable_text,
              w.deliverable->>'model' as deliverable_model,
              w.review_note, w.due_at, w.created_at, w.reviewed_at
         from work_items w
         left join ai_employees e on e.id = w.ai_employee_id
         left join users u on u.id = w.assigned_by
         left join users r on r.id = w.reviewer_id
        where ($1::uuid is null or w.ai_employee_id = $1)
        order by w.created_at desc
        limit 50`,
      [aiEmployeeId ?? null],
    );

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      brief: row.brief,
      aiEmployeeId: row.ai_employee_id,
      aiEmployeeName: row.ai_employee_name,
      assignedByName: row.assigned_by_name,
      reviewerName: row.reviewer_name,
      priority: isPriority(row.priority) ? row.priority : "normal",
      status: row.status,
      currentRunId: row.current_run_id,
      deliverableText: row.deliverable_text ?? "",
      deliverableModel: row.deliverable_model,
      reviewNote: row.review_note,
      dueAt: toIso(row.due_at),
      createdAt: row.created_at.toISOString(),
      reviewedAt: toIso(row.reviewed_at),
      canReview: row.status === "waiting_review",
    }));
  });
}

/** 派活：写 work_item，再受理一个 kind='task' 的执行 */
export async function assignWork(
  context: UserContext,
  input: AssignWorkInput,
): Promise<{ workItemId: string; runId: string }> {
  if (!canAssignWork(context)) {
    throw new PermissionDeniedError({ allowed: false, reason: "只有 L1 / 部门负责人可以派活" });
  }

  const title = input.title.trim();
  const brief = input.brief.trim();
  if (title.length === 0 || brief.length === 0) {
    throw new Error("工作标题与工作说明不能为空");
  }
  if (title.length > 80) {
    throw new Error("工作标题过长（≤ 80 字）");
  }
  if (brief.length > 4000) {
    throw new Error("工作说明过长（≤ 4000 字）");
  }

  const departmentId = context.activeDepartmentId;
  if (!departmentId) {
    throw new Error("当前账号没有有效部门上下文");
  }

  const created = await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    const employee = await client.query<{
      id: string;
      name: string;
      tier: string | null;
      model_config: Record<string, unknown> | null;
    }>(
      `select id, name, model_config->>'tier' as tier, model_config
         from ai_employees
        where id = $1 and status = 'active'`,
      [input.aiEmployeeId],
    );
    const row = employee.rows[0];
    if (!row) {
      throw new Error("AI 员工不存在、未上线或未授权给当前部门");
    }
    const tier = row.tier === "fast" ? "fast" : "deep";
    // 验收方式随派发快照进工作项：之后改员工配置，不影响已发出的活
    const review = parseReviewConfig(row.model_config);

    const inserted = await client.query<{ id: string }>(
      `insert into work_items
         (tenant_id, department_id, title, brief, input, ai_employee_id,
          assigned_by, reviewer_id, priority, due_at)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $7, $8, $9)
       returning id`,
      [
        context.tenantId,
        departmentId,
        title,
        brief,
        JSON.stringify({ tier, review }),
        input.aiEmployeeId,
        context.userId,
        input.priority && isPriority(input.priority) ? input.priority : "normal",
        input.dueAt ? new Date(input.dueAt) : null,
      ],
    );
    const workItemId = inserted.rows[0].id;

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "work_item.assigned",
      targetType: "work_item",
      targetId: workItemId,
      departmentId,
      payload: { ai_employee_id: input.aiEmployeeId, title, review_mode: review.mode },
    });

    return { workItemId, tier };
  });

  try {
    const accepted = await acceptRun(context, {
      kind: "task",
      input: {
        workItemId: created.workItemId,
        question: brief,
        title,
        modelTier: created.tier,
      },
      aiEmployeeId: input.aiEmployeeId,
      clientTurnId: `work-${created.workItemId}`,
      title,
    });

    await withUserContext(context, (client) =>
      client.query(
        `update work_items
            set current_run_id = $2, status = 'queued', updated_at = now()
          where id = $1`,
        [created.workItemId, accepted.runId],
      ),
    );

    return { workItemId: created.workItemId, runId: accepted.runId };
  } catch (error) {
    await withUserContext(context, (client) =>
      client.query(
        `update work_items set status = 'failed', updated_at = now() where id = $1`,
        [created.workItemId],
      ),
    ).catch(() => undefined);
    throw error;
  }
}

/** 重跑：退回 / 失败 / 取消的工作项重新排队，历史 run 保留 */
export async function rerunWorkItem(
  context: UserContext,
  workItemId: string,
): Promise<{ runId: string }> {
  const prepared = await withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      title: string;
      brief: string;
      ai_employee_id: string | null;
      department_id: string;
      assigned_by: string;
      status: WorkItemStatus;
      tier: string | null;
      model_config: Record<string, unknown> | null;
    }>(
      `select w.id, w.title, w.brief, w.ai_employee_id, w.department_id, w.assigned_by, w.status,
              w.input->>'tier' as tier,
              e.model_config
         from work_items w
         left join ai_employees e on e.id = w.ai_employee_id
        where w.id = $1`,
      [workItemId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("工作项不存在或无权访问");
    }

    const isOwner =
      row.assigned_by === context.userId ||
      context.accessLevel === "L1" ||
      context.accessLevel === "L2";
    if (!isOwner) {
      throw new PermissionDeniedError({ allowed: false, reason: "只有派发人或部门负责人可以重跑" });
    }

    await requireContextPermission(client, context, "skill:use", {
      kind: "work_item",
      id: row.id,
      departmentId: row.department_id,
    });

    if (!["returned", "failed", "cancelled"].includes(row.status)) {
      throw new Error("只有已退回 / 失败 / 取消的工作项可以重跑");
    }
    if (!row.ai_employee_id) {
      throw new Error("该工作项绑定的 AI 员工已被移除，无法重跑");
    }

    const tierRaw = row.model_config ? row.model_config.tier : row.tier;
    return {
      id: row.id,
      title: row.title,
      brief: row.brief,
      aiEmployeeId: row.ai_employee_id,
      departmentId: row.department_id,
      tier: tierRaw === "fast" ? "fast" : "deep",
      review: parseReviewConfig(row.model_config),
    };
  });

  const accepted = await acceptRun(context, {
    kind: "task",
    input: {
      workItemId: prepared.id,
      question: prepared.brief,
      title: prepared.title,
      modelTier: prepared.tier,
    },
    aiEmployeeId: prepared.aiEmployeeId,
    clientTurnId: `rerun-${prepared.id}-${Date.now()}`,
    title: prepared.title,
  });

  await withUserContext(context, async (client) => {
    await client.query(
      `update work_items
          set current_run_id = $2,
              status = 'queued',
              input = input || jsonb_build_object(
                'tier', $3::text,
                'review', jsonb_build_object('mode', $4::text, 'minChars', $5::int)
              ),
              deliverable = '{}'::jsonb,
              review_note = null,
              reviewed_by = null,
              reviewed_at = null,
              updated_at = now()
        where id = $1`,
      [prepared.id, accepted.runId, prepared.tier, prepared.review.mode, prepared.review.minChars],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "work_item.rerun",
      targetType: "work_item",
      targetId: prepared.id,
      departmentId: prepared.departmentId,
      payload: { run_id: accepted.runId },
    });
  });

  return { runId: accepted.runId };
}

export async function reviewWorkItem(
  context: UserContext,
  workItemId: string,
  decision: "approve" | "return",
  note?: string | null,
): Promise<void> {
  const trimmedNote = (note ?? "").trim().slice(0, 1000);

  await withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      department_id: string;
      assigned_by: string;
      status: WorkItemStatus;
    }>(
      `select id, department_id, assigned_by, status
         from work_items
        where id = $1`,
      [workItemId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("工作项不存在或无权访问");
    }

    const isReviewer =
      row.assigned_by === context.userId ||
      context.accessLevel === "L1" ||
      context.accessLevel === "L2";
    if (!isReviewer) {
      throw new PermissionDeniedError({ allowed: false, reason: "只有派发人或部门负责人可以验收" });
    }

    await requireContextPermission(client, context, "skill:use", {
      kind: "work_item",
      id: row.id,
      departmentId: row.department_id,
    });

    if (row.status !== "waiting_review") {
      throw new Error("只有待验收的工作项可以验收");
    }

    await client.query(
      `update work_items
          set status = $2::work_item_status,
              review_note = $3,
              reviewed_by = $4,
              reviewed_at = now(),
              updated_at = now()
        where id = $1`,
      [row.id, decision === "approve" ? "done" : "returned", trimmedNote || null, context.userId],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: decision === "approve" ? "work_item.approved" : "work_item.returned",
      targetType: "work_item",
      targetId: row.id,
      departmentId: row.department_id,
      payload: { note: trimmedNote || null },
    });
  });
}
