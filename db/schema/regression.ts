import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { departments } from "./departments";

/** 回归题集：换 chunk 策略 / embedding 模型后，用基线保留率做门禁 */
export const regressionQuestions = pgTable(
  "regression_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    q: text("q").notNull(),
    /** intake | manual */
    source: text("source").notNull().default("manual"),
    baselineIds: uuid("baseline_ids").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("regression_questions_department_idx").on(table.departmentId)],
);

/** 一次回归运行：retained < 0.9 或 pass < total 即判定失败 */
export const regressionRuns = pgTable(
  "regression_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    buildTag: text("build_tag").notNull(),
    total: integer("total").notNull(),
    passed: integer("passed").notNull(),
    retained: numeric("retained", { precision: 5, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("regression_runs_department_created_idx").on(table.departmentId, table.createdAt)],
);

/** 单题结果 */
export const regressionItems = pgTable(
  "regression_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => regressionRuns.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => regressionQuestions.id, { onDelete: "cascade" }),
    hitIds: uuid("hit_ids").array().notNull().default(sql`'{}'::uuid[]`),
    retained: numeric("retained", { precision: 5, scale: 4 }).notNull(),
    pass: boolean("pass").notNull(),
  },
  (table) => [index("regression_items_run_idx").on(table.runId)],
);
