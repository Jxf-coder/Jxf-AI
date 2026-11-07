import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth";

/**
 * M4 切片 2：外部 MCP 连接器（JXF 作为客户端消费外部工具）。
 *
 * 边界：
 * - 仅 L1 可管理；http 地址必须通过 SSRF 校验，内网主机需显式白名单；
 * - stdio 只允许命令白名单内的可执行文件，且不使用 shell；
 * - 每次调用都记入 mcp_server_calls，既是审计也是限流账本。
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    name: text("name").notNull(),
    /** http | stdio */
    transport: text("transport").notNull().default("http"),
    /** http：端点地址 */
    url: text("url"),
    /** stdio：可执行文件（必须在白名单内） */
    command: text("command"),
    args: jsonb("args").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    env: jsonb("env").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    enabled: boolean("enabled").notNull().default(true),
    /** 允许调用的工具；空数组 = 全部已发现工具 */
    allowedTools: text("allowed_tools").array().notNull().default(sql`'{}'::text[]`),
    timeoutMs: integer("timeout_ms").notNull().default(20000),
    rateLimitPerMin: integer("rate_limit_per_min").notNull().default(60),
    /** tools/list 的缓存结果 */
    toolsCache: jsonb("tools_cache").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("mcp_servers_tenant_idx").on(table.tenantId, table.createdAt.desc())],
);

/** 连接器调用账本：审计 + 每分钟限流 */
export const mcpServerCalls = pgTable(
  "mcp_server_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    /** ok | error | denied | timeout */
    status: text("status").notNull(),
    durationMs: integer("duration_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("mcp_server_calls_server_idx").on(table.serverId, table.createdAt.desc()),
    index("mcp_server_calls_tenant_idx").on(table.tenantId, table.createdAt.desc()),
  ],
);
