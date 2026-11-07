import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { departments } from "./departments";
import { memberships } from "./memberships";

/**
 * MCP 访问令牌（M4）。
 *
 * 边界：
 * - 令牌绑定「任用」而非账号：离岗（membership 非 active）立即失效；
 * - 只存 sha256，明文仅在签发时返回一次；前缀留给界面识别；
 * - scope 初版两维：tools（工具白名单，空 = 全部可见）+ allowWrite（是否允许写类工具）；
 * - 数据权限仍走 RLS：外部调用按令牌绑定的任用构造 UserContext。
 */
export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    /** sha256(明文)，不存明文 */
    tokenHash: text("token_hash").notNull(),
    /** 明文前缀，仅用于列表识别 */
    tokenPrefix: text("token_prefix").notNull(),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    /** { tools: string[], allowWrite: boolean } */
    scope: jsonb("scope").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_tokens_token_hash_unique").on(table.tokenHash),
    index("mcp_tokens_membership_idx").on(table.membershipId, table.createdAt.desc()),
    index("mcp_tokens_tenant_idx").on(table.tenantId, table.createdAt.desc()),
  ],
);
