/**
 * M4 切片 2：外部 MCP 连接器（JXF 作为客户端）。
 *
 * 红线：
 * - 仅 L1 可管理（platform:settings）；
 * - http 连接器必须通过 SSRF 校验，重定向一律拒绝；
 * - stdio 只允许 MCP_STDIO_ALLOWED_COMMANDS 白名单内的可执行文件，且不使用 shell；
 * - 每次调用写 mcp_server_calls（既是审计，也是每分钟限流账本）。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { assertSafeHttpUrl } from "@/lib/mcp/ssrf";
import { requireContextPermission } from "@/lib/permissions/server";

export type McpTransport = "http" | "stdio";

export interface McpServerView {
  id: string;
  name: string;
  transport: McpTransport;
  target: string;
  enabled: boolean;
  allowedTools: string[];
  timeoutMs: number;
  rateLimitPerMin: number;
  dailyQuota: number;
  toolCount: number;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface McpToolSummary {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export interface McpServerCallView {
  id: string;
  serverName: string;
  toolName: string;
  status: string;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

export interface CreateMcpServerInput {
  name: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  rateLimitPerMin?: number;
  dailyQuota?: number;
  allowedTools?: string[];
}

const MAX_TIMEOUT_MS = 120_000;
const MAX_DAILY_QUOTA = 1_000_000;
const MAX_TOOLS = 100;
const MAX_TOOL_NAME = 100;

interface ServerRow {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string[] | null;
  env: Record<string, string> | null;
  enabled: boolean;
  allowed_tools: string[];
  timeout_ms: number;
  rate_limit_per_min: number;
  daily_quota: number;
  tools_cache: unknown;
  last_checked_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

/** SDK 会话的最小封装：listTools 与 callTool */
interface SdkSession {
  listTools: () => Promise<McpToolSummary[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
}

/** 调用外部工具所需的运行时配置（不依赖数据库会话） */
export interface ConnectorCallConfig {
  transport: McpTransport;
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toView(row: ServerRow): McpServerView {
  const transport: McpTransport = row.transport === "stdio" ? "stdio" : "http";
  return {
    id: row.id,
    name: row.name,
    transport,
    target: (transport === "stdio" ? row.command : row.url) ?? "",
    enabled: row.enabled,
    allowedTools: row.allowed_tools ?? [],
    timeoutMs: row.timeout_ms,
    rateLimitPerMin: row.rate_limit_per_min,
    dailyQuota: row.daily_quota,
    toolCount: Array.isArray(row.tools_cache) ? row.tools_cache.length : 0,
    lastCheckedAt: toIso(row.last_checked_at),
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
  };
}

async function requireSettings(context: UserContext): Promise<void> {
  await withUserContext(context, (client) =>
    requireContextPermission(client, context, "platform:settings"),
  );
}

export async function listMcpServers(context: UserContext): Promise<McpServerView[]> {
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings");
    const { rows } = await client.query<ServerRow>(
      `select id, name, transport, url, command, args, env, enabled, allowed_tools,
              timeout_ms, rate_limit_per_min, daily_quota, tools_cache,
              last_checked_at, last_error, created_at
         from mcp_servers
        where tenant_id = $1
        order by created_at desc
        limit 50`,
      [context.tenantId],
    );
    return rows.map(toView);
  });
}

export async function listMcpServerCalls(
  context: UserContext,
  limit = 20,
): Promise<McpServerCallView[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings");
    const { rows } = await client.query<{
      id: string;
      server_name: string | null;
      tool_name: string;
      status: string;
      duration_ms: number | null;
      error: string | null;
      created_at: Date;
    }>(
      `select c.id, s.name as server_name, c.tool_name, c.status, c.duration_ms, c.error, c.created_at
         from mcp_server_calls c
         left join mcp_servers s on s.id = c.server_id
        where c.tenant_id = $1
        order by c.created_at desc
        limit $2`,
      [context.tenantId, safeLimit],
    );
    return rows.map((row) => ({
      id: row.id,
      serverName: row.server_name ?? "已移除",
      toolName: row.tool_name,
      status: row.status,
      durationMs: row.duration_ms,
      error: row.error,
      createdAt: row.created_at.toISOString(),
    }));
  });
}

