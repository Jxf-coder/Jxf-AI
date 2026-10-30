import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { departments } from "./departments";

/**
 * 部门能力包：部门能看见哪些技能 / 产线。
 * 能力包是数据不是代码，改权限不需要发版。
 */
export const departmentPacks = pgTable(
  "department_packs",
  {
    departmentId: uuid("department_id")
      .primaryKey()
      .references(() => departments.id, { onDelete: "cascade" }),
    skillIds: text("skill_ids").array().notNull().default(sql`'{}'::text[]`),
    pipelineIds: text("pipeline_ids").array().notNull().default(sql`'{}'::text[]`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (table) => [
    index("department_packs_skills_idx").using("gin", table.skillIds),
    index("department_packs_pipelines_idx").using("gin", table.pipelineIds),
  ],
);
