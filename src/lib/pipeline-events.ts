/**
 * 产线内部事件总线。
 *
 * - 生产者（Web / Worker / 宿主机 runner）只调用 app.publish_event() 追加事件；
 * - 订阅关系存在 pipeline_event_subscriptions（每个产线每类事件一条）；
 * - 宿主机 runner 周期性调用 dispatchPipelineEvents()，按订阅以产线发起人身份运行；
 * - 事件最多尝试 3 轮，失败原因写入 last_error，避免坏订阅无限重试。
 */

import type { Client } from "pg";

import { auditInTx } from "@/lib/audit";
import { withUserContext, type UserContext } from "@/lib/db/user-context";
import { errorMessage, log } from "@/lib/logger";
import { requireContextPermission } from "@/lib/permissions/server";
import type { PermissionResource } from "@/types/permission";

import type { PipelineActorResolver } from "./pipeline-runner";
import { PipelineInputError, runPipeline } from "./pipelines";

export const PIPELINE_EVENT_TYPES = [
  "knowledge.ingest_done",
  "mcp.connector_changed",
  "work_item.finished",
] as const;

export type PipelineEventType = (typeof PIPELINE_EVENT_TYPES)[number];

export const PIPELINE_EVENT_LABELS: Record<PipelineEventType, string> = {
  "knowledge.ingest_done": "知识库入库完成",
  "mcp.connector_changed": "MCP 连接器状态变更",
  "work_item.finished": "AI 员工任务结束",
};

export function isPipelineEventType(value: string): value is PipelineEventType {
  return (PIPELINE_EVENT_TYPES as readonly string[]).includes(value);
}

export interface PublishEventInput {
  tenantId: string;
  eventType: PipelineEventType;
  payload?: Record<string, unknown>;
}

/** 写入事件总线；返回事件 id（供触发追溯） */
export async function publishPipelineEvent(
  client: Pick<Client, "query">,
  input: PublishEventInput,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string | null }>(
    "select app.publish_event($1, $2, $3::jsonb) as id",
    [input.tenantId, input.eventType, JSON.stringify(input.payload ?? {})],
  );
  return rows[0]?.id ?? null;
}

/** 生产侧安全包装：事件写入失败只告警，不影响主流程 */
export async function publishPipelineEventSafe(
  client: Pick<Client, "query">,
  input: PublishEventInput,
): Promise<string | null> {
  try {
    return await publishPipelineEvent(client, input);
  } catch (caught) {
    log("warn", "pipeline_event_publish_failed", {
      event_type: input.eventType,
      error: errorMessage(caught),
    });
    return null;
  }
}

function departmentResource(context: UserContext): PermissionResource {
  const departmentId = context.activeDepartmentId;
  return { kind: "department", id: departmentId ?? undefined, departmentId };
}

/** 订阅 / 取消订阅（应用层要求 pipeline:manage；RLS 再按产线可见性收口） */
export async function setPipelineEventSubscription(
  context: UserContext,
  pipelineId: string,
  eventType: PipelineEventType,
  enabled: boolean,
): Promise<void> {
  if (!isPipelineEventType(eventType)) {
    throw new PipelineInputError("不支持的事件类型");
  }
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "pipeline:manage", departmentResource(context));

    const pipeline = await client.query<{ id: string }>(
      "select id from pipelines where id = $1 and tenant_id = $2",
      [pipelineId, context.tenantId],
    );
    if (!pipeline.rows[0]) {
      throw new PipelineInputError("产线不存在或无权操作");
    }

    if (enabled) {
      await client.query(
        `insert into pipeline_event_subscriptions
           (tenant_id, pipeline_id, event_type, enabled, created_by)
         values ($1, $2, $3, true, $4)
         on conflict (pipeline_id, event_type)
         do update set enabled = true`,
        [context.tenantId, pipelineId, eventType, context.userId],
      );
    } else {
      await client.query(
        `update pipeline_event_subscriptions
            set enabled = false
          where pipeline_id = $1 and event_type = $2`,
        [pipelineId, eventType],
      );
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: enabled ? "pipeline.event_subscribed" : "pipeline.event_unsubscribed",
      targetType: "pipeline",
      targetId: pipelineId,
      departmentId: context.activeDepartmentId,
      payload: { event_type: eventType },
    });
  });
}

