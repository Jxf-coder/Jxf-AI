/**
 * 自动化产线：定义 + 派活 + 链式推进。
 *
 * 设计边界：
 * - 产线是「一组派活步骤」的模板，不新增执行引擎；每一步复用 assignWork，
 *   生成 work_item + kind='task' 的 run，沿用现有 worker 队列与人工验收；
 * - 运行一次只派出第一步，之后由上一步的结果驱动下一步（宿主机 runner 推进），
 *   这样后续步骤可以引用上一步交付物；
 * - 某一步失败时停止后续步骤；标记 optional 的步骤失败则跳过并继续；
 * - 产线可设置定时（间隔分钟数），由 runner 到点自动发起运行。
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
  /** 可选步骤：失败时跳过并继续后续步骤，而不是整条产线停止 */
  optional?: boolean;
}

export interface PipelineView {
  id: string;
  name: string;
  description: string;
  steps: PipelineStep[];
  enabled: boolean;
  /** 定时触发间隔（分钟）；null = 只手动触发 */
  scheduleIntervalMinutes: number | null;
  lastScheduledAt: string | null;
  /** 外部 Webhook 是否可用（令牌只存哈希，页面只显示末 4 位） */
  webhookEnabled: boolean;
  webhookTokenHint: string | null;
  /** 已订阅的内部事件类型 */
  eventTypes: string[];
  createdAt: string;
}

export type PipelineRunStatus = "running" | "waiting_review" | "done" | "partial";

export type PipelineTriggerKind = "manual" | "schedule" | "webhook" | "event";

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
  /** 因失败被跳过的可选步骤 */
  skippedSteps: string[];
  /** manual / schedule / webhook / event */
  triggerKind: PipelineTriggerKind;
  /** 触发来源摘要（webhook 请求摘要 / 事件 ID） */
  triggerRef: string | null;
  status: PipelineRunStatus;
  createdAt: string;
}

export interface CreatePipelineInput {
  name: string;
  description?: string;
  scheduleIntervalMinutes?: number | null;
  steps: Array<{ title: string; brief: string; aiEmployeeId: string; aiEmployeeName: string; optional?: boolean }>;
}

export const MAX_STEPS = 10;
export const MIN_SCHEDULE_MINUTES = 5;
export const MAX_SCHEDULE_MINUTES = 10_080;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PipelineRow {
  id: string;
  name: string;
  description: string;
  steps: PipelineStep[] | null;
  enabled: boolean;
  schedule_interval_minutes: number | null;
  last_scheduled_at: Date | null;
  webhook_enabled: boolean;
  webhook_token_hint: string | null;
  event_types?: string[] | null;
  created_at: Date;
}

interface PipelineRunRow {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  work_item_ids: string[] | null;
  failed_step: string | null;
  skipped_steps: string[] | null;
  trigger_kind: string;
  trigger_ref: string | null;
  created_at: Date;
  active_count: number;
  review_count: number;
  done_count: number;
  failed_count: number;
}

const PIPELINE_COLUMNS = `id, name, description, steps, enabled,
       schedule_interval_minutes, last_scheduled_at,
       webhook_enabled, webhook_token_hint, created_at`;

const TRIGGER_KINDS: readonly PipelineTriggerKind[] = ["manual", "schedule", "webhook", "event"];

function toTriggerKind(raw: string): PipelineTriggerKind {
  return (TRIGGER_KINDS as readonly string[]).includes(raw)
    ? (raw as PipelineTriggerKind)
    : "manual";
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
    scheduleIntervalMinutes: row.schedule_interval_minutes ?? null,
    lastScheduledAt: row.last_scheduled_at ? row.last_scheduled_at.toISOString() : null,
    webhookEnabled: Boolean(row.webhook_enabled),
    webhookTokenHint: row.webhook_token_hint ?? null,
    eventTypes: Array.isArray(row.event_types) ? row.event_types : [],
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
  // 可选步骤失败已被跳过并继续，不应把整条产线判定为有失败
  const skipped = row.skipped_steps?.length ?? 0;
  const effectiveFailed = Math.max(row.failed_count - skipped, 0);
  if (row.failed_step || effectiveFailed > 0) {
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
      optional: step?.optional === true,
    };
  });
}

/** 定时间隔：null = 不定时；数字必须在 5–10080 分钟之间 */
function normalizeSchedule(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < MIN_SCHEDULE_MINUTES || minutes > MAX_SCHEDULE_MINUTES) {
    throw new PipelineInputError(
      `定时间隔必须是 ${MIN_SCHEDULE_MINUTES}–${MAX_SCHEDULE_MINUTES} 之间的整数分钟`,
    );
  }
  return minutes;
}

