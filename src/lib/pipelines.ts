/**
 * 自动化产线（最小可用切片）：办产线定义 + 批量派活。
 *
 * 设计边界：
 * - 产线是「一组派活步骤」的模板，不新增执行引擎；每一步复用 assignWork，
 *   生成 work_item + kind='task' 的 run，沿用现有 worker 队列与人工验收；
 * - 运行一次 = 按顺序为每一步派活；某一步失败时停止后续步骤，已派出的工作保留；
 * - 产线定义可编辑/停用；运行记录只追加，状态由工作项实时聚合。
 */

import type { PoolClient } from "pg";

import { auditInTx } from "@/lib/audit";
import { withUserContext, type UserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";
import type { PermissionResource } from "@/types/permission";
import { assignWork } from "@/lib/work-items";

export class PipelineInputError extends Error {}

export interface PipelineStep {
  title: string;
  brief: string;
  aiEmployeeId: string;
  /** 员工名称快照：员工改名/停用后仍能展示当时的产线定义 */
  aiEmployeeName: string;
}

export interface PipelineView {
  id: string;
  name: string;
  description: string;
  steps: PipelineStep[];
  enabled: boolean;
  createdAt: string;
}

export type PipelineRunStatus = "running" | "waiting_review" | "done" | "partial";

export interface PipelineRunView {
  id: string;
  pipelineId: string;
  pipelineName: string;
  workItemIds: string[];
  activeCount: number;
  reviewCount: number;
  doneCount: number;
  failedCount: number;
  failedStep: string | null;
  status: PipelineRunStatus;
  createdAt: string;
}

export interface CreatePipelineInput {
  name: string;
  description?: string;
  steps: Array<{ title: string; brief: string; aiEmployeeId: string; aiEmployeeName: string }>;
}

const MAX_STEPS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PipelineRow {
  id: string;
  name: string;
  description: string;
  steps: PipelineStep[] | null;
  enabled: boolean;
  created_at: Date;
}

interface PipelineRunRow {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  work_item_ids: string[] | null;
  failed_step: string | null;
  created_at: Date;
  active_count: number;
  review_count: number;
  done_count: number;
  failed_count: number;
}

function departmentResource(context: UserContext): PermissionResource {
  const departmentId = context.activeDepartmentId;
  return { kind: "department", id: departmentId ?? undefined, departmentId };
}

function toPipelineView(row: PipelineRow): PipelineView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    steps: Array.isArray(row.steps) ? row.steps : [],
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
  };
}

function runStatus(row: PipelineRunRow): PipelineRunStatus {
  if (row.active_count > 0) {
    return "running";
  }
  if (row.review_count > 0) {
    return "waiting_review";
  }
  if (row.failed_step || row.failed_count > 0) {
    return "partial";
  }
  return "done";
}

function normalizeSteps(raw: CreatePipelineInput["steps"]): PipelineStep[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PipelineInputError("产线至少需要一步");
  }
  if (raw.length > MAX_STEPS) {
    throw new PipelineInputError(`产线最多 ${MAX_STEPS} 步`);
  }
  return raw.map((step, index) => {
    const title = String(step?.title ?? "").trim();
    const brief = String(step?.brief ?? "").trim();
    const aiEmployeeId = String(step?.aiEmployeeId ?? "").trim();
    const aiEmployeeName = String(step?.aiEmployeeName ?? "").trim();
    if (!title || title.length > 80) {
      throw new PipelineInputError(`第 ${index + 1} 步标题不能为空且不超过 80 字`);
    }
    if (!brief || brief.length > 2000) {
      throw new PipelineInputError(`第 ${index + 1} 步说明不能为空且不超过 2000 字`);
    }
    if (!UUID.test(aiEmployeeId)) {
      throw new PipelineInputError(`第 ${index + 1} 步未选择有效的 AI 员工`);
    }
    return {
      title,
      brief,
      aiEmployeeId,
      aiEmployeeName: aiEmployeeName.slice(0, 60) || "AI 员工",
    };
  });
}

export async function listPipelines(context: UserContext): Promise<PipelineView[]> {
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "pipeline:use", departmentResource(context));
    const { rows } = await client.query<PipelineRow>(
      `select id, name, description, steps, enabled, created_at
         from pipelines
        where tenant_id = $1
        order by created_at desc
        limit 50`,
      [context.tenantId],
    );
    return rows.map(toPipelineView);
  });
}

export async function createPipeline(
  context: UserContext,
  input: CreatePipelineInput,
): Promise<PipelineView> {
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 60) {
    throw new PipelineInputError("产线名称不能为空且不超过 60 字");
  }
  const description = String(input.description ?? "").trim();
  if (description.length > 300) {
    throw new PipelineInputError("产线说明不能超过 300 字");
  }
  const steps = normalizeSteps(input.steps);
  const departmentId = context.activeDepartmentId;
  if (!departmentId) {
    throw new PipelineInputError("当前账号没有有效部门上下文");
  }

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "pipeline:manage", departmentResource(context));
    const { rows } = await client.query<PipelineRow>(
      `insert into pipelines (tenant_id, department_id, name, description, steps, created_by)
       values ($1, $2, $3, $4, $5::jsonb, $6)
       returning id, name, description, steps, enabled, created_at`,
      [context.tenantId, departmentId, name, description, JSON.stringify(steps), context.userId],
    );
    const row = rows[0];
    if (!row) {
      throw new PipelineInputError("产线创建失败");
    }
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "pipeline.created",
      targetType: "pipeline",
      targetId: row.id,
      departmentId,
      payload: { name, step_count: steps.length },
    });
    return toPipelineView(row);
  });
}

