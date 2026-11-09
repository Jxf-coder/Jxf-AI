/**
 * M4 切片 3：worker 侧的工具计划与执行。
 *
 * 边界：
 * - worker 只读 mcp_servers 快照（由 worker RLS 放行），不碰业务表；
 * - 员工 allowedTools 里的条目形如 mcp:<serverId>:<toolName>，模型看到的是单段别名；
 * - 每次调用写 tool_calls（运行审计）与 mcp_server_calls（连接器账本 + 限流）。
 */

import type { Pool } from "pg";

import type { ToolDefinition } from "@/lib/ai/openai";
import { executeConnectorTool, toTransport, type ConnectorCallConfig } from "@/lib/mcp/connectors";
import { errorMessage, log } from "@/lib/logger";

export interface PlannedTool {
  alias: string;
  serverId: string;
  serverName: string;
  toolName: string;
  config: ConnectorCallConfig;
  rateLimitPerMin: number;
  /** 0 = 不设每日上限 */
  dailyQuota: number;
}

export interface WorkerToolPlan {
  definitions: ToolDefinition[];
  tools: Map<string, PlannedTool>;
}

interface ServerRuntimeRow {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string[] | null;
  env: Record<string, string> | null;
  timeout_ms: number;
  rate_limit_per_min: number;
  daily_quota: number;
  tools_cache: unknown;
}

interface CachedTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** 工具别名必须满足 OpenAI function name 规则：字母数字下划线，单段 */
export function toolAlias(serverId: string, toolName: string): string {
  const server = serverId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  const tool = toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return `mcp_${server}_${tool}`;
}

export function parseToolRef(value: string): { serverId: string; toolName: string } | null {
  if (!value.startsWith("mcp:")) {
    return null;
  }
  const rest = value.slice(4);
  const index = rest.indexOf(":");
  if (index <= 0 || index === rest.length - 1) {
    return null;
  }
  return { serverId: rest.slice(0, index), toolName: rest.slice(index + 1) };
}

function cachedTools(raw: unknown): CachedTool[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    if (!name) {
      return [];
    }
    return [
      {
        name,
        description: typeof record.description === "string" ? record.description : "",
        inputSchema: record.inputSchema ?? null,
      },
    ];
  });
}

export async function loadWorkerToolPlan(
  pool: Pool,
  tenantId: string,
  allowedTools: string[],
): Promise<WorkerToolPlan> {
  const empty: WorkerToolPlan = { definitions: [], tools: new Map() };
  const refs = allowedTools.map(parseToolRef).filter((item): item is NonNullable<typeof item> => item !== null);
  if (refs.length === 0) {
    return empty;
  }

  const serverIds = Array.from(new Set(refs.map((ref) => ref.serverId)));
  const { rows } = await pool.query<ServerRuntimeRow>(
    `select id, name, transport, url, command, args, env, timeout_ms, rate_limit_per_min,
            daily_quota, tools_cache
       from mcp_servers
      where tenant_id = $1 and enabled and health_status <> 'down'
        and id = any($2::uuid[])`,
    [tenantId, serverIds],
  );
  if (rows.length === 0) {
    return empty;
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const definitions: ToolDefinition[] = [];
  const tools = new Map<string, PlannedTool>();

  for (const ref of refs) {
    const server = byId.get(ref.serverId);
    if (!server) {
      continue;
    }
    const tool = cachedTools(server.tools_cache).find((item) => item.name === ref.toolName);
    if (!tool) {
      continue;
    }
    const alias = toolAlias(server.id, tool.name);
    if (tools.has(alias)) {
      continue;
    }
    tools.set(alias, {
      alias,
      serverId: server.id,
      serverName: server.name,
      toolName: tool.name,
      rateLimitPerMin: server.rate_limit_per_min,
      dailyQuota: server.daily_quota,
      config: {
        transport: toTransport(server.transport),
        url: server.url,
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
        timeoutMs: server.timeout_ms,
      },
    });
    definitions.push({
      type: "function",
      function: {
        name: alias,
        description: `${server.name}：${tool.description || tool.name}`,
        parameters:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} },
      },
    });
    if (definitions.length >= 20) {
      break;
    }
  }

  return { definitions, tools };
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args).slice(0, 20)) {
    result[key] = /token|key|secret|password|authorization/i.test(key) ? "***" : value;
  }
  return result;
}

export interface ToolExecutionMeta {
  tenantId: string;
  departmentId: string;
  runId: string;
  stepId: string | null;
}

/** 执行一次模型请求的工具调用，返回给模型看的文本 */
export async function executePlannedTool(
  pool: Pool,
  plan: WorkerToolPlan,
  alias: string,
  rawArguments: string,
  meta: ToolExecutionMeta,
): Promise<string> {
  const tool = plan.tools.get(alias);
  if (!tool) {
    return `工具不可用：${alias}`;
  }

  let args: Record<string, unknown> = {};
  if (rawArguments.trim()) {
    try {
      const parsed = JSON.parse(rawArguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      return "工具参数不是合法 JSON，请修正后重试";
    }
  }

  const startedAt = Date.now();
  let status: "ok" | "error" | "timeout" | "denied" = "ok";
  let error: string | null = null;
  let text = "";

  try {
    const { rows } = await pool.query<{ minute_count: number; day_count: number }>(
      `select
         (select count(*) from mcp_server_calls
           where server_id = $1 and created_at > now() - interval '1 minute')::int as minute_count,
         (select count(*) from mcp_server_calls
           where server_id = $1 and created_at >= date_trunc('day', now()))::int as day_count`,
      [tool.serverId],
    );
    const usage = rows[0] ?? { minute_count: 0, day_count: 0 };
    if (Number(usage.minute_count) >= tool.rateLimitPerMin) {
      status = "denied";
      error = "超出每分钟调用上限";
      return error;
    }
    if (tool.dailyQuota > 0 && Number(usage.day_count) >= tool.dailyQuota) {
      status = "denied";
      error = `超出每日调用配额（${tool.dailyQuota} 次）`;
      return error;
    }

    const result = await executeConnectorTool(tool.config, tool.toolName, args);
    text = result.text;
    if (result.isError) {
      status = "error";
      error = result.text.slice(0, 300);
    }
    return result.isError ? `工具返回错误：${result.text}` : result.text;
  } catch (caught) {
    const message = errorMessage(caught);
    status = /timeout|aborted|超时/i.test(message) ? "timeout" : "error";
    error = message;
    return `工具调用失败：${message}`;
  } finally {
    const durationMs = Date.now() - startedAt;
    await pool
      .query(
        `insert into tool_calls
           (run_id, step_id, department_id, tool_name, args_redacted, status,
            result_chars, result_preview, duration_ms, error)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
        [
          meta.runId,
          meta.stepId,
          meta.departmentId,
          tool.toolName,
          JSON.stringify(redactArgs(args)),
          status,
          text.length,
          text.slice(0, 500),
          durationMs,
          error?.slice(0, 500) ?? null,
        ],
      )
      .catch((caught) => {
        log("warn", "tool_call_record_failed", { error: errorMessage(caught) });
      });
    await pool
      .query(
        `insert into mcp_server_calls (tenant_id, server_id, tool_name, status, duration_ms, error)
         values ($1, $2, $3, $4, $5, $6)`,
        [meta.tenantId, tool.serverId, tool.toolName, status, durationMs, error?.slice(0, 500) ?? null],
      )
      .catch((caught) => {
        log("warn", "mcp_server_call_record_failed", { error: errorMessage(caught) });
      });
  }
}
