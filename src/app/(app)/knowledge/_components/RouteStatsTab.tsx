import { EmptyState } from "@/components/knowledge/EmptyState";
import { SectionCard } from "@/components/knowledge/SectionCard";
import { meta } from "@/components/knowledge/tokens";
import type { UserContext } from "@/lib/db/user-context";
import { folderLabel } from "@/lib/knowledge/folders";
import { loadRouteStats } from "@/lib/knowledge/route-stats";

import { RouteStatsPanel } from "../RouteStatsPanel";

interface RouteStatsTabProps {
  context: UserContext;
}

const ACTION_LABEL: Record<string, string> = {
  accepted: "采纳建议",
  overridden: "人工改目录",
  pending_resolved: "待裁决后落定",
};

const CHANNEL_LABEL: Record<string, string> = {
  document: "文档",
  skill: "技能",
  pipeline: "产线",
  review: "验收",
  retro: "复盘",
  connector: "连接器",
  manual: "手动",
};

function percent(part: number, total: number): string {
  if (total <= 0) {
    return "—";
  }
  return `${((part / total) * 100).toFixed(1)}%`;
}

function formatHours(value: number | null): string {
  if (value === null) {
    return "—";
  }
  if (value < 1) {
    return `${Math.round(value * 60)} 分钟`;
  }
  return `${value.toFixed(1)} 小时`;
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function formatDuration(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

/** 路由纠偏：最近 30 天的聚合行 + 纠偏率概览（仅 L1 有数据） */
export async function RouteStatsTab({ context }: RouteStatsTabProps) {
  const stats = await loadRouteStats(context, 30);
  const decided = stats.summary.accepted + stats.summary.overridden;

  return (
    <>
      {context.accessLevel === "L1" ? <RouteStatsPanel /> : null}

      {stats.summary.total === 0 &&
      stats.channelCost.length === 0 &&
      stats.pendingAging.pendingNow === 0 &&
      stats.outcomes.pending + stats.outcomes.confirmed + stats.outcomes.dropped === 0 ? (
        <SectionCard title="路由纠偏概览" desc="确认或调整过卡片目录之后才会产生纠偏记录。">
          <EmptyState>
            {context.accessLevel === "L1"
              ? "最近 30 天还没有纠偏数据。可以点上面的「重算」把历史记录汇总进来。"
              : "只有 L1 可以查看跨部门的纠偏统计。"}
          </EmptyState>
        </SectionCard>
      ) : (
        <>
          <SectionCard
            title="路由纠偏概览"
            right={<span className={meta}>最近 {stats.days} 天</span>}
            desc="纠偏率 = 人工改目录次数 /（采纳 + 人工改目录）；有建议目录占比反映规则命中率。"
          >
            <ul className="mt-1 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-4">
              {[
                { label: "总记录", value: stats.summary.total },
                { label: "采纳建议", value: stats.summary.accepted },
                { label: "人工改目录", value: stats.summary.overridden },
                { label: "纠偏率", value: percent(stats.summary.overridden, decided) },
              ].map((item) => (
                <li key={item.label} className="rounded-xl bg-apple-canvas px-3 py-2">
                  <div className={`${meta} text-[11px]`}>{item.label}</div>
                  <div className="mt-0.5 text-[17px] font-semibold text-zinc-900">{item.value}</div>
                </li>
              ))}
            </ul>
            <p className={`${meta} mt-3`}>
              有建议目录 {stats.summary.suggested} 次 · 待裁决后落定 {stats.summary.pendingResolved} 次
            </p>
          </SectionCard>

          <SectionCard
            title="规则命中分布"
            count={stats.byRule.length}
            desc="按路由原因汇总窗口内的纠偏样本；纠偏率越高说明该规则越需要调整。"
          >
            {stats.byRule.length === 0 ? (
              <EmptyState>窗口内还没有纠偏样本。</EmptyState>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full border-separate border-spacing-y-1 text-[13px]">
                  <thead>
                    <tr className={`${meta} text-left`}>
                      <th className="px-2 py-1 font-medium">路由原因</th>
                      <th className="px-2 py-1 text-right font-medium">样本</th>
                      <th className="px-2 py-1 text-right font-medium">采纳</th>
                      <th className="px-2 py-1 text-right font-medium">改目录</th>
                      <th className="px-2 py-1 text-right font-medium">待裁决落定</th>
                      <th className="px-2 py-1 text-right font-medium">纠偏率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.byRule.map((rule) => (
                      <tr key={rule.reason} className="bg-apple-canvas/60">
                        <td className="rounded-l-xl px-2 py-1.5 text-zinc-800">{rule.reason}</td>
                        <td className="px-2 py-1.5 text-right text-zinc-700">{rule.total}</td>
                        <td className="px-2 py-1.5 text-right text-zinc-700">{rule.accepted}</td>
                        <td className="px-2 py-1.5 text-right text-zinc-700">{rule.overridden}</td>
                        <td className="px-2 py-1.5 text-right text-zinc-700">
                          {rule.pendingResolved}
                        </td>
                        <td className="rounded-r-xl px-2 py-1.5 text-right font-medium text-zinc-900">
                          {percent(rule.overridden, rule.accepted + rule.overridden)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="待定目录与确认结果"
            desc="待定目录只统计当前仍 route_pending 的卡；确认/作废率按窗口内新建卡片计算。"
          >
            <ul className="mt-1 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-4">
              {[
                { label: "仍待裁决", value: stats.pendingAging.pendingNow },
                { label: "平均等待", value: formatHours(stats.pendingAging.avgPendingHours) },
                { label: "最久等待", value: formatHours(stats.pendingAging.oldestPendingHours) },
                {
                  label: "落定平均耗时",
                  value: formatHours(stats.pendingAging.avgResolveHours),
                },
              ].map((item) => (
                <li key={item.label} className="rounded-xl bg-apple-canvas px-3 py-2">
                  <div className={`${meta} text-[11px]`}>{item.label}</div>
                  <div className="mt-0.5 text-[17px] font-semibold text-zinc-900">{item.value}</div>
                </li>
              ))}
            </ul>
            <p className={`${meta} mt-3`}>
              窗口内新建卡片：待确认 {stats.outcomes.pending} · 已确认 {stats.outcomes.confirmed} ·
              已作废 {stats.outcomes.dropped} · 确认率{" "}
              {percent(
                stats.outcomes.confirmed,
                stats.outcomes.confirmed + stats.outcomes.dropped,
              )}{" "}
              · 待裁决后落定 {stats.pendingAging.resolved} 次
            </p>
          </SectionCard>

          <SectionCard
            title="通道成本"
            count={stats.channelCost.length}
            desc="按通道汇总窗口内经验任务数、产出卡数、token 用量与平均耗时；无 AI 时 token 为 0。"
          >
            {stats.channelCost.length === 0 ? (
              <EmptyState>窗口内还没有经验任务。</EmptyState>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full border-separate border-spacing-y-1 text-[13px]">
                  <thead>
                    <tr className={`${meta} text-left`}>
                      <th className="px-2 py-1 font-medium">通道</th>
                      <th className="px-2 py-1 text-right font-medium">任务</th>
                      <th className="px-2 py-1 text-right font-medium">产出卡</th>
                      <th className="px-2 py-1 text-right font-medium">输入 token</th>
                      <th className="px-2 py-1 text-right font-medium">输出 token</th>
                      <th className="px-2 py-1 text-right font-medium">平均耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.channelCost.map((cost) => (
                      <tr key={cost.channel} className="bg-apple-canvas/60">
                        <td className="rounded-l-xl px-2 py-1.5 text-zinc-800">
                          {CHANNEL_LABEL[cost.channel] ?? cost.channel}
                        </td>
                        <td className="px-2 py-1.5 text-right text-zinc-700">{cost.jobs}</td>
                        <td className="px-2 py-1.5 text-right text-zinc-700">{cost.cards}</td>
                        <td className="px-2 py-1.5 text-right text-zinc-700">
                          {formatTokens(cost.promptTokens)}
                        </td>
                        <td className="px-2 py-1.5 text-right text-zinc-700">
                          {formatTokens(cost.completionTokens)}
                        </td>
                        <td className="rounded-r-xl px-2 py-1.5 text-right font-medium text-zinc-900">
                          {formatDuration(cost.avgDurationMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="逐日明细"
            count={stats.rows.length}
            desc="按天、通道、动作与建议/最终目录汇总；最多展示 200 行。"
          >
            <div className="mt-2 overflow-x-auto">
              <table className="w-full border-separate border-spacing-y-1 text-[13px]">
                <thead>
                  <tr className={`${meta} text-left`}>
                    <th className="px-2 py-1 font-medium">日期</th>
                    <th className="px-2 py-1 font-medium">通道</th>
                    <th className="px-2 py-1 font-medium">动作</th>
                    <th className="px-2 py-1 font-medium">建议目录</th>
                    <th className="px-2 py-1 font-medium">最终目录</th>
                    <th className="px-2 py-1 text-right font-medium">次数</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.rows.map((row) => (
                    <tr
                      key={`${row.day}-${row.channel}-${row.action}-${row.suggestedFolder ?? "-"}-${row.chosenFolder}`}
                      className="bg-apple-canvas/60"
                    >
                      <td className="rounded-l-xl px-2 py-1.5 text-zinc-700">{row.day}</td>
                      <td className="px-2 py-1.5 text-zinc-700">{row.channel}</td>
                      <td className="px-2 py-1.5 text-zinc-700">
                        {ACTION_LABEL[row.action] ?? row.action}
                      </td>
                      <td className="px-2 py-1.5 text-zinc-500">
                        {row.suggestedFolder ? folderLabel(row.suggestedFolder) : "—"}
                      </td>
                      <td className="px-2 py-1.5 text-zinc-900">{folderLabel(row.chosenFolder)}</td>
                      <td className="rounded-r-xl px-2 py-1.5 text-right font-medium text-zinc-900">
                        {row.total}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </>
      )}
    </>
  );
}
