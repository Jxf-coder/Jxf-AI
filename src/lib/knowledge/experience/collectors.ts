/**
 * 通道适配：把产线终态与技能失败整理成「来源文本」并入队；人工复盘由 retro.ts 直接入队。
 *
 * 只读产线与工作项，不直接写卡；真正的提炼由 worker 异步完成。
 * 来源文本包含：产线名、触发方式、失败步骤、步骤定义、各工作项状态 / 验收备注 / 交付摘要，
 * 让模型能引用失败步骤原文与验收备注作为逐字证据。
 */

import { errorMessage, log } from "@/lib/logger";

import { enqueueExperience, type EnqueueResult, type Queryable } from "./capture";
import { readExperiencePolicy } from "./policy";

const DELIVERABLE_MAX_CHARS = 800;

interface PipelineStepSnapshot {
  title?: string;
  brief?: string;
}

interface WorkItemRow {
  id: string;
  title: string;
  brief: string;
  status: string;
  review_note: string | null;
  text: string;
}

export interface PipelineSourceInput {
  pipelineName: string;
  triggerKind: string;
  failedStep: string | null;
  skippedSteps: string[];
  steps: PipelineStepSnapshot[];
  workItems: WorkItemRow[];
  /** 成功终态：仅在开启「成功后自动沉淀」时使用 */
  success?: boolean;
}