export async function listPipelines(context: UserContext): Promise<PipelineView[]> {
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "pipeline:use", departmentResource(context));
    const { rows } = await client.query<PipelineRow>(
      `select p.id, p.name, p.description, p.steps, p.enabled,
              p.schedule_interval_minutes, p.last_scheduled_at,
              p.webhook_enabled, p.webhook_token_hint, p.created_at,
              coalesce(
                array_agg(s.event_type) filter (where s.enabled),
                '{}'::text[]
              ) as event_types
         from pipelines p
         left join pipeline_event_subscriptions s on s.pipeline_id = p.id
        where p.tenant_id = $1
        group by p.id
        order by p.created_at desc
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
  const scheduleIntervalMinutes = normalizeSchedule(input.scheduleIntervalMinutes);
  const departmentId = context.activeDepartmentId;
  if (!departmentId) {
    throw new PipelineInputError("当前账号没有有效部门上下文");
  }

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "pipeline:manage", departmentResource(context));
    const { rows } = await client.query<PipelineRow>(
      `insert into pipelines
         (tenant_id, department_id, name, description, steps, schedule_interval_minutes, created_by)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7)
       returning ${PIPELINE_COLUMNS}`,
      [
        context.tenantId,
        departmentId,
        name,
        description,
        JSON.stringify(steps),
        scheduleIntervalMinutes,
        context.userId,
      ],
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

export type PipelineTrigger = PipelineTriggerKind;

export interface PipelineRunResult {
  runId: string;
  pipelineName: string;
  workItemIds: string[];
  failedStep: string | null;
  /** 下一个待派步骤下标；等于步骤总数表示已全部派出 */
  nextStepIndex: number;
  trigger: PipelineTrigger;
}

export interface RunPipelineOptions {
  trigger?: PipelineTrigger;
  /** 触发来源摘要（Webhook 请求摘要 / 事件 ID），落库便于追溯 */
  triggerRef?: string | null;
}

export async function runPipeline(
  context: UserContext,
  pipelineId: string,
  options: RunPipelineOptions = {},
): Promise<PipelineRunResult> {
  const trigger: PipelineTrigger = TRIGGER_KINDS.includes(options.trigger as PipelineTrigger)
    ? (options.trigger as PipelineTrigger)
    : "manual";
  const triggerRef = options.triggerRef?.slice(0, 200) || null;
  const pipeline = await withUserContext(context, async (client: PoolClient) => {
    await requireContextPermission(client, context, "pipeline:use", departmentResource(context));
    const { rows } = await client.query<PipelineRow>(
      `select ${PIPELINE_COLUMNS}
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

  const steps = pipeline.steps ?? [];
  const first = steps[0];
  const workItemIds: string[] = [];
  let failedStep: string | null = null;

  // 只派第一步：后续步骤等上一步结束后由 runner 推进，便于引用上一步产物
  try {
    const assigned = await assignWork(context, {
      title: first.title,
      brief: first.brief,
      aiEmployeeId: first.aiEmployeeId,
    });
    workItemIds.push(assigned.workItemId);
  } catch {
    failedStep = first.title;
  }

  const nextStepIndex = failedStep ? 0 : 1;

  const run = await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "pipeline:use", departmentResource(context));
    const departmentId = context.activeDepartmentId ?? null;
    if (!departmentId) {
      throw new PipelineInputError("当前账号没有有效部门上下文");
    }
    const { rows } = await client.query<{ id: string }>(
      `insert into pipeline_runs
         (pipeline_id, tenant_id, department_id, work_item_ids, failed_step,
          trigger_kind, trigger_ref, next_step_index, finished_at, requested_by)
       values ($1, $2, $3, $4::uuid[], $5, $6, $7, $8, case when $9 then now() else null end, $10)
       returning id`,
      [
        pipeline.id,
        context.tenantId,
        departmentId,
        workItemIds,
        failedStep,
        trigger,
        triggerRef,
        nextStepIndex,
        failedStep !== null,
        context.userId,
      ],
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
        trigger,
        trigger_ref: triggerRef,
      },
    });
    return runId;
  });

  return { runId: run, pipelineName: pipeline.name, workItemIds, failedStep, nextStepIndex, trigger };
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
              r.failed_step, r.skipped_steps, r.trigger_kind, r.trigger_ref, r.created_at,
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
      skippedSteps: row.skipped_steps ?? [],
      triggerKind: toTriggerKind(row.trigger_kind),
      triggerRef: row.trigger_ref ?? null,
      status: runStatus(row),
      createdAt: row.created_at.toISOString(),
    }));
  });
}
