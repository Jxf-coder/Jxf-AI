import { foreignKey, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** 部门 / 小组：层级树上唯一的组织容器，也是 RAG 与数据权限的物理边界 */
export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    parentId: uuid("parent_id"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    /** 同级部门的拖拽排序位；越小越靠前 */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
      name: "departments_parent_fk",
    }).onDelete("restrict"),
    uniqueIndex("departments_slug_unique").on(table.tenantId, table.parentId, table.slug),
    index("departments_parent_idx").on(table.parentId),
    index("departments_tenant_idx").on(table.tenantId),
  ],
);

/** 部门子树闭包：读权限直接查 ancestor/descendant，避免递归 CTE */
export const departmentClosure = pgTable(
  "department_closure",
  {
    ancestorId: uuid("ancestor_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    descendantId: uuid("descendant_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    depth: integer("depth").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ancestorId, table.descendantId] }),
    index("department_closure_desc_idx").on(table.descendantId),
  ],
);