/** stdio 可执行文件白名单：MCP_STDIO_ALLOWED_COMMANDS（逗号分隔，绝对路径优先） */
export function stdioAllowedCommands(): string[] {
  return (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function createMcpServer(
  context: UserContext,
  input: CreateMcpServerInput,
): Promise<{ id: string }> {
  await requireSettings(context);

  const name = input.name.trim();
  if (name.length === 0 || name.length > 60) {
    throw new Error("连接器名称不能为空且不超过 60 字");
  }
  if (input.transport !== "http" && input.transport !== "stdio") {
    throw new Error("不支持的传输方式");
  }
  const timeoutMs = Math.min(Math.max(Math.trunc(input.timeoutMs ?? 20_000), 1_000), MAX_TIMEOUT_MS);
  const rateLimitPerMin = Math.min(Math.max(Math.trunc(input.rateLimitPerMin ?? 60), 1), 600);
  // 0 = 不设每日上限
  const dailyQuota = Math.min(Math.max(Math.trunc(input.dailyQuota ?? 0), 0), MAX_DAILY_QUOTA);
  const allowedTools = (input.allowedTools ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= MAX_TOOL_NAME)
    .slice(0, MAX_TOOLS);

  let url: string | null = null;
  let command: string | null = null;
  let args: string[] = [];
  let env: Record<string, string> = {};

  if (input.transport === "http") {
    const parsed = await assertSafeHttpUrl(input.url ?? "");
    url = parsed.toString();
  } else {
    const allowed = stdioAllowedCommands();
    command = (input.command ?? "").trim();
    if (!command) {
      throw new Error("stdio 连接器必须填写可执行文件路径");
    }
    if (!allowed.includes(command)) {
      throw new Error(
        allowed.length === 0
          ? "stdio 连接器已禁用：请先在 MCP_STDIO_ALLOWED_COMMANDS 中配置允许的命令"
          : `命令不在白名单内：${command}`,
      );
    }
    args = (input.args ?? [])
      .map((item) => String(item))
      .filter((item) => item.length > 0 && item.length <= 500)
      .slice(0, 20);
    env = Object.fromEntries(
      Object.entries(input.env ?? {})
        .filter(([key, value]) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(key) && typeof value === "string")
        .slice(0, 20)
        .map(([key, value]) => [key, value.slice(0, 1000)]),
    );
  }

  return withUserContext(context, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into mcp_servers
         (tenant_id, name, transport, url, command, args, env, timeout_ms,
          rate_limit_per_min, daily_quota, allowed_tools, created_by)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11::text[], $12)
       returning id`,
      [
        context.tenantId,
        name,
        input.transport,
        url,
        command,
        JSON.stringify(args),
        JSON.stringify(env),
        timeoutMs,
        rateLimitPerMin,
        dailyQuota,
        allowedTools,
        context.userId,
      ],
    );
    const id = inserted.rows[0].id;
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "mcp.server_created",
      targetType: "mcp_server",
      targetId: id,
      payload: {
        name,
        transport: input.transport,
        url,
        command,
        allowed_tools: allowedTools,
        rate_limit_per_min: rateLimitPerMin,
        daily_quota: dailyQuota,
      },
    });
    return { id };
  });
}

export async function setMcpServerEnabled(
  context: UserContext,
  serverId: string,
  enabled: boolean,
): Promise<void> {
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings");
    const updated = await client.query(
      `update mcp_servers set enabled = $3, updated_at = now()
        where id = $1 and tenant_id = $2`,
      [serverId, context.tenantId, enabled],
    );
    if (updated.rowCount === 0) {
      throw new Error("连接器不存在或无权操作");
    }
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: enabled ? "mcp.server_enabled" : "mcp.server_disabled",
      targetType: "mcp_server",
      targetId: serverId,
    });
  });
}

async function loadServer(context: UserContext, serverId: string): Promise<ServerRow> {
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings");
    const { rows } = await client.query<ServerRow>(
      `select id, name, transport, url, command, args, env, enabled, allowed_tools,
              timeout_ms, rate_limit_per_min, daily_quota, tools_cache,
              last_checked_at, last_error, created_at
         from mcp_servers
        where id = $1 and tenant_id = $2`,
      [serverId, context.tenantId],
    );
    if (!rows[0]) {
      throw new Error("连接器不存在或无权操作");
    }
    return rows[0];
  });
}

/** 建连超时：SDK 的 request timeout 不覆盖 TCP/TLS 建连，单独兜底 */
function withConnectTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`连接器连接超时（${timeoutMs}ms）`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return JSON.stringify(content ?? null);
  }
  const parts = content.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as { type?: string; text?: string };
    if (record.type === "text" && typeof record.text === "string") {
      return [record.text];
    }
    return [`[${record.type ?? "content"}]`];
  });
  return parts.join("\n") || JSON.stringify(content);
}

/** 用官方 SDK 建连，执行回调后关闭；HTTP / stdio 走同一入口 */
async function withSdkClient<T>(
  config: ConnectorCallConfig,
  fn: (session: SdkSession) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: "jxf-ai", version: "0.1.0" }, { capabilities: {} });
  const transport =
    config.transport === "stdio"
      ? createStdioTransport(config)
      : new StreamableHTTPClientTransport(new URL(await assertSafeHttpUrl(config.url ?? "")), {
          requestInit: { redirect: "manual" },
        });

  try {
    await withConnectTimeout(
      client.connect(transport, { timeout: config.timeoutMs }),
      config.timeoutMs,
    );
    return await fn({
      listTools: async () => {
        const result = await client.listTools({}, { timeout: config.timeoutMs });
        return normalizeTools(result.tools);
      },
      callTool: async (name, args) => {
        const result = await client.callTool({ name, arguments: args }, undefined, {
          timeout: config.timeoutMs,
        });
        return {
          text: textOfContent((result as { content?: unknown }).content),
          isError: (result as { isError?: boolean }).isError === true,
        };
      },
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

function createStdioTransport(config: ConnectorCallConfig): StdioClientTransport {
  const command = config.command ?? "";
  if (!stdioAllowedCommands().includes(command)) {
    throw new Error("stdio 命令不在白名单内");
  }
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return new StdioClientTransport({
    command,
    args: config.args,
    env: { ...baseEnv, ...config.env },
    stderr: "pipe",
  });
}

/**
 * 直接执行一次工具调用（不做权限与限流判定，由调用方负责）。
 * worker 运行时与 M4 管理端共用这条链路，避免两套协议实现。
 */
export async function executeConnectorTool(
  config: ConnectorCallConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  return withSdkClient(config, (session) => session.callTool(toolName, args));
}

function normalizeTools(raw: unknown): McpToolSummary[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.slice(0, MAX_TOOL_NAME) : "";
      if (!name) {
        return [];
      }
      return [
        {
          name,
          description: typeof record.description === "string" ? record.description.slice(0, 500) : "",
          inputSchema: record.inputSchema ?? null,
        },
      ];
    })
    .slice(0, MAX_TOOLS);
}

/** 探测工具列表并缓存；失败写 last_error */
export async function refreshMcpServerTools(
  context: UserContext,
  serverId: string,
): Promise<McpToolSummary[]> {
  const server = await loadServer(context, serverId);
  if (!server.enabled) {
    throw new Error("连接器已停用，请先启用");
  }

  try {
    const tools = await withSdkClient(
      {
        transport: server.transport === "stdio" ? "stdio" : "http",
        url: server.url,
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
        timeoutMs: server.timeout_ms,
      },
      (session) => session.listTools(),
    );

    await withUserContext(context, async (client) => {
      await client.query(
        `update mcp_servers
            set tools_cache = $2::jsonb, last_checked_at = now(), last_error = null, updated_at = now()
          where id = $1`,
        [server.id, JSON.stringify(tools)],
      );
      await auditInTx(client, context, {
        actorUserId: context.userId,
        action: "mcp.server_tools_refreshed",
        targetType: "mcp_server",
        targetId: server.id,
        payload: { tool_count: tools.length },
      });
    });

    return tools;
  } catch (error) {
    const message = error instanceof Error ? error.message : "探测失败";
    await withUserContext(context, (client) =>
      client.query(`update mcp_servers set last_error = $2, updated_at = now() where id = $1`, [
        server.id,
        message.slice(0, 500),
      ]),
    ).catch(() => undefined);
    throw error;
  }
}

/** 已有连接器可用的工具选项，供 AI 员工勾选（value 形如 mcp:<serverId>:<toolName>） */
export interface McpToolOptionView {
  value: string;
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
}

export async function listMcpToolOptions(context: UserContext): Promise<McpToolOptionView[]> {
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings");
    const { rows } = await client.query<{ id: string; name: string; tools_cache: unknown }>(
      `select id, name, tools_cache from mcp_servers
        where tenant_id = $1 and enabled
        order by created_at desc
        limit 20`,
      [context.tenantId],
    );
    return rows.flatMap((row) =>
      normalizeTools(row.tools_cache).map((tool) => ({
        value: `mcp:${row.id}:${tool.name}`,
        serverId: row.id,
        serverName: row.name,
        toolName: tool.name,
        description: tool.description,
      })),
    );
  });
}

/** 读取缓存的工具列表（不发起网络调用） */
export async function getMcpServerTools(
  context: UserContext,
  serverId: string,
): Promise<McpToolSummary[]> {
  const server = await loadServer(context, serverId);
  return normalizeTools(server.tools_cache);
}

async function recordCall(
  context: UserContext,
  server: ServerRow,
  toolName: string,
  status: "ok" | "error" | "denied" | "timeout",
  durationMs: number | null,
  error: string | null,
): Promise<void> {
  await withUserContext(context, async (client) => {
    await client.query(
      `insert into mcp_server_calls (tenant_id, server_id, tool_name, status, duration_ms, error)
       values ($1, $2, $3, $4, $5, $6)`,
      [context.tenantId, server.id, toolName, status, durationMs, error?.slice(0, 500) ?? null],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: status === "denied" ? "mcp.server_denied" : "mcp.server_called",
      targetType: "mcp_server",
      targetId: server.id,
      payload: { tool: toolName, status, duration_ms: durationMs, error: error?.slice(0, 200) ?? null },
    });
  }).catch(() => undefined);
}

/** 调用外部连接器工具（管理端测试调用；后续运行时复用同一入口） */
export async function callMcpServerTool(
  context: UserContext,
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ text: string }> {
  const server = await loadServer(context, serverId);
  if (!server.enabled) {
    throw new Error("连接器已停用，请先启用");
  }
  if (server.allowed_tools.length > 0 && !server.allowed_tools.includes(toolName)) {
    await recordCall(context, server, toolName, "denied", null, "工具不在连接器白名单内");
    throw new Error("该工具不在连接器白名单内");
  }

  const usage = await withUserContext(context, async (client) => {
    const { rows } = await client.query<{ minute_count: number; day_count: number }>(
      `select
         (select count(*) from mcp_server_calls
           where server_id = $1 and created_at > now() - interval '1 minute')::int as minute_count,
         (select count(*) from mcp_server_calls
           where server_id = $1 and created_at >= date_trunc('day', now()))::int as day_count`,
      [server.id],
    );
    return rows[0] ?? { minute_count: 0, day_count: 0 };
  });
  if (Number(usage.minute_count) >= server.rate_limit_per_min) {
    await recordCall(context, server, toolName, "denied", null, "超出每分钟调用上限");
    throw new Error(`超出每分钟调用上限（${server.rate_limit_per_min} 次）`);
  }
  if (server.daily_quota > 0 && Number(usage.day_count) >= server.daily_quota) {
    await recordCall(context, server, toolName, "denied", null, "超出每日调用配额");
    throw new Error(`超出每日调用配额（${server.daily_quota} 次）`);
  }

  const startedAt = Date.now();
  let recorded = false;
  try {
    const result = await executeConnectorTool(
      {
        transport: server.transport === "stdio" ? "stdio" : "http",
        url: server.url,
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
        timeoutMs: server.timeout_ms,
      },
      toolName,
      args,
    );

    if (result.isError) {
      await recordCall(context, server, toolName, "error", Date.now() - startedAt, result.text || "连接器返回错误");
      recorded = true;
      throw new Error(result.text || "连接器返回错误");
    }

    await recordCall(context, server, toolName, "ok", Date.now() - startedAt, null);
    recorded = true;
    return { text: result.text };
  } catch (error) {
    if (!recorded) {
      const message = error instanceof Error ? error.message : "调用失败";
      const timeout = /timeout|aborted|超时/i.test(message);
      await recordCall(
        context,
        server,
        toolName,
        timeout ? "timeout" : "error",
        Date.now() - startedAt,
        message,
      );
    }
    throw error;
  }
}
