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
import { cardKind, cardOrigin, cardStatus, gapStatus } from "./enums";
import { ingestRuns } from "./ingest";
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
    extra: jsonb("extra").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("knowledge_cards_department_status_idx").on(table.departmentId, table.status),
    index("knowledge_cards_ingest_run_idx").on(table.ingestRunId),
    index("knowledge_cards_folder_idx").on(table.departmentId, table.roleKey, table.folderKey),
    index("knowledge_cards_extra_gin_idx").using("gin", table.extra),
  ],
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
    /** 预留：M3 建 runs 表后补外键 */
    runId: uuid("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("qa_logs_department_created_idx").on(table.departmentId, table.createdAt)],
);
