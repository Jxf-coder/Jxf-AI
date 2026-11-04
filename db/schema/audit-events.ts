import { sql } from "drizzle-orm";
import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth";

/**
 * 审计事件：insert-only。
 * 不做 UPDATE / DELETE 策略，并显式撤销 jxf_app 的更新与删除权限。
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** 事件发生的部门上下文：用于 L2 的「本部门及下级」审计可见性；顶层/登录事件可为空 */
    departmentId: uuid("department_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    requestId: text("request_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("audit_events_actor_idx").on(table.actorUserId),
    index("audit_events_department_idx").on(table.departmentId),
  ],
);
