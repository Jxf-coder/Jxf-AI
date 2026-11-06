import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { assets } from "./assets";
import { departments } from "./departments";
import { docStatus } from "./enums";
import { ingestRuns } from "./ingest";

/**
 * 解析后的文档。扫描件落 needs_ocr，不生成切片——不假装读过。
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    ingestRunId: uuid("ingest_run_id").references(() => ingestRuns.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    mime: text("mime").notNull(),
    /** 冻结上传时的岗位（memberships.position）；用于目录树第二层 */
    roleKey: text("role_key"),
    /** 10 个标准目录的 key，见 src/lib/knowledge/folders.ts */
    folderKey: text("folder_key").notNull().default("01-original"),
    /** department：仅本部门及下级可见；shared：全员共享区可读 */
    visibility: text("visibility").notNull().default("department"),
    pageCount: integer("page_count"),
    charCount: integer("char_count").notNull().default(0),
    lang: text("lang").default("zh"),
    status: docStatus("status").notNull().default("parsed"),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("documents_department_status_idx").on(table.departmentId, table.status),
    index("documents_ingest_run_idx").on(table.ingestRunId),
    index("documents_folder_idx").on(table.departmentId, table.roleKey, table.folderKey),
  ],
);

/**
 * 检索单元（切片）。
 *
 * - 冗余 department_id：让 RLS 与 ANN 索引都能直接吃到过滤条件，避免 join 拍平
 * - embedding 维度固定 1024（bge-m3 等中文模型常用；OpenAI 兼容接口可用 dimensions=1024）
 *   维度变更需新建迁移并重建 hnsw 索引
 * - 中文关键词通道走 pg_bigm（gin_bigm_ops），不用 tsvector：`to_tsvector('simple', 中文)`
 *   会把整句当成一个 token，实测无法按词召回；索引在 db/policies/017 中以原生 SQL 创建
 */
export const docChunks = pgTable(
  "doc_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ord: integer("ord").notNull(),
    /** 来自「【第 N 页】」标记 */
    pageNo: integer("page_no"),
    paragraphNo: integer("paragraph_no"),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    text: text("text").notNull(),
    tokenCount: integer("token_count"),
    /** 未配置 embedding 或调用失败时为空：检索自动降级为纯关键词 */
    embedding: vector("embedding", { dimensions: 1024 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("doc_chunks_document_ord_unique").on(table.documentId, table.ord),
    index("doc_chunks_document_idx").on(table.documentId, table.ord),
    index("doc_chunks_department_idx").on(table.departmentId),
    index("doc_chunks_embedding_hnsw_idx")
      .using("hnsw", table.embedding.op("vector_cosine_ops"))
      .where(sql`embedding is not null`),
  ],
);
