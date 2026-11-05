import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { departments } from "./departments";

/**
 * AI 员工：可复用的智能体定义。
 *
 * 边界：不属于组织架构、不占部门树、不计入岗位数；自身不携带数据权限，
 * 运行时一律继承调用者的部门上下文。
 * P3 再补 persona / system_prompt / skill_ids / allowed_tools / model_config。
 */
export const aiEmployees = pgTable(
  "ai_employees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** draft | active | disabled */
    status: text("status").notNull().default("draft"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("ai_employees_tenant_slug_unique").on(table.tenantId, table.slug)],
);

/**
 * AI 员工使用授权：部门授权为主（含子树继承），个人授权为例外，二选一。
 */
export const aiEmployeeGrants = pgTable(
  "ai_employee_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    aiEmployeeId: uuid("ai_employee_id")
      .notNull()
      .references(() => aiEmployees.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** use | manage */
    capability: text("capability").notNull().default("use"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ai_employee_grants_department_unique")
      .on(table.aiEmployeeId, table.departmentId)
      .where(sql`department_id is not null`),
    uniqueIndex("ai_employee_grants_user_unique")
      .on(table.aiEmployeeId, table.userId)
      .where(sql`user_id is not null`),
    index("ai_employee_grants_department_idx").on(table.departmentId),
    index("ai_employee_grants_user_idx").on(table.userId),
    // 部门授权与个人授权二选一
    check(
      "ai_employee_grants_target_shape",
      sql`(department_id is not null and user_id is null) or (department_id is null and user_id is not null)`,
    ),
  ],
);
