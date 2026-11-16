/**
 * 目录路由纠偏统计（只读 + 重算）。
 *
 * 数据来自 folder_route_feedback 的日聚合；聚合行只对 L1 可见，
 * 但读取入口不额外判权：RLS 已经保证非 L1 拿到 0 行，页面按空态提示即可。
 */

import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";

export interface RouteStatsRow {
  day: string;
  channel: string;
  action: string;
  suggestedFolder: string | null;
  chosenFolder: string;
  total: number;
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
  days: number;
}

const MAX_ROWS = 200;

/** 读取最近 p_days 天的纠偏聚合；非 L1 因 RLS 只会拿到空结果 */
export async function loadRouteStats(context: UserContext, days = 30): Promise<RouteStatsView> {
  const window = clampDays(days);
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

    const row = summary.rows[0];
    return {
      rows: rows.rows,
      summary: {
        accepted: row?.accepted ?? 0,
        overridden: row?.overridden ?? 0,
        pendingResolved: row?.pending_resolved ?? 0,
        suggested: row?.suggested ?? 0,
        total: row?.total ?? 0,
      },
      days: window,
    };
  });
}

/** 重算最近 p_days 天的聚合行；函数内部只允许 L1，非 L1 会抛 42501 */
export async function recalcRouteStats(context: UserContext, days = 30): Promise<number> {
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
