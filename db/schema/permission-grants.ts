import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { accessLevel } from "./enums";

/**
 * 权限系统数据表。
 *
 * 设计原则：
 * - 权限目录在代码里（src/lib/permissions/catalog.ts），这里只存「谁被授予了什么」。
 * - permission_key 使用 text，新增模块不需要改表结构。
 * - scope_type 必须与动作类型匹配；写类动作禁止 DEPT_TREE。
 * - deny 优先于 allow。
 */

export const roleTemplates = pgTable("role_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  level: accessLevel("level").notNull(),
  isSystem: boolean("is_system").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roleTemplateGrants = pgTable(
  "role_template_grants",
  {
    templateId: text("template_id")
      .notNull()
      .references(() => roleTemplates.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull(),
    scopeType: text("scope_type").notNull(),
    effect: text("effect").notNull().default("allow"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("role_template_grants_unique").on(table.templateId, table.permissionKey),
    check(
      "role_template_grants_scope_shape",
      sql`(scope_type in ('ALL', 'SELF')) or (scope_type in ('DEPT', 'DEPT_TREE'))`,
    ),
    check("role_template_grants_effect", sql`effect in ('allow', 'deny')`),
  ],
);

export const userPermissionGrants = pgTable(
  "user_permission_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull(),
    scopeType: text("scope_type").notNull(),
    /** DEPT / DEPT_TREE 时为部门 id；ALL / SELF 必须为空 */
    scopeId: uuid("scope_id"),
    effect: text("effect").notNull().default("allow"),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_permission_grants_user_key_unique").on(
      table.tenantId,
      table.userId,
      table.permissionKey,
    ),
    index("user_permission_grants_user_idx").on(table.userId),
    index("user_permission_grants_key_idx").on(table.permissionKey),
    check(
      "user_permission_grants_scope_type",
      sql`scope_type in ('ALL', 'DEPT_TREE', 'DEPT', 'SELF')`,
    ),
    check("user_permission_grants_effect", sql`effect in ('allow', 'deny')`),
    check(
      "user_permission_grants_scope_shape",
      sql`((scope_type in ('ALL', 'SELF') and scope_id is null) or (scope_type in ('DEPT', 'DEPT_TREE') and scope_id is not null))`,
    ),
  ],
);

export const permissionRevisions = pgTable("permission_revisions", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  version: bigint("version", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
