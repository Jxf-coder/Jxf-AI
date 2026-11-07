/**
 * 产线推进器（宿主机 runner 使用）。
 *
 * 手动/定时触发只派第一步；本模块在每一步结束后推进下一步：
 *   - 上一步 done / waiting_review → 派下一步，`{{previous}}` 替换为上一步交付文本；
 *   - 上一步 failed / returned / cancelled → 可选步骤跳过并继续，否则整条产线标记失败；
 *   - 上一步仍在 queued / running → 本轮不动。
 *
 * 运行在 owner 连接上：读运行记录与工作项状态不需要用户上下文；
 * 真正派活仍走 assignWork（jxf_app + RLS），使用产线发起人的上下文。
 */

import type { Client } from "pg";

import { errorMessage } from "@/lib/logger";
import type { UserContext } from "@/lib/db/user-context";
import { assignWork } from "@/lib/work-items";

import { runPipeline, type PipelineStep } from "./pipelines";

const PREVIOUS_TOKEN = "{{previous}}";
const PREVIOUS_MAX_CHARS = 1500;

export interface PipelineActorResolver {
  resolveContext(userId: string): Promise<UserContext>;
}

interface AdvanceRow {
  id: string;
  pipeline_id: string;
  tenant_id: string;
  department_id: string;
  work_item_ids: string[] | null;
  next_step_index: number;
  skipped_steps: string[] | null;
  pipeline_name: string;
  steps: PipelineStep[] | null;
  actor_id: string | null;
}

interface WorkItemState {
  status: string;
  text: string | null;
}

export interface AdvanceOutcome {
  runId: string;
  pipelineId: string;
  pipelineName: string;
  action: "waiting" | "dispatched" | "skipped" | "failed" | "completed";
  step: string | null;
  failedStep: string | null;
  error: string | null;
}

export interface AdvanceOptions {
  /** 只推进指定运行（测试或定向重试） */
  runIds?: string[];
  limit?: number;
}

/** 把上一步交付文本填进 `{{previous}}`；没有产物时给出显式说明，不编造内容 */
export function applyPrevious(brief: string, previousText: string | null): string {
  if (!brief.includes(PREVIOUS_TOKEN)) {
    return brief.slice(0, 4000);
  }
  const value = (previousText ?? "").trim();
  const clipped = value ? value.slice(0, PREVIOUS_MAX_CHARS) : "（上一步没有可用交付物）";
  return brief.split(PREVIOUS_TOKEN).join(clipped).slice(0, 4000);
}

async function markFinished(owner: Client, runId: string, failedStep: string | null): Promise<void> {
  await owner.query(
    `update pipeline_runs
        set failed_step = $2, finished_at = now()
      where id = $1`,
    [runId, failedStep],
  );
}

async function loadWorkItem(owner: Client, workItemId: string): Promise<WorkItemState | null> {
  const { rows } = await owner.query<{ status: string; text: string | null }>(
    `select status, deliverable->>'text' as text from work_items where id = $1`,
    [workItemId],
  );
  return rows[0] ?? null;
}

async function recordDispatch(
  owner: Client,
  row: AdvanceRow,
  step: PipelineStep,
  workItemId: string,
): Promise<void> {
  await owner.query(
    `insert into audit_events
       (tenant_id, actor_user_id, department_id, action, target_type, target_id, payload)
     values ($1, $2, $3, 'pipeline.step_dispatched', 'pipeline_run', $4, $5::jsonb)`,
    [
      row.tenant_id,
      row.actor_id,
      row.department_id,
      row.id,
      JSON.stringify({
        pipeline_id: row.pipeline_id,
        pipeline_name: row.pipeline_name,
        step: step.title,
        work_item_id: workItemId,
        index: row.next_step_index,
      }),
    ],
  );
}

