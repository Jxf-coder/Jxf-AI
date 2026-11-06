/**
 * M3 事件订阅：给 SSE 路由提供受 RLS 约束的只读连接。
 *
 * 设计：
 * - SSE 连接生命周期长，不能用请求事务（不能一直占着事务），因此用独立连接 + 会话级 GUC；
 * - 连接关闭即销毁，GUC 不会泄漏给连接池里的下一次请求；
 * - 事件按 seq 增量读取，前端断线带 Last-Event-ID 重连时只补发缺口。
 */

import { Client } from "pg";

import type { UserContext } from "@/lib/db/user-context";
import { loadEnv } from "@/lib/env";

export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
}

export interface RunSnapshot {
  id: string;
  status: string;
  lastSeq: number;
  partialText: string;
  result: Record<string, unknown>;
  error: string | null;
  usage: RunUsage;
  cancelRequested: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  partialUpdatedAt: string | null;
}

export interface RunEventRecord {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function isTerminalRunStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function toIso(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** 打开一条绑定当前用户身份的只读连接（调用方必须在结束时 close） */
export async function openRunStreamClient(context: UserContext): Promise<Client> {
  const client = new Client({
    connectionString: loadEnv().databaseUrl,
    application_name: "jxf-run-stream",
    query_timeout: 5_000,
    connectionTimeoutMillis: 3_000,
  });
  await client.connect();
  await client.query(
    `select
       set_config('app.user_id', $1, false),
       set_config('app.tenant_id', $2, false),
       set_config('app.access_level', $3, false),
       set_config('app.department_ids', $4, false),
       set_config('app.active_department_id', $5, false),
       set_config('app.membership_id', $6, false),
       set_config('app.permission_version', $7, false)`,
    [
      context.userId,
      context.tenantId,
      context.accessLevel ?? "",
      `{${context.departmentIds.join(",")}}`,
      context.activeDepartmentId ?? "",
      context.activeMembershipId ?? "",
      String(context.permissionVersion),
    ],
  );
  return client;
}

export async function closeRunStreamClient(client: Client): Promise<void> {
  await client.query("reset all").catch(() => undefined);
  await client.end().catch(() => undefined);
}

/** 读取运行快照；RLS 过滤后为空表示无权访问或不存在 */
export async function loadRunSnapshot(client: Client, runId: string): Promise<RunSnapshot | null> {
  const { rows } = await client.query<{
    id: string;
    status: string;
    last_seq: string | number;
    partial_text: string;
    result: Record<string, unknown> | null;
    error: string | null;
    prompt_tokens: string | number;
    completion_tokens: string | number;
    cost_micros: string | number;
    cancel_requested_at: Date | null;
    started_at: Date | null;
    finished_at: Date | null;
    partial_updated_at: Date | null;
  }>(
    `select id, status, last_seq, partial_text, result, error,
            prompt_tokens, completion_tokens, cost_micros,
            cancel_requested_at, started_at, finished_at, partial_updated_at
       from runs
      where id = $1`,
    [runId],
  );

  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    status: row.status,
    lastSeq: Number(row.last_seq),
    partialText: row.partial_text,
    result: row.result ?? {},
    error: row.error,
    usage: {
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      costMicros: Number(row.cost_micros),
    },
    cancelRequested: Boolean(row.cancel_requested_at),
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    partialUpdatedAt: toIso(row.partial_updated_at),
  };
}

/** 补发 durable 事件；单次上限 500，避免一次重连拉爆内存 */
export async function loadRunEventsAfter(
  client: Client,
  runId: string,
  afterSeq: number,
): Promise<RunEventRecord[]> {
  const { rows } = await client.query<{
    seq: string | number;
    type: string;
    payload: Record<string, unknown> | null;
    created_at: Date | null;
  }>(
    `select seq, type, payload, created_at
       from run_events
      where run_id = $1 and seq > $2
      order by seq
      limit 500`,
    [runId, afterSeq],
  );

  return rows.map((row) => ({
    seq: Number(row.seq),
    type: row.type,
    payload: row.payload ?? {},
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
  }));
}
