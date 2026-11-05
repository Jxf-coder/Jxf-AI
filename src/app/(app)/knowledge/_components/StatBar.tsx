import { StatTile } from "@/components/knowledge/StatTile";
import type { KnowledgeStats } from "@/lib/knowledge/stats";

/** 知识库统计条：6 格，常驻在 Tab 上方 */
export function StatBar({ stats }: { stats: KnowledgeStats }) {
  const regression = stats.lastRegression;
  const regressionPassed =
    regression !== null && regression.passed === regression.total && regression.retained >= 0.9;

  return (
    <section className="mb-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label="知识库概览">
      <StatTile
        label="知识单元"
        value={stats.units}
        hint={`文档 ${stats.documents} · 卡片 ${stats.confirmedCards}`}
      />
      <StatTile
        label="待确认"
        value={stats.pendingCards}
        hint={stats.pendingCards > 0 ? "当天清零" : "已清零"}
        tone={stats.pendingCards > 0 ? "warn" : "ok"}
      />
      <StatTile
        label="冲突 / 过期"
        value={`${stats.conflicts} / ${stats.expired}`}
        hint="都应保持 0"
        tone={stats.conflicts > 0 || stats.expired > 0 ? "bad" : "ok"}
      />
      <StatTile
        label="缺口"
        value={stats.gapsOpen}
        hint={`已关闭 ${stats.gapsClosed}`}
        tone={stats.gapsOpen > 0 ? "warn" : "ok"}
      />
      <StatTile
        label="顾问问答"
        value={`${stats.qaWithSources}/${stats.qaTotal}`}
        hint={stats.qaFlagged > 0 ? `${stats.qaFlagged} 条引用 / 数字待核` : "有来源 / 总数"}
        tone={stats.qaFlagged > 0 ? "bad" : undefined}
      />
      <StatTile
        label="回归题"
        value={regression ? `${regression.passed}/${regression.total}` : "—"}
        hint={regression ? `保留率 ${Math.round(regression.retained * 100)}%` : "还没有回归记录"}
        tone={regression ? (regressionPassed ? "ok" : "bad") : undefined}
      />
    </section>
  );
}
