import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { departments } from "./departments";

/**
 * 经验采集队列（experience_jobs）。
 *
 * 边界：
 * - 采集层只写队列，不做 LLM；提炼由 worker 异步完成；
 * - 去重/冷却依赖唯一索引，不依赖“先查后插”；
 * - source_text 只存去敏并截断后的文本（≤12000 字符），90 天后清理；
 * - worker 使用 app_worker 受限角色，RLS 仍然生效（策略见 db/policies）。
 */
export const experienceJobs = pgTable(
  "experience_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    /** document / skill / pipeline / review / retro / connector / manual */
    channel: text("channel").notNull(),
    sourceType: text("source_type").notNull(),
    /** 必须非空：唯一索引含 NULL 会失去去重能力 */
    sourceId: uuid("source_id").notNull(),
    /** 去重版本：如 run 的终态 + finished_at，手动复盘用正文 hash */
    sourceVersion: text("source_version").notNull(),
    /** 冷却时间桶：UTC YYYYMMDDHH24；手动触发用 manual:<uuid> */
    cooldownBucket: text("cooldown_bucket").notNull(),
    /** 结构化指纹：含部门，不含 channel */
    fingerprint: text("fingerprint"),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    mergedIntoJobId: uuid("merged_into_job_id"),
    relatedJobId: uuid("related_job_id"),
    /** 去敏 + 头/关键段/尾截断后的来源文本 */
    sourceText: text("source_text"),
    sourceMeta: jsonb("source_meta").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** queued / running / done / failed / skipped / dead */
    status: text("status").notNull().default("queued"),
    /** 最早可执行时间：限额命中或指数退避时写入 */
    notBefore: timestamp("not_before", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    resultCardIds: uuid("result_card_ids").array().notNull().default(sql`'{}'::uuid[]`),
    workerId: text("worker_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("experience_jobs_source_unique").on(
      table.tenantId,
      table.channel,
      table.sourceType,
      table.sourceId,
      table.sourceVersion,
    ),
    uniqueIndex("experience_jobs_fingerprint_bucket_unique")
      .on(table.tenantId, table.fingerprint, table.cooldownBucket)
      .where(sql`"fingerprint" is not null`),
    index("experience_jobs_dedupe_idx").on(
      table.tenantId,
      table.departmentId,
      table.fingerprint,
      table.createdAt.desc(),
    ),
    index("experience_jobs_claim_idx").on(table.status, table.notBefore, table.createdAt),
    index("experience_jobs_tenant_idx").on(table.tenantId, table.createdAt.desc()),
  ],
);

/**
 * 目录路由纠偏样本（folder_route_feedback）。
 *
 * accepted 与卡片确认一一对应，量最大（明细 30 天）；
 * overridden / pending_resolved 是稀有高价值样本（长期保留）。
 * 不存完整原文，只存规则命中特征，避免投毒与泄露。
 */
export const folderRouteFeedback = pgTable(
  "folder_route_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    cardId: uuid("card_id").notNull(),
    jobId: uuid("job_id"),
    channel: text("channel").notNull(),
    kind: text("kind"),
    /** accepted / overridden / pending_resolved */
    action: text("action").notNull(),
    suggestedFolder: text("suggested_folder"),
    chosenFolder: text("chosen_folder"),
    routeConfidence: numeric("route_confidence", { precision: 3, scale: 2 }),
    routeReason: text("route_reason"),
    routePending: boolean("route_pending").notNull().default(false),
    features: jsonb("features").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("folder_route_feedback_card_idx").on(table.cardId),
    index("folder_route_feedback_stats_idx").on(
      table.tenantId,
      table.departmentId,
      table.channel,
      table.createdAt.desc(),
    ),
  ],
);