/** 推进所有未完成的产线运行；返回本轮每条运行的处理结果 */
export async function advancePipelineRuns(
  owner: Client,
  hooks: PipelineActorResolver,
  options: AdvanceOptions = {},
): Promise<AdvanceOutcome[]> {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const params: unknown[] = [];
  let filter = "";
  if (options.runIds && options.runIds.length > 0) {
    params.push(options.runIds);
    filter = `and r.id = any($1::uuid[])`;
  }
  params.push(limit);

  const { rows } = await owner.query<AdvanceRow>(
    `select r.id, r.pipeline_id, r.tenant_id, r.department_id, r.work_item_ids,
            r.next_step_index, r.skipped_steps,
            p.name as pipeline_name, p.steps,
            coalesce(r.requested_by, p.created_by) as actor_id
       from pipeline_runs r
       join pipelines p on p.id = r.pipeline_id
      where r.finished_at is null
        ${filter}
      order by r.created_at
      limit $${params.length}`,
    params,
  );

  const outcomes: AdvanceOutcome[] = [];

  for (const row of rows) {
    const steps = Array.isArray(row.steps) ? row.steps : [];
    const nextIndex = row.next_step_index;
    const base = {
      runId: row.id,
      pipelineId: row.pipeline_id,
      pipelineName: row.pipeline_name,
    };

    if (steps.length === 0 || nextIndex <= 0) {
      await markFinished(owner, row.id, null);
      outcomes.push({ ...base, action: "completed", step: null, failedStep: null, error: null });
      continue;
    }
    if (nextIndex >= steps.length) {
      // 最后一步已派出：等工作项进入终态后收口
      const lastId = row.work_item_ids?.[nextIndex - 1];
      const lastState = lastId ? await loadWorkItem(owner, lastId) : null;
      const terminal =
        !lastState ||
        ["done", "waiting_review", "failed", "cancelled", "returned"].includes(lastState.status);
      if (terminal) {
        await owner.query("update pipeline_runs set finished_at = now() where id = $1", [row.id]);
        outcomes.push({ ...base, action: "completed", step: null, failedStep: null, error: null });
      } else {
        outcomes.push({
          ...base,
          action: "waiting",
          step: steps[steps.length - 1]?.title ?? null,
          failedStep: null,
          error: null,
        });
      }
      continue;
    }

    const currentStep = steps[nextIndex - 1];
    const nextStep = steps[nextIndex];
    const lastWorkItemId = row.work_item_ids?.[nextIndex - 1];
    if (!lastWorkItemId) {
      await markFinished(owner, row.id, currentStep.title);
      outcomes.push({
        ...base,
        action: "failed",
        step: currentStep.title,
        failedStep: currentStep.title,
        error: "上一步工作项缺失",
      });
      continue;
    }

    const state = await loadWorkItem(owner, lastWorkItemId);
    if (!state) {
      await markFinished(owner, row.id, currentStep.title);
      outcomes.push({
        ...base,
        action: "failed",
        step: currentStep.title,
        failedStep: currentStep.title,
        error: "上一步工作项不存在",
      });
      continue;
    }

    if (state.status === "queued" || state.status === "running" || state.status === "draft") {
      outcomes.push({ ...base, action: "waiting", step: currentStep.title, failedStep: null, error: null });
      continue;
    }

    const stepFailed = ["failed", "cancelled", "returned"].includes(state.status);
    if (stepFailed && currentStep.optional !== true) {
      await markFinished(owner, row.id, currentStep.title);
      outcomes.push({
        ...base,
        action: "failed",
        step: currentStep.title,
        failedStep: currentStep.title,
        error: `上一步状态为 ${state.status}`,
      });
      continue;
    }

    // 可选步骤失败：记入跳过清单，继续下一步（不引用上一步产物）
    const skippedSteps = stepFailed
      ? [...(row.skipped_steps ?? []), currentStep.title]
      : row.skipped_steps ?? [];

    if (!row.actor_id) {
      await markFinished(owner, row.id, nextStep.title);
      outcomes.push({
        ...base,
        action: "failed",
        step: nextStep.title,
        failedStep: nextStep.title,
        error: "产线没有发起人，无法派发下一步",
      });
      continue;
    }

    let workItemId: string;
    try {
      const context = await hooks.resolveContext(row.actor_id);
      if (!context.activeDepartmentId) {
        throw new Error("发起人已无有效任用");
      }
      const brief = applyPrevious(nextStep.brief, stepFailed ? null : state.text);
      const assigned = await assignWork(context, {
        title: nextStep.title,
        brief,
        aiEmployeeId: nextStep.aiEmployeeId,
      });
      workItemId = assigned.workItemId;
    } catch (caught) {
      const message = errorMessage(caught);
      await markFinished(owner, row.id, nextStep.title);
      outcomes.push({
        ...base,
        action: "failed",
        step: nextStep.title,
        failedStep: nextStep.title,
        error: message,
      });
      continue;
    }

    await owner.query(
      `update pipeline_runs
          set work_item_ids = array_append(work_item_ids, $2::uuid),
              next_step_index = $3,
              skipped_steps = $4::text[],
              failed_step = null,
              finished_at = null
        where id = $1`,
      [row.id, workItemId, nextIndex + 1, skippedSteps],
    );
    await recordDispatch(owner, row, nextStep, workItemId);

    outcomes.push({
      ...base,
      action: stepFailed ? "skipped" : "dispatched",
      step: nextStep.title,
      failedStep: null,
      error: null,
    });
  }

  return outcomes;
}

export interface ScheduledOutcome {
  pipelineId: string;
  pipelineName: string;
  runId: string | null;
  error: string | null;
}

/**
 * 定时触发：到点的产线发起一次运行。
 * 先占用本次窗口再执行，避免同一时间窗内重复触发（失败也要等下一个间隔）。
 */
export async function sweepScheduledPipelines(
  owner: Client,
  hooks: PipelineActorResolver,
  limit = 5,
): Promise<ScheduledOutcome[]> {
  const { rows } = await owner.query<{ id: string; name: string; created_by: string | null }>(
    `select id, name, created_by
       from pipelines
      where enabled
        and schedule_interval_minutes is not null
        and created_by is not null
        and (last_scheduled_at is null
             or last_scheduled_at <= now() - make_interval(mins => schedule_interval_minutes))
      order by last_scheduled_at nulls first
      limit $1`,
    [Math.min(Math.max(limit, 1), 20)],
  );

  const outcomes: ScheduledOutcome[] = [];
  for (const row of rows) {
    await owner.query(
      "update pipelines set last_scheduled_at = now(), updated_at = now() where id = $1",
      [row.id],
    );
    try {
      const context = await hooks.resolveContext(row.created_by as string);
      if (!context.activeDepartmentId) {
        throw new Error("发起人已无有效任用");
      }
      const result = await runPipeline(context, row.id, { trigger: "schedule" });
      outcomes.push({
        pipelineId: row.id,
        pipelineName: row.name,
        runId: result.runId,
        error: result.failedStep ? `首步派发失败：${result.failedStep}` : null,
      });
    } catch (caught) {
      outcomes.push({
        pipelineId: row.id,
        pipelineName: row.name,
        runId: null,
        error: errorMessage(caught),
      });
    }
  }
  return outcomes;
}
