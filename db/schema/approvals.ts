import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth";

/**
 * 离职交接审批。
 * - approval_requests：一次申请一条，type 为文本，便于后续扩展财务/投放等类型。
 * - handover_items：申请下的资产明细与接收人；asset_id 用 text，兼容 uuid 与非 uuid 资产。
 */

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    type: text("type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    requesterId: uuid("requester_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    index("approval_requests_tenant_status_idx").on(table.tenantId, table.status),
    index("approval_requests_subject_idx").on(table.subjectType, table.subjectId),
    check(
      "approval_requests_status",
      sql`status in ('pending', 'approved', 'rejected', 'cancelled', 'expired')`,
    ),
  ],
);

export const handoverItems = pgTable(
  "handover_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => approvalRequests.id, { onDelete: "cascade" }),
    assetType: text("asset_type").notNull(),
    assetId: text("asset_id").notNull(),
    fromUserId: uuid("from_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    toUserId: uuid("to_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    transferredAt: timestamp("transferred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("handover_items_approval_idx").on(table.approvalId),
    index("handover_items_from_idx").on(table.fromUserId),
    index("handover_items_to_idx").on(table.toUserId),
  ],
);