export async function setPipelineEnabled(
  context: UserContext,
  pipelineId: string,
  enabled: boolean,
): Promise<void> {
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "pipeline:manage", departmentResource(context));
    const updated = await client.query(
      `update pipelines
          set enabled = $3, updated_at = now()
        where id = $1 and tenant_id = $2`,
      [pipelineId, context.tenantId, enabled],
    );
    if (updated.rowCount === 0) {
      throw new PipelineInputError("产线不存在或无权操作");
    }
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: enabled ? "pipeline.enabled" : "pipeline.disabled",
      targetType: "pipeline",
      targetId: pipelineId,
      departmentId: context.activeDepartmentId,
    });
  });
}

export interface PipelineRunResult {
  runId: string;
  workItemIds: string[];
  failedStep: string | null;
}

export async function runPipeline(
  context: UserContext,
  pipelineId: string,
): Promise<PipelineRunResult> {
  const pipeline = await withUserContext(context, async (client: PoolClient) => {
    await requireContextPermission(client, context, "pipeline:use", departmentResource(context));
    const { rows } = await client.query<PipelineRow>(
      `select id, name, description, steps, enabled, created_at
         from pipelines
        where id = $1 and tenant_id = $2`,
      [pipelineId, context.tenantId],
    );
    const row = rows[0];
    if (!row) {
      throw new PipelineInputError("产线不存在或无权操作");
    }
    if (!row.enabled) {
      throw new PipelineInputError("产线已停用，请先启用");
    }
    if (!Array.isArray(row.steps) || row.steps.length === 0) {
      throw new PipelineInputError("产线没有可执行的步骤");
    }
    return row;
  });

  const workItemIds: string[] = [];
  let failedStep: string | null = null;

  for (const step of pipeline.steps ?? []) {
    try {
      const assigned = await assignWork(context, {
        title: step.title,
        brief: step.brief,
        aiEmployeeId: step.aiEmployeeId,
      });
      workItemIds.push(assigned.workItemId);
    } catch {
      failedStep = step.title;
      break;
    }
  }

  const run = await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "pipeline:use", departmentResource(context));
    const departmentId = context.activeDepartmentId ?? null;
    if (!departmentId) {
      throw new PipelineInputError("当前账号没有有效部门上下文");
    }
    const { rows } = await client.query<{ id: string }>(
      `insert into pipeline_runs
         (pipeline_id, tenant_id, department_id, work_item_ids, failed_step, requested_by)
       values ($1, $2, $3, $4::uuid[], $5, $6)
       returning id`,
      [pipeline.id, context.tenantId, departmentId, workItemIds, failedStep, context.userId],
    );
    const runId = rows[0]?.id;
    if (!runId) {
      throw new PipelineInputError("产线运行记录写入失败");
    }
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "pipeline.run",
      targetType: "pipeline_run",
      targetId: runId,
      departmentId,
      payload: {
        pipeline_id: pipeline.id,
        pipeline_name: pipeline.name,
        created: workItemIds.length,
        failed_step: failedStep,
      },
    });
    return runId;
  });

  return { runId: run, workItemIds, failedStep };
}

export async function listPipelineRuns(
  context: UserContext,
  limit = 10,
): Promise<PipelineRunView[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "pipeline:use", departmentResource(context));
    const { rows } = await client.query<PipelineRunRow>(
      `select r.id, r.pipeline_id, p.name as pipeline_name, r.work_item_ids,
              r.failed_step, r.created_at,
              coalesce(sum(case when wi.status in ('queued', 'running') then 1 else 0 end), 0)::int as active_count,
              coalesce(sum(case when wi.status = 'waiting_review' then 1 else 0 end), 0)::int as review_count,
              coalesce(sum(case when wi.status = 'done' then 1 else 0 end), 0)::int as done_count,
              coalesce(sum(case when wi.status in ('failed', 'cancelled', 'returned') then 1 else 0 end), 0)::int as failed_count
         from pipeline_runs r
         join pipelines p on p.id = r.pipeline_id
         left join work_items wi on wi.id = any(r.work_item_ids)
        where r.tenant_id = $1
        group by r.id, p.name
        order by r.created_at desc
        limit $2`,
      [context.tenantId, safeLimit],
    );
    return rows.map((row) => ({
      id: row.id,
      pipelineId: row.pipeline_id,
      pipelineName: row.pipeline_name,
      workItemIds: row.work_item_ids ?? [],
      activeCount: row.active_count,
      reviewCount: row.review_count,
      doneCount: row.done_count,
      failedCount: row.failed_count,
      failedStep: row.failed_step,
      status: runStatus(row),
      createdAt: row.created_at.toISOString(),
    }));
  });
}
