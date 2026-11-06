import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { departments } from "./departments";
import { assets } from "./assets";
import { fileDecision, ingestKind, ingestStatus } from "./enums";

/**
 * 入库批次：一次上传 / 一次巡读 = 一个 run。
 * 撤回只作用于本批未确认的产出，已确认的知识卡不回滚。
 */
export const ingestRuns = pgTable(
  "ingest_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    kind: ingestKind("kind").notNull(),
    goal: text("goal"),
    status: ingestStatus("status").notNull().default("draft"),
    /** 目录数 / 文件数 / 保留 / 丢弃 / 待定 / 生成卡 / 冲突 */
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
  },
  (table) => [
    index("ingest_runs_department_status_idx").on(table.departmentId, table.status),
    index("ingest_runs_created_by_idx").on(table.createdBy),
  ],
);

/** 批次内的单个文件与处置结论 */
export const ingestFiles = pgTable(
  "ingest_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => ingestRuns.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    sourcePath: text("source_path").notNull(),
    decision: fileDecision("decision").notNull().default("pending"),
    reason: text("reason"),
    error: text("error"),
    /** documents.id：解析成功后回填；不建外键，避免与 documents 表互相依赖 */
    documentId: uuid("document_id"),
    /** 非空表示正文由视觉模型自动识别（存模型名），用于批次明细区分「自动 OCR / 待人工」 */
    ocrModel: text("ocr_model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ingest_files_run_decision_idx").on(table.runId, table.decision)],
);
