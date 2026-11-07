/**
 * MCP 连接器心跳体检（Web 手动触发 / 宿主机 runner 定时触发共用）。
 *
 * 状态机：
 *   - healthy：最近一次探测成功；
 *   - degraded：连续失败 1–2 次，仍参与运行；
 *   - down：连续失败 ≥ 3 次，运行时跳过该连接器（失败降级 / 熔断）；
 *
 * 状态发生迁移时写审计；runner 侧可选向 MCP_ALERT_WEBHOOK 推送告警。
 * 体检只读取连接器配置并更新健康列，不改 tools_cache 与 allowed_tools。
 */

import type { Client } from "pg";

import { auditInTx } from "@/lib/audit";
import { withUserContext, type UserContext } from "@/lib/db/user-context";
import { errorMessage, log } from "@/lib/logger";
import { requireContextPermission } from "@/lib/permissions/server";

import {
  probeConnectorTools,
  type ConnectorCallConfig,
  type McpHealthStatus,
  type McpToolSummary,
} from "./connectors";

export const FAILURE_THRESHOLD = 3;
const PROBE_CONCURRENCY = 3;

export interface HealthTarget {
  tenantId: string;
  id: string;
  name: string;
  config: ConnectorCallConfig;
  status: McpHealthStatus;
  failures: number;
}

export interface HealthUpdate {
  status: McpHealthStatus;
  failures: number;
  latencyMs: number | null;
  error: string | null;
}

export type HealthTransition = "unhealthy" | "recovered" | null;

export interface ConnectorHealthResult {
  tenantId: string;
  serverId: string;
  name: string;
  previous: McpHealthStatus;
  status: McpHealthStatus;
  failures: number;
  latencyMs: number | null;
  error: string | null;
  transition: HealthTransition;
}

export interface HealthAlert {
  event: "mcp.connector_unhealthy" | "mcp.connector_recovered";
  connector_id: string;
  connector_name: string;
  status: McpHealthStatus;
  failures: number;
  error: string | null;
  at: string;
}

export type ProbeFn = (config: ConnectorCallConfig) => Promise<McpToolSummary[]>;

interface TargetRow {
  id: string;
  tenant_id: string;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string[] | null;
  env: Record<string, string> | null;
  timeout_ms: number;
  health_status: string;
  health_consecutive_failures: number;
}

const TARGET_COLUMNS = `id, tenant_id, name, transport, url, command, args, env, timeout_ms,
       health_status, health_consecutive_failures`;

function toHealthStatus(raw: string): McpHealthStatus {
  return raw === "healthy" || raw === "degraded" || raw === "down" ? raw : "unknown";
}

function toTarget(row: TargetRow): HealthTarget {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    name: row.name,
    status: toHealthStatus(row.health_status),
    failures: Number(row.health_consecutive_failures ?? 0),
    config: {
      transport: row.transport === "stdio" ? "stdio" : "http",
      url: row.url,
      command: row.command,
      args: row.args ?? [],
      env: row.env ?? {},
      timeoutMs: row.timeout_ms,
    },
  };
}

const UPDATE_SQL = `
  update mcp_servers
     set health_status = $2,
         health_checked_at = now(),
         health_latency_ms = $3,
         health_last_error = $4,
         health_consecutive_failures = $5,
         health_alerted_at = case when $6 then now() else health_alerted_at end,
         updated_at = now()
   where id = $1
`;

export function nextHealthStatus(
  target: HealthTarget,
  ok: boolean,
  latencyMs: number | null,
  error: string | null,
): HealthUpdate {
  if (ok) {
    return { status: "healthy", failures: 0, latencyMs, error: null };
  }
  const failures = target.failures + 1;
  return {
    status: failures >= FAILURE_THRESHOLD ? "down" : "degraded",
    failures,
    latencyMs: null,
    error: (error ?? "探测失败").slice(0, 500),
  };
}

export function healthTransition(
  previous: McpHealthStatus,
  next: McpHealthStatus,
  ok: boolean,
): HealthTransition {
  if (ok) {
    return previous === "degraded" || previous === "down" ? "recovered" : null;
  }
  if (next === "down" && previous !== "down") {
    return "unhealthy";
  }
  if (next === "degraded" && (previous === "healthy" || previous === "unknown")) {
    return "unhealthy";
  }
  return null;
}

/** 并发探测（默认 3 路），返回每个连接器的新状态；不写库 */
export async function sweepConnectorHealth(
  targets: HealthTarget[],
  probe: ProbeFn = probeConnectorTools,
): Promise<ConnectorHealthResult[]> {
  const queue = [...targets];
  const results: ConnectorHealthResult[] = [];

  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const target = queue.shift();
      if (!target) {
        return;
      }
      const startedAt = Date.now();
      let ok = false;
      let error: string | null = null;
      try {
        await probe(target.config);
        ok = true;
      } catch (caught) {
        error = errorMessage(caught).slice(0, 500);
      }
      const latencyMs = ok ? Date.now() - startedAt : null;
      const update = nextHealthStatus(target, ok, latencyMs, error);
      results.push({
        tenantId: target.tenantId,
        serverId: target.id,
        name: target.name,
        previous: target.status,
        status: update.status,
        failures: update.failures,
        latencyMs,
        error: update.error,
        transition: healthTransition(target.status, update.status, ok),
      });
    }
  });

  await Promise.all(workers);
  return results;
}

