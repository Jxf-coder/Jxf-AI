import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";
import { departments } from "./departments";

/**
 * 通用对象存储引用（MinIO）。
 *
 * - 去重靠 sha256：同一份文件在同一部门下重复上传只增引用
 * - title 为展示名（知识资产交接、移出预检都要用）
 * - created_by 是归属人，离职交接时会被改派
 */
export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    /** 展示名：优先取原始文件名 */
    title: text("title"),
    /** 对象存储内的相对路径 */
    storageKey: text("storage_key").notNull(),
    mime: text("mime").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    /** source_doc | image | audio | video | export */
    kind: text("kind").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("assets_tenant_sha_department_unique").on(
      table.tenantId,
      table.sha256,
      table.departmentId,
    ),
    index("assets_department_kind_idx").on(table.departmentId, table.kind),
    index("assets_created_by_idx").on(table.createdBy),
  ],
);
