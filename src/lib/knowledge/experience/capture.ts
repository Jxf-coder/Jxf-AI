/**
 * 经验采集入口：只判断「值不值得入队」，不做 LLM。
 *
 * 顺序（与融合方案 5.7 / 5.8 一致）：
 *   去敏 → 头/关键段/尾截断 → 结构化指纹 → 冷却/24h 精确去重/近似去重 → 限流 → 写 experience_jobs。
 *
 * 约束：
 * - 来源文本不足 200 字不采（太短无法形成可核对的经验）；
 * - 指纹不含 channel：跨通道的同一故障只做 related_job_id 关联，不重复产卡；
 * - 手动通道使用 manual:<uuid> 桶，绕过冷却与滑动窗口，但仍计配额；
 * - 限流不拒绝入队，只把 not_before 推到下一小时，claim 时跳过，避免 worker 空转。
 */

import { randomUUID } from "node:crypto";

import { buildFingerprint } from "./fingerprint";
import { classifySimilarity, cooldownBucket, jaccardSimilarity, manualBucket } from "./dedupe";
import { redactText, redactValue } from "./redact";
import { truncateSourceText } from "./truncate";

export const MIN_SOURCE_CHARS = 200;
export const COOLDOWN_MINUTES = 60;
export const DEDUPE_WINDOW_HOURS = 24;
export const HOURLY_JOB_LIMIT = 20;

export type ExperienceChannel =
  | "document"
  | "skill"
  | "pipeline"
  | "review"
  | "retro"
  | "connector"
  | "manual";

export interface ExperienceDraft {
  tenantId: string;
  departmentId: string;
  channel: ExperienceChannel;
  /** pipeline_run / work_item_return / work_item_approve / ... */
  sourceType: string;
  sourceId: string;
  /** 同一来源对象的版本（run 终态时间 / 验收时间），用于唯一索引幂等 */
  sourceVersion: string;
  title: string;
  /** 原始来源文本；入队前统一去敏与截断，原文不落库 */
  text: string;
  step?: string | null;
  errorType?: string | null;
  statusCode?: string | number | null;
  /** 结构化摘要（会递归去敏） */
  meta?: Record<string, unknown>;
  /** 手动触发：跳过冷却与滑动窗口 */
  manual?: boolean;
}

export interface EnqueueResult {
  jobId: string | null;
  /** 命中已有 job（冷却 / 精确 / 近似 / 唯一索引） */
  merged: boolean;
  reason?: string;
}

/** 最小可执行查询接口：同时适配 PoolClient / Client / Pool */
export interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PreparedSourceText {
  text: string;
  truncated: boolean;
  originalChars: number;
  omittedChars: number;
}

/** 去敏一次、三处复用：LLM 输入、证据校验、人工工作台展示 */
export function prepareExperienceText(raw: string): PreparedSourceText {
  const redacted = redactText(String(raw ?? ""));
  const truncated = truncateSourceText(redacted);
  return {
    text: truncated.text,
    truncated: truncated.truncated,
    originalChars: truncated.originalChars,
    omittedChars: truncated.omittedChars,
  };
}

export function isCollectableText(text: string): boolean {
  return String(text ?? "").trim().length >= MIN_SOURCE_CHARS;
}

interface RecentJobRow {
  id: string;
  source_text: string | null;
}

/**
 * 入队。调用方负责事务（本函数内使用 xact 级 advisory lock）。
 * 返回 jobId；merged=true 表示命中已有 job、只累计次数。
 */