export interface PipelineBridgeEventView {
  id: string;
  eventType: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface PipelineBridgeSubscriptionView {
  pipelineId: string;
  pipelineName: string;
  eventType: string;
  enabled: boolean;
}

export interface PipelineBridgeWebhookView {
  id: string;
  name: string;
  enabled: boolean;
}

export interface PipelineEventBridgeView {
  events: PipelineBridgeEventView[];
  subscriptions: PipelineBridgeSubscriptionView[];
  webhooks: PipelineBridgeWebhookView[];
}

/** MCP「订阅桥」视图：事件总线、订阅关系与外部 Webhook 触发入口 */
export async function listPipelineEventBridge(
  context: UserContext,
  limit = 20,
): Promise<PipelineEventBridgeView> {
  const capped = Math.min(Math.max(limit, 1), 50);
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings");
    const events = await client.query<{
      id: string;
      event_type: string;
      status: string;
      attempts: number;
      last_error: string | null;
      created_at: Date;
      processed_at: Date | null;
    }>(
      `select id, event_type, status, attempts, last_error, created_at, processed_at
         from pipeline_events
        where tenant_id = $1
        order by created_at desc
        limit $2`,
      [context.tenantId, capped],
    );
    const subscriptions = await client.query<{
      pipeline_id: string;
      pipeline_name: string;
      event_type: string;
      enabled: boolean;
    }>(
      `select s.pipeline_id, p.name as pipeline_name, s.event_type, s.enabled
         from pipeline_event_subscriptions s
         join pipelines p on p.id = s.pipeline_id
        where s.tenant_id = $1
        order by s.created_at desc
        limit 50`,
      [context.tenantId],
    );
    const webhooks = await client.query<{ id: string; name: string; enabled: boolean }>(
      `select id, name, enabled
         from pipelines
        where tenant_id = $1 and webhook_enabled
        order by created_at desc
        limit 50`,
      [context.tenantId],
    );
    return {
      events: events.rows.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        status: row.status,
        attempts: Number(row.attempts),
        lastError: row.last_error,
        createdAt: row.created_at.toISOString(),
        processedAt: row.processed_at?.toISOString() ?? null,
      })),
      subscriptions: subscriptions.rows.map((row) => ({
        pipelineId: row.pipeline_id,
        pipelineName: row.pipeline_name,
        eventType: row.event_type,
        enabled: row.enabled,
      })),
      webhooks: webhooks.rows.map((row) => ({
        id: row.id,
        name: row.name,
        enabled: row.enabled,
      })),
    };
  });
}

interface PendingEventRow {
  id: string;
  tenant_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  attempts: number;
}

interface SubscriptionRow {
  pipeline_id: string;
  pipeline_name: string;
  actor_id: string | null;
}

export interface DispatchOutcome {
  eventId: string;
  eventType: string;
  triggered: number;
  errors: string[];
  status: "processed" | "pending" | "failed";
}

const MAX_ATTEMPTS = 3;

/**
 * 派发 pending 事件：按订阅运行产线。
 * 运行发生在 jxf_app + RLS 上下文中（产线发起人），runner 只负责编排。
 */
export async function dispatchPipelineEvents(
  owner: Client,
  hooks: PipelineActorResolver,
  options: { limit?: number; eventIds?: string[] } = {},
): Promise<DispatchOutcome[]> {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const params: unknown[] = [];
  let filter = "";
  if (options.eventIds && options.eventIds.length > 0) {
    params.push(options.eventIds);
    filter = `and id = any($1::uuid[])`;
  }
  params.push(limit);

  const { rows } = await owner.query<PendingEventRow>(
    `select id, tenant_id, event_type, payload, attempts
       from pipeline_events
      where status = 'pending'
        ${filter}
      order by created_at
      limit $${params.length}`,
    params,
  );

  const outcomes: DispatchOutcome[] = [];

  for (const event of rows) {
    const subscriptions = await owner.query<SubscriptionRow>(
      `select s.pipeline_id, p.name as pipeline_name,
              coalesce(p.created_by, s.created_by) as actor_id
         from pipeline_event_subscriptions s
         join pipelines p on p.id = s.pipeline_id
        where s.tenant_id = $1
          and s.event_type = $2
          and s.enabled
          and p.enabled
        order by s.created_at`,
      [event.tenant_id, event.event_type],
    );

    const runIds: string[] = [];
    const errors: string[] = [];

    for (const subscription of subscriptions.rows) {
      if (!subscription.actor_id) {
        errors.push(`${subscription.pipeline_name}: 产线没有发起人`);
        continue;
      }
      try {
        const context = await hooks.resolveContext(subscription.actor_id);
        if (!context.activeDepartmentId) {
          throw new Error("发起人已无有效任用");
        }
        const result = await runPipeline(context, subscription.pipeline_id, {
          trigger: "event",
          triggerRef: `event:${event.id}`,
        });
        runIds.push(result.runId);
        if (result.failedStep) {
          errors.push(`${subscription.pipeline_name}: 首步「${result.failedStep}」派发失败`);
        }
      } catch (caught) {
        errors.push(`${subscription.pipeline_name}: ${errorMessage(caught)}`);
      }
    }

    const attempts = event.attempts + 1;
    const status: DispatchOutcome["status"] =
      errors.length === 0 ? "processed" : attempts >= MAX_ATTEMPTS ? "failed" : "pending";

    await owner.query(
      `update pipeline_events
          set status = $2,
              attempts = $3,
              last_error = $4,
              run_ids = run_ids || $5::uuid[],
              processed_at = case when $2 = 'pending' then null else now() end
        where id = $1`,
      [
        event.id,
        status,
        attempts,
        errors.length > 0 ? errors.join("; ").slice(0, 2000) : null,
        runIds,
      ],
    );

    outcomes.push({
      eventId: event.id,
      eventType: event.event_type,
      triggered: runIds.length,
      errors,
      status,
    });
  }

  return outcomes;
}