export function buildPipelineSourceText(input: PipelineSourceInput): string {
  const terminal = input.success
    ? "成功"
    : input.failedStep
      ? `失败于「${input.failedStep}」`
      : "部分步骤失败";
  const lines: string[] = [
    `产线：${input.pipelineName}`,
    `触发方式：${input.triggerKind}`,
    `终态：${terminal}`,
  ];
  if (input.failedStep) {
    lines.push(`失败步骤：${input.failedStep}`);
  }
  if (input.skippedSteps.length > 0) {
    lines.push(`被跳过的可选步骤：${input.skippedSteps.join("、")}`);
  }

  if (input.steps.length > 0) {
    lines.push("", "步骤定义：");
    input.steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${step.title ?? ""} — ${step.brief ?? ""}`);
    });
  }

  if (input.workItems.length > 0) {
    lines.push("", "工作项：" );
    for (const item of input.workItems) {
      lines.push(`- ${item.title}｜状态：${item.status}`);
      if (item.review_note) {
        lines.push(`  验收备注：${item.review_note}`);
      }
      if (item.text.trim()) {
        lines.push(`  交付摘要：${item.text.trim().slice(0, DELIVERABLE_MAX_CHARS)}`);
      }
    }
  }

  return lines.join("\n");
}

interface PipelineRunRow {
  id: string;
  tenant_id: string;
  department_id: string;
  failed_step: string | null;
  skipped_steps: string[] | null;
  trigger_kind: string;
  finished_at: Date | null;
  work_item_ids: string[] | null;
  pipeline_id: string;
  name: string;
  steps: PipelineStepSnapshot[] | null;
}

/**
 * 采集一条产线运行。
 * - 仅在 failed_step 非空，或存在未被跳过的失败 / 退回工作项时入队；
 * - 同一 run 的重复调用由唯一索引 / 指纹合并，不会重复产卡。
 */
export async function capturePipelineRunExperience(
  client: Queryable,
  runId: string,
): Promise<EnqueueResult | null> {
  const runResult = await client.query(
    `select r.id, r.tenant_id, r.department_id, r.failed_step, r.skipped_steps,
            r.trigger_kind, r.finished_at, r.work_item_ids,
            p.id as pipeline_id, p.name, p.steps
       from pipeline_runs r
       join pipelines p on p.id = r.pipeline_id
      where r.id = $1`,
    [runId],
  );
  const run = runResult.rows[0] as unknown as PipelineRunRow | undefined;
  if (!run) {
    return null;
  }

  const ids = run.work_item_ids ?? [];
  const itemResult =
    ids.length > 0
      ? await client.query(
          `select id, title, brief, status::text as status, review_note,
                  coalesce(deliverable->>'text', '') as text
             from work_items
            where id = any($1::uuid[])
            order by created_at`,
          [ids],
        )
      : { rows: [] };
  const workItems = itemResult.rows as unknown as WorkItemRow[];
  const skippedSteps = run.skipped_steps ?? [];
  const failedItems = workItems.filter((item) =>
    ["failed", "cancelled", "returned"].includes(item.status),
  );

  const hasFailure = Boolean(run.failed_step) || failedItems.length > 0;
  // 可选步骤失败已被跳过并继续：不算产线失败
  const onlySkippedOptional =
    !run.failed_step &&
    skippedSteps.length > 0 &&
    failedItems.every((item) => skippedSteps.includes(item.title));

  if (!hasFailure || onlySkippedOptional) {
    // 成功（或仅可选步骤失败）默认不沉淀；开启「成功后自动沉淀」才入队
    const policy = await readExperiencePolicy(client);
    if (!policy.autoCaptureSuccess) {
      return null;
    }
    return enqueueExperience(client, {
      tenantId: run.tenant_id,
      departmentId: run.department_id,
      channel: "pipeline",
      sourceType: "pipeline_success",
      sourceId: run.id,
      sourceVersion: `success|${run.finished_at ? run.finished_at.toISOString() : "open"}`,
      title: `${run.name} · 产线成功`,
      text: buildPipelineSourceText({
        pipelineName: run.name,
        triggerKind: run.trigger_kind,
        failedStep: null,
        skippedSteps,
        steps: Array.isArray(run.steps) ? run.steps : [],
        workItems,
        success: true,
      }),
      signalLevel: 1,
      meta: {
        pipelineId: run.pipeline_id,
        pipelineName: run.name,
        triggerKind: run.trigger_kind,
        workItemIds: ids,
        success: true,
      },
    });
  }

  const text = buildPipelineSourceText({
    pipelineName: run.name,
    triggerKind: run.trigger_kind,
    failedStep: run.failed_step,
    skippedSteps,
    steps: Array.isArray(run.steps) ? run.steps : [],
    workItems,
  });

  return enqueueExperience(client, {
    tenantId: run.tenant_id,
    departmentId: run.department_id,
    channel: "pipeline",
    sourceType: "pipeline_run",
    sourceId: run.id,
    sourceVersion: `${run.finished_at ? run.finished_at.toISOString() : "open"}|${run.failed_step ?? "partial"}`,
    title: run.name,
    text,
    step: run.failed_step,
    signalLevel: 3,
    meta: {
      pipelineId: run.pipeline_id,
      pipelineName: run.name,
      failedStep: run.failed_step,
      skippedSteps,
      triggerKind: run.trigger_kind,
      workItemIds: ids,
    },
  });
}

/**
 * 宿主机 runner 使用：owner 连接不在事务里，这里显式开事务，
 * 保证 advisory lock 与插入在同一事务内生效；采集失败不影响产线推进。
 */
export async function capturePipelineRunExperienceSafe(
  client: Queryable,
  runId: string,
): Promise<void> {
  try {
    await client.query("begin");
    const result = await capturePipelineRunExperience(client, runId);
    await client.query("commit");
    if (result?.jobId) {
      log("info", "experience_job_enqueued", {
        job_id: result.jobId,
        merged: result.merged,
        run_id: runId,
      });
    }
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    log("warn", "experience_capture_failed", {
      run_id: runId,
      error: errorMessage(error),
    });
  }
}

export interface SkillSourceInput {
  skillName: string | null;
  skillKey: string;
  error: string | null;
  input: Record<string, unknown> | null;
}

export function buildSkillSourceText(input: SkillSourceInput): string {
  const name = input.skillName?.trim() || input.skillKey;
  const payload =
    input.input && Object.keys(input.input).length > 0
      ? JSON.stringify(input.input, null, 2)
      : "（无输入）";
  return [
    `技能：${name}（${input.skillKey}）`,
    "执行方式：提示词",
    `失败原因：${input.error?.trim() || "未记录"}`,
    "输入：",
    payload,
  ].join("\n");
}

interface SkillRunRow {
  id: string;
  tenant_id: string;
  department_id: string;
  skill_key: string;
  error: string | null;
  finished_at: Date | null;
  skill_name: string | null;
  input: Record<string, unknown> | null;
}

/**
 * 采集一条失败的技能执行。
 * - 只处理 status='failed'，成功执行默认不沉淀；
 * - 来源文本包含技能名、失败原因与输入，供模型引用为逐字证据。
 */
export async function captureSkillRunExperience(
  client: Queryable,
  runId: string,
): Promise<EnqueueResult | null> {
  const result = await client.query(
    `select r.id, r.tenant_id, r.department_id, r.skill_key, r.error, r.finished_at,
            r.input, s.name as skill_name
       from skill_runs r
       left join skills s on s.id = r.skill_id
      where r.id = $1 and r.status = 'failed'`,
    [runId],
  );
  const run = result.rows[0] as unknown as SkillRunRow | undefined;
  if (!run) {
    return null;
  }

  const title = `${run.skill_name?.trim() || run.skill_key} · 技能执行失败`;
  return enqueueExperience(client, {
    tenantId: run.tenant_id,
    departmentId: run.department_id,
    channel: "skill",
    sourceType: "skill_run",
    sourceId: run.id,
    sourceVersion: run.finished_at ? run.finished_at.toISOString() : "failed",
    title,
    text: buildSkillSourceText({
      skillName: run.skill_name,
      skillKey: run.skill_key,
      error: run.error,
      input: run.input,
    }),
    errorType: "skill_run_failed",
    signalLevel: 3,
    meta: {
      skillKey: run.skill_key,
      skillRunId: run.id,
    },
  });
}
