import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { aiEmployees } from "./ai-employees";
import { users } from "./auth";
import { departments } from "./departments";
import { workItemStatus } from "./enums";
import { runs } from "./runtime";

/**
 * 工作项：给 AI 员工派的一件具体工作。
 *
 * 边界：
 * - 一次派发 = 一个 work_item + 一个 runs(kind='task')；重做产生新 run，历史保留；
 * - AI 员工是执行体，不是聊天对象；对话只属于 Agent 工作台；
 * - 交付物必须经人工验收（waiting_review → done / returned）才算完成；
 * - 数据权限仍按部门 RLS，AI 员工运行时继承派发者上下文。
 */
export const workItems = pgTable(
  "work_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** 工作说明：目标、背景、约束、交付要求 */
    brief: text("brief").notNull(),
    /** 结构化参数，供后续工具 / 产线步骤使用 */
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    aiEmployeeId: uuid("ai_employee_id").references(() => aiEmployees.id, { onDelete: "set null" }),
    /** 派发人：必须是 L1 / 部门负责人 */
    assignedBy: uuid("assigned_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 验收人：默认派发人，可由 L1 指派 */
    reviewerId: uuid("reviewer_id").references(() => users.id, { onDelete: "set null" }),
    /** low | normal | high | urgent */
    priority: text("priority").notNull().default("normal"),
    status: workItemStatus("status").notNull().default("queued"),
    /** 当前这一轮执行；重做只替换指针，历史 run 仍在 runs 表 */
    currentRunId: uuid("current_run_id").references(() => runs.id, { onDelete: "set null" }),
    /** 交付物：{ text, model, provider, usage? } */
    deliverable: jsonb("deliverable").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    reviewNote: text("review_note"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("work_items_department_status_idx").on(
      table.departmentId,
      table.status,
      table.createdAt.desc(),
    ),
    index("work_items_employee_status_idx").on(
      table.aiEmployeeId,
      table.status,
      table.createdAt.desc(),
    ),
    index("work_items_assigned_by_idx").on(table.assignedBy, table.createdAt.desc()),
  ],
);
