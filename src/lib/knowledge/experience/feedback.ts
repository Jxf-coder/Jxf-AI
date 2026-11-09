/**
 * 目录路由纠偏样本：确认时记 accepted、改目录时记 overridden / pending_resolved。
 *
 * 只存规则命中特征，不存完整原文；离线统计纠偏率，不做在线自动学习。
 */

import type { PoolClient } from "pg";

import type { UserContext } from "@/lib/db/user-context";

export type RouteFeedbackAction = "accepted" | "overridden" | "pending_resolved";

export interface RouteFeedbackInput {
  departmentId: string;
  cardId: string;
  jobId?: string | null;
  channel: string;
  kind?: string | null;
  action: RouteFeedbackAction;
  suggestedFolder?: string | null;
  chosenFolder?: string | null;
  routeConfidence?: number | null;
  routeReason?: string | null;
  routePending?: boolean;
  features?: Record<string, unknown>;
}

export async function recordRouteFeedback(
  client: PoolClient,
  context: UserContext,
  input: RouteFeedbackInput,
): Promise<void> {
  await client.query(
    `insert into folder_route_feedback
       (tenant_id, department_id, card_id, job_id, channel, kind, action,
        suggested_folder, chosen_folder, route_confidence, route_reason, route_pending,
        features, actor_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
    [
      context.tenantId,
      input.departmentId,
      input.cardId,
      input.jobId ?? null,
      input.channel,
      input.kind ?? null,
      input.action,
      input.suggestedFolder ?? null,
      input.chosenFolder ?? null,
      input.routeConfidence ?? null,
      input.routeReason ?? null,
      input.routePending ?? false,
      JSON.stringify(input.features ?? {}),
      context.userId,
    ],
  );
}