export async function enqueueExperience(
  client: Queryable,
  draft: ExperienceDraft,
): Promise<EnqueueResult> {
  const prepared = prepareExperienceText(draft.text);
  if (!isCollectableText(prepared.text)) {
    return { jobId: null, merged: false, reason: `来源文本过短（<${MIN_SOURCE_CHARS} 字）` };
  }

  const fingerprint = buildFingerprint({
    tenantId: draft.tenantId,
    departmentId: draft.departmentId,
    sourceType: draft.sourceType,
    step: draft.step ?? null,
    errorType: draft.errorType ?? null,
    statusCode: draft.statusCode ?? null,
    text: prepared.text,
  });
  const bucket = draft.manual ? manualBucket(randomUUID()) : cooldownBucket();

  // 同一指纹串行化：小时桶边界与并发入队都不会各写一条
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [fingerprint]);

  let relatedJobId: string | null = null;

  if (!draft.manual) {
    const recent = await client.query(
      `select id, source_text
         from experience_jobs
        where tenant_id = $1
          and fingerprint = $2
          and created_at >= now() - ($3 || ' hours')::interval
        order by created_at desc
        limit 20`,
      [draft.tenantId, fingerprint, String(DEDUPE_WINDOW_HOURS)],
    );

    for (const row of recent.rows as unknown as RecentJobRow[]) {
      const similarity = jaccardSimilarity(prepared.text, row.source_text ?? "");
      const verdict = classifySimilarity(similarity);
      if (verdict === "merge") {
        await mergeIntoJob(client, row.id);
        return { jobId: row.id, merged: true };
      }
      if (verdict === "suspect" && !relatedJobId) {
        relatedJobId = row.id;
      }
    }
  }

  const hourly = await client.query(
    `select count(*)::int as count
       from experience_jobs
      where tenant_id = $1
        and created_at >= date_trunc('hour', now())`,
    [draft.tenantId],
  );
  const used = Number((hourly.rows[0] as { count?: number } | undefined)?.count ?? 0);
  const overLimit = used >= HOURLY_JOB_LIMIT;

  const sourceMeta = redactValue({
    title: draft.title,
    step: draft.step ?? null,
    errorType: draft.errorType ?? null,
    statusCode: draft.statusCode ?? null,
    truncated: prepared.truncated,
    originalChars: prepared.originalChars,
    omittedChars: prepared.omittedChars,
    redacted: true,
    ...(draft.meta ?? {}),
  });

  const inserted = await client.query(
    `insert into experience_jobs
       (tenant_id, department_id, channel, source_type, source_id, source_version,
        cooldown_bucket, fingerprint, source_text, source_meta, not_before, related_job_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
             case when $11::boolean then date_trunc('hour', now()) + interval '1 hour' else null end,
             $12)
     on conflict do nothing
     returning id`,
    [
      draft.tenantId,
      draft.departmentId,
      draft.channel,
      draft.sourceType,
      draft.sourceId,
      draft.sourceVersion,
      bucket,
      fingerprint,
      prepared.text,
      JSON.stringify(sourceMeta),
      overLimit,
      relatedJobId,
    ],
  );
  const insertedId = (inserted.rows[0] as { id?: string } | undefined)?.id;
  if (insertedId) {
    return { jobId: insertedId, merged: false };
  }

  // 唯一索引冲突：优先按来源版本命中，其次按指纹小时桶命中
  const bySource = await client.query(
    `select id from experience_jobs
      where tenant_id = $1 and channel = $2 and source_type = $3
        and source_id = $4 and source_version = $5`,
    [draft.tenantId, draft.channel, draft.sourceType, draft.sourceId, draft.sourceVersion],
  );
  const existingId =
    (bySource.rows[0] as { id?: string } | undefined)?.id ??
    (
      (
        await client.query(
          `select id from experience_jobs
            where tenant_id = $1 and fingerprint = $2 and cooldown_bucket = $3`,
          [draft.tenantId, fingerprint, bucket],
        )
      ).rows[0] as { id?: string } | undefined
    )?.id;

  if (!existingId) {
    return { jobId: null, merged: false, reason: "入队冲突且未找到已有 job" };
  }
  await mergeIntoJob(client, existingId);
  return { jobId: existingId, merged: true };
}

async function mergeIntoJob(client: Queryable, jobId: string): Promise<void> {
  await client.query(
    `update experience_jobs
        set occurrence_count = occurrence_count + 1,
            last_seen_at = now(),
            cooldown_until = now() + ($2 || ' minutes')::interval
      where id = $1`,
    [jobId, String(COOLDOWN_MINUTES)],
  );
}
