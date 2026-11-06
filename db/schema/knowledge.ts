import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { departments } from "./departments";
import { docChunks, documents } from "./documents";
import { cardKind, cardOrigin, cardStatus, gapStatus, shareStatus as shareStatusEnum } from "./enums";
import { ingestRuns } from "./ingest";
import { runs } from "./runtime";
import { users } from "./auth";

/**
 * 知识卡。
 *
 * 确认门槛不写在代码里：由视图 v_confirmable_cards 表达
 * （人工编辑过 或 有已核对证据，且无冲突、未过期），应用层只允许操作视图内的行。
 */
export const knowledgeCards = pgTable(
  "knowledge_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    kind: cardKind("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: cardStatus("status").notNull().default("pending"),
    origin: cardOrigin("origin").notNull(),
    product: text("product"),
    category: text("category"),
    /** 冻结生成时的岗位（memberships.position）；用于目录树第二层 */
    roleKey: text("role_key"),
    /** 10 个标准目录的 key，默认落在「02-知识卡片」 */
    folderKey: text("folder_key").notNull().default("02-cards"),
    /** department | shared；此前该列未被 RLS 使用，0010 起真正生效 */
    visibility: text("visibility").notNull().default("department"),
    /** 公司共享审批状态：只有 approved 才允许 visibility = shared */
    shareStatus: shareStatusEnum("share_status").notNull().default("none"),
    shareRequestedBy: uuid("share_requested_by").references(() => users.id, { onDelete: "set null" }),
    shareRequestedAt: timestamp("share_requested_at", { withTimezone: true }),
    shareReviewedBy: uuid("share_reviewed_by").references(() => users.id, { onDelete: "set null" }),
    shareReviewedAt: timestamp("share_reviewed_at", { withTimezone: true }),
    /** 是否允许对外（送外部模型 / 导出） */
    externalOk: boolean("external_ok").notNull().default(false),
    validUntil: date("valid_until"),
    rev: integer("rev").notNull().default(1),
    /** AI 生成后是否被人工改过：确认门槛的关键位 */
    humanEdited: boolean("human_edited").notNull().default(false),
    confirmedBy: uuid("confirmed_by").references(() => users.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    conflictWith: uuid("conflict_with").array().notNull().default(sql`'{}'::uuid[]`),
    ingestRunId: uuid("ingest_run_id").references(() => ingestRuns.id, { onDelete: "set null" }),
    /**
     * 「文档 → 保存为待确认卡片」的来源文档。
     * 配合下方部分唯一索引做幂等：同一文档反复保存只更新这一张草稿，不重复新增。
     */
    sourceDocumentId: uuid("source_document_id").references(() => documents.id, { onDelete: "set null" }),
    extra: jsonb("extra").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** 最近一次保存的人：并发冲突提示需要让用户知道该找谁对齐 */
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    index("knowledge_cards_department_status_idx").on(table.departmentId, table.status),
    index("knowledge_cards_ingest_run_idx").on(table.ingestRunId),
    index("knowledge_cards_folder_idx").on(table.departmentId, table.roleKey, table.folderKey),
    index("knowledge_cards_extra_gin_idx").using("gin", table.extra),
    uniqueIndex("knowledge_cards_source_document_unique")
      .on(table.tenantId, table.sourceDocumentId)
      .where(sql`"source_document_id" is not null`),
  ],
);

/**
 * 知识卡版本快照：每次人工保存正文写入一条（rev 唯一）。
 * 只记录内容版本；确认 / 作废 / 恢复只变更状态，不产生版本文档。
 */
export const knowledgeCardVersions = pgTable(
  "knowledge_card_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => knowledgeCards.id, { onDelete: "cascade" }),
    rev: integer("rev").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: cardStatus("status").notNull(),
    editedBy: uuid("edited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("knowledge_card_versions_rev_unique").on(table.cardId, table.rev)],
);

/**
 * 证据链：一条卡可挂多条证据，每条都必须能在原文按字符区间逐字命中。
 * quote 保存原文片段（≤600 字），charStart/charEnd 是校验与前端高亮的依据。
 */
export const cardEvidence = pgTable(
  "card_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => knowledgeCards.id, { onDelete: "cascade" }),
    chunkId: uuid("chunk_id").references(() => docChunks.id, { onDelete: "set null" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    pageNo: integer("page_no"),
    /** 人类可读定位，如「第 3 页」「跨页」 */
    locator: text("locator"),
    quote: text("quote").notNull(),
    charStart: integer("char_start"),
    charEnd: integer("char_end"),
    verified: boolean("verified").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => [
    index("card_evidence_card_verified_idx").on(table.cardId, table.verified),
    uniqueIndex("card_evidence_location_unique").on(
      table.cardId,
      table.documentId,
      table.charStart,
      table.charEnd,
    ),
  ],
);

/** 知识缺口：问答未命中时沉淀，供后续补文档 */
export const knowledgeGaps = pgTable(
  "knowledge_gaps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    status: gapStatus("status").notNull().default("open"),
    /** qa_miss | expired | manual */
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("knowledge_gaps_department_status_idx").on(table.departmentId, table.status)],
);

/**
 * 问答审计：引用编号必须落在本轮召回集合内（invalid_cites 为空），
 * 数字必须能在证据原文中找到（unverified_numbers 为空）。
 */
export const qaLogs = pgTable(
  "qa_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    citedCardIds: uuid("cited_card_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** 越界引用编号（模型写了 [7] 但本轮只有 5 张卡）；存原始编号便于回放 */
    invalidCites: text("invalid_cites").array().notNull().default(sql`'{}'::text[]`),
    unverifiedNumbers: text("unverified_numbers").array().notNull().default(sql`'{}'::text[]`),
    gapId: uuid("gap_id").references(() => knowledgeGaps.id, { onDelete: "set null" }),
    /** 指向 M3 runs：回答审计可回指到具体执行 */
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("qa_logs_department_created_idx").on(table.departmentId, table.createdAt)],
);
