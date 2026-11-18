/**
 * 目录路由纠偏统计（只读 + 重算）。
 *
 * 数据来自 folder_route_feedback 的日聚合；聚合行只对 L1 可见，
 * 但读取入口不额外判权：RLS 已经保证非 L1 拿到 0 行，页面按空态提示即可。
 */

import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { PermissionDeniedError } from "@/lib/permissions/guard";

export interface RouteStatsRow {
  day: string;
  channel: string;
  action: string;
  suggestedFolder: string | null;
  chosenFolder: string;
  total: number;
}

export interface RouteRuleStat {
  reason: string;
  total: number;
  accepted: number;
  overridden: number;
  pendingResolved: number;
}

export interface PendingAgingStats {
  /** 当前仍待人工裁决的卡片数 */
  pendingNow: number;
  /** 待裁决卡片平均等待小时数 */
  avgPendingHours: number | null;
  /** 最久待裁决小时数 */
  oldestPendingHours: number | null;
  /** 窗口内「待裁决后落定」的次数 */
  resolved: number;
  /** 从建卡到落定的平均小时数 */
  avgResolveHours: number | null;
}

export interface CardOutcomeStats {
  pending: number;
  confirmed: number;
  dropped: number;
}

export interface ChannelCostStat {
  channel: string;
  jobs: number;
  cards: number;
  promptTokens: number;
  completionTokens: number;
  avgDurationMs: number | null;
}

export interface RouteStatsSummary {
  /** 被采纳的路由次数 */
  accepted: number;
  /** 被人工改到其他目录的次数 */
  overridden: number;
  /** 待人工裁决后落定的次数 */
  pendingResolved: number;
  /** 当时有建议目录的次数（用于看规则覆盖率） */
  suggested: number;
  total: number;
}

export interface RouteStatsView {
  rows: RouteStatsRow[];
  summary: RouteStatsSummary;
  byRule: RouteRuleStat[];
  pendingAging: PendingAgingStats;
  outcomes: CardOutcomeStats;
  channelCost: ChannelCostStat[];
  days: number;
}

const MAX_ROWS = 200;

