import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { roleKind } from "./enums";

/** 岗位树：root / child / seat */
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    parentId: uuid("parent_id"),
    kind: roleKind("kind").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
      name: "roles_parent_fk",
    }).onDelete("restrict"),
    uniqueIndex("roles_slug_unique").on(table.tenantId, table.parentId, table.slug),
    index("roles_parent_idx").on(table.parentId),
    index("roles_tenant_idx").on(table.tenantId),
    check(
      "roles_parent_shape",
      sql`(kind = 'root' and parent_id is null) or (kind <> 'root' and parent_id is not null)`,
    ),
  ],
);

/** 子树闭包：读权限直接查 ancestor/descendant，避免递归 CTE */
export const roleClosure = pgTable(
  "role_closure",
  {
    ancestorId: uuid("ancestor_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    descendantId: uuid("descendant_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    depth: integer("depth").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ancestorId, table.descendantId] }),
    index("role_closure_desc_idx").on(table.descendantId),
  ],
);