function transitionAction(transition: HealthTransition): string {
  return transition === "recovered" ? "mcp.connector_recovered" : "mcp.connector_unhealthy";
}

function toAlert(result: ConnectorHealthResult): HealthAlert {
  return {
    event: result.transition === "recovered" ? "mcp.connector_recovered" : "mcp.connector_unhealthy",
    connector_id: result.serverId,
    connector_name: result.name,
    status: result.status,
    failures: result.failures,
    error: result.error,
    at: new Date().toISOString(),
  };
}

/** 设置页手动体检：读配置、探测、回写都在 L1 上下文内，审计带操作人 */
export async function checkConnectorsAsL1(
  context: UserContext,
  probe: ProbeFn = probeConnectorTools,
): Promise<ConnectorHealthResult[]> {
  const targets = await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings");
    const { rows } = await client.query<TargetRow>(
      `select ${TARGET_COLUMNS}
         from mcp_servers
        where enabled and tenant_id = $1
        order by created_at`,
      [context.tenantId],
    );
    return rows.map(toTarget);
  });

  const results = await sweepConnectorHealth(targets, probe);

  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings");
    for (const result of results) {
      await client.query(UPDATE_SQL, [
        result.serverId,
        result.status,
        result.latencyMs,
        result.error,
        result.failures,
        result.transition !== null,
      ]);
      if (result.transition) {
        await auditInTx(client, context, {
          actorUserId: context.userId,
          action: transitionAction(result.transition),
          targetType: "mcp_server",
          targetId: result.serverId,
          payload: {
            name: result.name,
            status: result.status,
            failures: result.failures,
            error: result.error,
            trigger: "manual",
          },
        });
      }
    }
  });

  return results;
}

export interface OwnerSweepOptions {
  probe?: ProbeFn;
  /** 只体检指定连接器（测试或定向复检）；为空 = 全部启用连接器 */
  serverIds?: string[];
  /** 状态迁移时回调（runner 用来推 webhook） */
  onAlert?: (alert: HealthAlert) => Promise<void>;
}

/**
 * 宿主机 runner 体检：owner 连接可见全部租户，不受用户上下文限制。
 * 写库与审计在同一事务内完成；告警在提交后发送，避免回滚后误报。
 */
export async function checkConnectorsAsOwner(
  client: Client,
  options: OwnerSweepOptions = {},
): Promise<ConnectorHealthResult[]> {
  const params: unknown[] = [];
  let where = "where enabled";
  if (options.serverIds && options.serverIds.length > 0) {
    params.push(options.serverIds);
    where += " and id = any($1::uuid[])";
  }
  const { rows } = await client.query<TargetRow>(
    `select ${TARGET_COLUMNS}
       from mcp_servers
      ${where}
      order by created_at`,
    params,
  );
  const targets = rows.map(toTarget);
  if (targets.length === 0) {
    return [];
  }

  const results = await sweepConnectorHealth(targets, options.probe ?? probeConnectorTools);

  await client.query("begin");
  try {
    for (const result of results) {
      await client.query(UPDATE_SQL, [
        result.serverId,
        result.status,
        result.latencyMs,
        result.error,
        result.failures,
        result.transition !== null,
      ]);
      if (result.transition) {
        await client.query(
          `insert into audit_events (tenant_id, actor_user_id, department_id, action, target_type, target_id, payload)
           values ($1, null, null, $2, 'mcp_server', $3, $4::jsonb)`,
          [
            result.tenantId,
            transitionAction(result.transition),
            result.serverId,
            JSON.stringify({
              name: result.name,
              status: result.status,
              failures: result.failures,
              error: result.error,
              trigger: "runner",
            }),
          ],
        );
      }
    }
    await client.query("commit");
  } catch (caught) {
    await client.query("rollback").catch(() => undefined);
    throw caught;
  }

  if (options.onAlert) {
    for (const result of results) {
      if (!result.transition) {
        continue;
      }
      await options.onAlert(toAlert(result)).catch((caught) => {
        log("warn", "mcp_health_alert_failed", { error: errorMessage(caught) });
      });
    }
  }

  return results;
}

/** 可选告警通道：MCP_ALERT_WEBHOOK（飞书/企业微信机器人等），不配置则只写审计 */
export async function sendHealthWebhook(alert: HealthAlert): Promise<void> {
  const endpoint = process.env.MCP_ALERT_WEBHOOK?.trim();
  if (!endpoint) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    log("warn", "mcp_health_webhook_invalid", {});
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    log("warn", "mcp_health_webhook_invalid", { protocol: parsed.protocol });
    return;
  }

  try {
    const response = await fetch(parsed, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      log("warn", "mcp_health_webhook_rejected", { status: response.status });
    }
  } catch (caught) {
    log("warn", "mcp_health_webhook_failed", { error: errorMessage(caught) });
  }
}