/** 读取最近 p_days 天的纠偏聚合与扩展维度；非 L1 因 RLS 只会拿到空结果 */
export async function loadRouteStats(context: UserContext, days = 30): Promise<RouteStatsView> {
  const window = clampDays(days);
  if (context.accessLevel !== "L1") {
    return {
      rows: [],
      summary: { accepted: 0, overridden: 0, pendingResolved: 0, suggested: 0, total: 0 },
      byRule: [],
      pendingAging: {
        pendingNow: 0,
        avgPendingHours: null,
        oldestPendingHours: null,
        resolved: 0,
        avgResolveHours: null,
      },
      outcomes: { pending: 0, confirmed: 0, dropped: 0 },
      channelCost: [],
      days: window,
    };
  }

  return withUserContext(context, async (client) => {
    const rows = await client.query<RouteStatsRow>(
      `select to_char(day, 'YYYY-MM-DD') as day,
              channel,
              action,
              suggested_folder,
              chosen_folder,
              total
         from folder_route_stats_daily
        where tenant_id = $1
          and day >= current_date - make_interval(days => $2)
        order by day desc, total desc
        limit ${MAX_ROWS}`,
      [context.tenantId, window],
    );

    const summary = await client.query<{
      accepted: number;
      overridden: number;
      pending_resolved: number;
      suggested: number;
      total: number;
    }>(
      `select coalesce(sum(total) filter (where action = 'accepted'), 0)::int as accepted,
              coalesce(sum(total) filter (where action = 'overridden'), 0)::int as overridden,
              coalesce(sum(total) filter (where action = 'pending_resolved'), 0)::int as pending_resolved,
              coalesce(sum(total) filter (where suggested_folder is not null), 0)::int as suggested,
              coalesce(sum(total), 0)::int as total
         from folder_route_stats_daily
        where tenant_id = $1
          and day >= current_date - make_interval(days => $2)`,
      [context.tenantId, window],
    );

    const byRule = await client.query<{
      reason: string;
      total: number;
      accepted: number;
      overridden: number;
      pending_resolved: number;
    }>(
      `select coalesce(route_reason, '未知规则') as reason,
              count(*)::int as total,
              count(*) filter (where action = 'accepted')::int as accepted,
              count(*) filter (where action = 'overridden')::int as overridden,
              count(*) filter (where action = 'pending_resolved')::int as pending_resolved
         from folder_route_feedback
        where tenant_id = $1
          and created_at >= now() - make_interval(days => $2)
        group by 1
        order by total desc
        limit 20`,
      [context.tenantId, window],
    );

    const pendingNow = await client.query<{
      pending_now: number;
      avg_pending_hours: number | null;
      oldest_pending_hours: number | null;
    }>(
      `select count(*)::int as pending_now,
              avg(extract(epoch from (now() - created_at)) / 3600)::float as avg_pending_hours,
              max(extract(epoch from (now() - created_at)) / 3600)::float as oldest_pending_hours
         from knowledge_cards
        where tenant_id = $1
          and route_pending = true
          and status in ('pending', 'confirmed')`,
      [context.tenantId],
    );

    const resolved = await client.query<{ resolved: number; avg_resolve_hours: number | null }>(
      `select count(*)::int as resolved,
              avg(extract(epoch from (f.created_at - c.created_at)) / 3600)::float as avg_resolve_hours
         from folder_route_feedback f
         join knowledge_cards c on c.id = f.card_id
        where f.tenant_id = $1
          and f.action = 'pending_resolved'
          and f.created_at >= now() - make_interval(days => $2)`,
      [context.tenantId, window],
    );

    const outcomes = await client.query<{
      pending: number;
      confirmed: number;
      dropped: number;
    }>(
      `select count(*) filter (where status = 'pending')::int as pending,
              count(*) filter (where status = 'confirmed')::int as confirmed,
              count(*) filter (where status = 'dropped')::int as dropped
         from knowledge_cards
        where tenant_id = $1
          and created_at >= now() - make_interval(days => $2)`,
      [context.tenantId, window],
    );

    const channelCost = await client.query<{
      channel: string;
      jobs: number;
      cards: number;
      prompt_tokens: number;
      completion_tokens: number;
      avg_duration_ms: number | null;
    }>(
      `select channel,
              count(*)::int as jobs,
              coalesce(sum(cardinality(result_card_ids)), 0)::int as cards,
              coalesce(sum(nullif(source_meta ->> 'promptTokens', '')::int), 0)::int as prompt_tokens,
              coalesce(sum(nullif(source_meta ->> 'completionTokens', '')::int), 0)::int as completion_tokens,
              avg(nullif(source_meta ->> 'durationMs', '')::float) as avg_duration_ms
         from experience_jobs
        where tenant_id = $1
          and created_at >= now() - make_interval(days => $2)
        group by channel
        order by jobs desc`,
      [context.tenantId, window],
    );

    const row = summary.rows[0];
    const pendingRow = pendingNow.rows[0];
    const resolvedRow = resolved.rows[0];
    const outcomeRow = outcomes.rows[0];
    return {
      rows: rows.rows,
      summary: {
        accepted: row?.accepted ?? 0,
        overridden: row?.overridden ?? 0,
        pendingResolved: row?.pending_resolved ?? 0,
        suggested: row?.suggested ?? 0,
        total: row?.total ?? 0,
      },
      byRule: byRule.rows.map((item) => ({
        reason: item.reason,
        total: item.total,
        accepted: item.accepted,
        overridden: item.overridden,
        pendingResolved: item.pending_resolved,
      })),
      pendingAging: {
        pendingNow: pendingRow?.pending_now ?? 0,
        avgPendingHours: toFloat(pendingRow?.avg_pending_hours),
        oldestPendingHours: toFloat(pendingRow?.oldest_pending_hours),
        resolved: resolvedRow?.resolved ?? 0,
        avgResolveHours: toFloat(resolvedRow?.avg_resolve_hours),
      },
      outcomes: {
        pending: outcomeRow?.pending ?? 0,
        confirmed: outcomeRow?.confirmed ?? 0,
        dropped: outcomeRow?.dropped ?? 0,
      },
      channelCost: channelCost.rows.map((item) => ({
        channel: item.channel,
        jobs: item.jobs,
        cards: item.cards,
        promptTokens: item.prompt_tokens,
        completionTokens: item.completion_tokens,
        avgDurationMs: toFloat(item.avg_duration_ms),
      })),
      days: window,
    };
  });
}

/** 重算最近 p_days 天的聚合行；仅 L1 可执行，非 L1 直接拒绝 */
export async function recalcRouteStats(context: UserContext, days = 30): Promise<number> {
  if (context.accessLevel !== "L1") {
    throw new PermissionDeniedError({
      allowed: false,
      reason: "只有 L1 可以重算目录纠偏统计",
    });
  }
  const window = clampDays(days);
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<{ rows: number }>(
      "select app.rollup_folder_route_stats($1) as rows",
      [window],
    );
    return rows[0]?.rows ?? 0;
  });
}

function clampDays(days: number): number {
  if (!Number.isFinite(days)) {
    return 30;
  }
  return Math.min(3650, Math.max(1, Math.trunc(days)));
}

function toFloat(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
