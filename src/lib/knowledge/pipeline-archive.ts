/**
 * 产线交付物归档：产线声明了归档目录（03–08）后，运行收口时把交付物
 * 强制归档成一张 pending 卡，人工确认后才进入检索。
 *
 * 边界：
 * - 只读产线运行与工作项，不触发 LLM；
 * - 一张运行只产一张卡（dedupe_key = pipeline_run:<runId>），重复收口幂等；
 * - 证据用交付原文逐字片段，source_kind='run'，因此可走常规确认门槛；
 * - 归档目录来自产线声明，不走内容路由，避免交付物被打散。
 */

import { errorMessage, log } from "@/lib/logger";

import { normalizeForMatch } from "./evidence";
import { hashText } from "./experience/fingerprint";

export const PIPELINE_ARCHIVE_BODY_MAX = 4000;
const PIPELINE_ARCHIVE_ITEM_CHARS = 800;
const PIPELINE_ARCHIVE_NOTE_CHARS = 300;
const PIPELINE_ARCHIVE_QUOTE_CHARS = 200;
const PIPELINE_ARCHIVE_TITLE_MAX = 120;

export interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PipelineArchiveItem {
  title: string;
  status: string;
  text: string;
  reviewNote: string | null;
}

export function pipelineArchiveDedupeKey(runId: string): string {
  return `pipeline_run:${runId}`;
}

/** 归档卡类型：案例进 04，经验 / 复盘是叙述性内容，标准与模板按对象卡处理 */
export function pipelineArchiveKind(folder: string): string {
  if (folder === "04-cases") {
    return "case";
  }
  if (folder === "05-distill" || folder === "08-retro") {
    return "viewpoint";
  }
  return "object";
}

export function buildPipelineArchiveBody(input: {
  pipelineName: string;
  failedStep: string | null;
  items: PipelineArchiveItem[];
}): string {
  const lines = [
    `产线：${input.pipelineName}`,
    `收口：${input.failedStep ? `失败于「${input.failedStep}」` : "完成"}`,
    "",
    "交付物：",
  ];
  for (const item of input.items) {
    lines.push(`- ${item.title}｜状态：${item.status}`);
    lines.push(`  交付：${item.text.trim().slice(0, PIPELINE_ARCHIVE_ITEM_CHARS)}`);
    if (item.reviewNote && item.reviewNote.trim().length > 0) {
      lines.push(`  验收备注：${item.reviewNote.trim().slice(0, PIPELINE_ARCHIVE_NOTE_CHARS)}`);
    }
  }
  return lines.join("\n").slice(0, PIPELINE_ARCHIVE_BODY_MAX);
}

export function buildPipelineArchiveTitle(pipelineName: string): string {
  return `${pipelineName} · 交付归档`.slice(0, PIPELINE_ARCHIVE_TITLE_MAX);
}

interface PipelineArchiveRun {
  id: string;
  tenant_id: string;
  department_id: string;
  failed_step: string | null;
  work_item_ids: string[] | null;
  pipeline_id: string;
  name: string;
  archive_folder: string | null;
}

/** 归档一条产线运行；没有声明目录、没有交付物或已归档时返回 null */
export async function archivePipelineRunDeliverables(
  owner: Queryable,
  runId: string,
): Promise<string | null> {
  const runResult = await owner.query(
    `select r.id, r.tenant_id, r.department_id, r.failed_step, r.work_item_ids,
            p.id as pipeline_id, p.name, p.archive_folder
       from pipeline_runs r
       join pipelines p on p.id = r.pipeline_id
      where r.id = $1`,
    [runId],
  );
  const run = runResult.rows[0] as unknown as PipelineArchiveRun | undefined;
  if (!run || !run.archive_folder) {
    return null;
  }

  const ids = run.work_item_ids ?? [];
  if (ids.length === 0) {
    return null;
  }

  const itemResult = await owner.query(
    `select title, status::text as status, review_note,
            coalesce(deliverable->>'text', '') as text
       from work_items
      where id = any($1::uuid[])
      order by created_at`,
    [ids],
  );
  const items = (itemResult.rows as Array<{
    title: string;
    status: string;
    review_note: string | null;
    text: string;
  }>)
    .map((row) => ({
      title: row.title,
      status: row.status,
      text: row.text,
      reviewNote: row.review_note,
    }))
    .filter((item) => item.text.trim().length > 0);

  if (items.length === 0) {
    return null;
  }

  const title = buildPipelineArchiveTitle(run.name);
  const body = buildPipelineArchiveBody({
    pipelineName: run.name,
    failedStep: run.failed_step,
    items,
  });
  const dedupeKey = pipelineArchiveDedupeKey(run.id);
  const sourceRef = JSON.stringify({ pipelineRunId: run.id, pipelineId: run.pipeline_id });

  const inserted = await owner.query(
    `insert into knowledge_cards
       (tenant_id, department_id, kind, title, body, status, origin, human_edited, rev,
        folder_key, source_channel, source_ref, route_reason, route_confidence,
        suggested_folder, route_pending, dedupe_key)
     values ($1, $2, $3, $4, $5, 'pending', 'distill', false, 1,
             $6, 'pipeline', $7::jsonb, '产线收口强制归档', 1, $6, false, $8)
     on conflict (tenant_id, dedupe_key) where dedupe_key is not null do nothing
     returning id`,
    [
      run.tenant_id,
      run.department_id,
      pipelineArchiveKind(run.archive_folder),
      title,
      body,
      run.archive_folder,
      sourceRef,
      dedupeKey,
    ],
  );
  const cardId = inserted.rows[0]?.id as string | undefined;
  if (!cardId) {
    // 已归档过：保持幂等，不覆盖人工改过的内容
    return null;
  }

  // 证据取自交付原文，逐字可核对，因此 cards.ts 的确认门槛可直接通过
  const quote = body.slice(0, PIPELINE_ARCHIVE_QUOTE_CHARS);
  await owner.query(
    `insert into card_evidence
       (card_id, chunk_id, document_id, page_no, locator, quote, char_start, char_end,
        source_kind, source_ref, source_hash, quote_hash, context_excerpt, verified, verified_at)
     values ($1, null, null, null, '产线交付归档', $2, 0, $3, 'run', $4::jsonb, $5, $6, $7, true, now())
     on conflict do nothing`,
    [
      cardId,
      quote,
      quote.length,
      sourceRef,
      hashText(body),
      hashText(normalizeForMatch(quote)),
      body.slice(0, 1000),
    ],
  );

  return cardId;
}

/** runner 使用：owner 连接不在事务里，这里显式开事务；归档失败不影响产线收口 */
export async function archivePipelineRunDeliverablesSafe(
  owner: Queryable,
  runId: string,
): Promise<void> {
  try {
    await owner.query("begin");
    const cardId = await archivePipelineRunDeliverables(owner, runId);
    await owner.query("commit");
    if (cardId) {
      log("info", "pipeline_deliverables_archived", { run_id: runId, card_id: cardId });
    }
  } catch (error) {
    await owner.query("rollback").catch(() => undefined);
    log("warn", "pipeline_archive_failed", {
      run_id: runId,
      error: errorMessage(error),
    });
  }
}
