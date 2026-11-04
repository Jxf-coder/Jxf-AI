import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { departments } from "./departments";
import { accessLevel, membershipStatus } from "./enums";

/**
 * 成员：直接挂在部门下，不再有中间「岗位」层。
 * title 为业务岗位头衔（自由文本），accessLevel 为独立选择的 L1/L2/L3。
 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("成员"),
    accessLevel: accessLevel("access_level").notNull().default("L3"),
    status: membershipStatus("status").notNull().default("active"),
    sshEnabled: boolean("ssh_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("memberships_active_unique")
      .on(table.userId, table.departmentId)
      .where(sql`status = 'active'`),
    index("memberships_user_idx").on(table.userId),
    index("memberships_department_idx").on(table.departmentId),
    // 用 ::text 比较：新库首次迁移时 0005 刚新增 pending_removal，
    // 同一事务内直接使用该枚举值会触发 "unsafe use of new value"
    check(
      "memberships_removed_shape",
      sql`(status::text = 'active' and removed_at is null) or (status::text = 'pending_removal' and removed_at is null) or (status::text = 'removed' and removed_at is not null)`,
    ),
  ],
);
