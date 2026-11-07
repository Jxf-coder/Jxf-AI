import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { departments } from "./departments";
import { memberships } from "./memberships";
import { mcpTokens } from "./mcp";

/**
 * M4 切片 4：逐工具审批单。
 *
 * 边界：
 * - 令牌 scope 的 approvalTools 命中的写类工具，先落单不执行；
 * - 只有 L1 能批准 / 驳回；批准后按令牌绑定的任用身份执行，避免审批人扩大数据范围；
 * - 参数写入前脱敏；执行结果只留预览，完整结果仍回到调用方。
 */
export const mcpToolApprovals = pgTable(
  "mcp_tool_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => mcpTokens.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    /** 已脱敏的调用参数 */
    arguments: jsonb("arguments").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** pending | approved | rejected | failed */
    status: text("status").notNull().default("pending"),
    resultPreview: text("result_preview"),
    error: text("error"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("mcp_tool_approvals_tenant_idx").on(table.tenantId, table.status, table.createdAt.desc()),
    check(
      "mcp_tool_approvals_status",
      sql`status in ('pending', 'approved', 'rejected', 'failed')`,
    ),
  ],
);
