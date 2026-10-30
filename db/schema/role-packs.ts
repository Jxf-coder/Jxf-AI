import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { roles } from "./roles";

/**
 * 角色包：岗位能看见哪些技能 / 产线。
 * 角色包是数据不是代码，改权限不需要发版。
 */
export const rolePacks = pgTable(
  "role_packs",
  {
    roleId: uuid("role_id")
      .primaryKey()
      .references(() => roles.id, { onDelete: "cascade" }),
    skillIds: text("skill_ids").array().notNull().default(sql`'{}'::text[]`),
    pipelineIds: text("pipeline_ids").array().notNull().default(sql`'{}'::text[]`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (table) => [
    index("role_packs_skills_idx").using("gin", table.skillIds),
    index("role_packs_pipelines_idx").using("gin", table.pipelineIds),
  ],
);
