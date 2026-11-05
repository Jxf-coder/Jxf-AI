/**
 * 知识库统计聚合（只读）。
 *
 * 所有计数都在 withUserContext 的 jxf_app 连接内执行，由 RLS 兜底：
 * 不能换成 owner 连接，否则会把兄弟部门的数据算进来。
 */

import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";

export interface RegressionSummary {
  passed: number;
  total: number;
  retained: number;
}

export interface KnowledgeStats {
  /** 已解析文档数 */
  documents: number;
  /** 切片总数 */
  chunks: number;
  /** 已确认知识卡 */
  confirmedCards: number;
  /** 待确认知识卡 */
  pendingCards: number;
  /** 存在冲突的存活卡片 */
  conflicts: number;
  /** 已过期（已确认且 valid_until 早于今天） */
  expired: number;
  gapsOpen: number;
  gapsClosed: number;
  qaTotal: number;
  qaWithSources: number;
  /** 引用越界或数字未核实的问答条数 */
  qaFlagged: number;
  /** 知识单元 = 已解析文档 + 已确认卡片 */
  units: number;
  /** 分类分布（未分类归入「未分类」） */
  byCategory: Record<string, number>;
  lastRegression: RegressionSummary | null;
}

interface StatsRow {
  documents: number;
  chunks: number;
  confirmed_cards: number;
  pending_cards: number;
  conflicts: number;
  expired: number;
  gaps_open: number;
  gaps_closed: number;
  qa_total: number;
  qa_with_sources: number;
  qa_flagged: number;
  by_category: Record<string, number> | null;
  last_regression: RegressionSummary | null;
}

export async function loadKnowledgeStats(context: UserContext): Promise<KnowledgeStats> {
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<StatsRow>(
      `select
         (select count(*) from documents where status = 'parsed')::int as documents,
         (select count(*) from doc_chunks)::int as chunks,
         (select count(*) from knowledge_cards where status = 'confirmed')::int as confirmed_cards,
         (select count(*) from knowledge_cards where status = 'pending')::int as pending_cards,
         (select count(*) from knowledge_cards
           where status <> 'dropped' and conflict_with <> '{}')::int as conflicts,
         (select count(*) from knowledge_cards
           where status = 'confirmed' and valid_until is not null and valid_until < current_date)::int as expired,
         (select count(*) from knowledge_gaps where status = 'open')::int as gaps_open,
         (select count(*) from knowledge_gaps where status <> 'open')::int as gaps_closed,
         (select count(*) from qa_logs)::int as qa_total,
         (select count(*) from qa_logs where cited_card_ids <> '{}')::int as qa_with_sources,
         (select count(*) from qa_logs
           where invalid_cites <> '{}' or unverified_numbers <> '{}')::int as qa_flagged,
         (select coalesce(json_object_agg(category, cnt), '{}'::json)
            from (select coalesce(category, '未分类') as category, count(*)::int as cnt
                    from knowledge_cards
                   where status <> 'dropped'
                   group by 1) t) as by_category,
         (select row_to_json(r)
            from (select passed, total, retained
                    from regression_runs
                   order by created_at desc
                   limit 1) r) as last_regression`,
    );

    const row = rows[0];
    const documents = row?.documents ?? 0;
    const confirmedCards = row?.confirmed_cards ?? 0;

    return {
      documents,
      chunks: row?.chunks ?? 0,
      confirmedCards,
      pendingCards: row?.pending_cards ?? 0,
      conflicts: row?.conflicts ?? 0,
      expired: row?.expired ?? 0,
      gapsOpen: row?.gaps_open ?? 0,
      gapsClosed: row?.gaps_closed ?? 0,
      qaTotal: row?.qa_total ?? 0,
      qaWithSources: row?.qa_with_sources ?? 0,
      qaFlagged: row?.qa_flagged ?? 0,
      units: documents + confirmedCards,
      byCategory: row?.by_category ?? {},
      lastRegression: row?.last_regression
        ? {
            passed: Number(row.last_regression.passed),
            total: Number(row.last_regression.total),
            retained: Number(row.last_regression.retained),
          }
        : null,
    };
  });
}
