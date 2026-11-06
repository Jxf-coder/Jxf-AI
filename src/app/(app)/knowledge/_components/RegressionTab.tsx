import { EmptyState } from "@/components/knowledge/EmptyState";
import { Pill } from "@/components/knowledge/Pill";
import { SectionCard } from "@/components/knowledge/SectionCard";
import { meta } from "@/components/knowledge/tokens";
import type { UserContext } from "@/lib/db/user-context";
import { listLastRunItems, listRegressionQuestions } from "@/lib/knowledge/regression";

import { RegressionPanel } from "../RegressionPanel";
import { RegressionQuestions } from "./RegressionQuestions";

interface RegressionTabProps {
  context: UserContext;
  canWrite: boolean;
}

/** 回归题：基线题集维护 + 运行门禁 + 最近一次逐题结果 */
export async function RegressionTab({ context, canWrite }: RegressionTabProps) {
  const [questions, last] = await Promise.all([
    listRegressionQuestions(context, 50),
    listLastRunItems(context),
  ]);

  return (
    <>
      {canWrite ? <RegressionPanel /> : null}

      <SectionCard
        title="基线题集"
        count={questions.length}
        desc="题目来自已确认卡标题或手写；每道题记录当时的命中卡作基线，改动分块或模型后跑一轮看保留率。"
      >
        <RegressionQuestions
          canWrite={canWrite}
          questions={questions.map((item) => ({
            id: item.id,
            q: item.q,
            baselineCount: item.baselineCount,
          }))}
        />
      </SectionCard>

      {last ? (
        <SectionCard
          title="最近一次逐题结果"
          count={`${last.run.passed}/${last.run.total}`}
          desc={`构建标记：${last.run.buildTag}`}
        >
          {last.items.length === 0 ? (
            <EmptyState>这次没有逐题记录。</EmptyState>
          ) : (
            <ul className="mt-2 list-none divide-y divide-black/[0.04] p-0">
              {last.items.map((item) => (
                <li key={item.question} className="flex items-start gap-3 py-2">
                  <span className="min-w-0 flex-1 break-words text-[13px] leading-relaxed text-zinc-900">
                    {item.question}
                  </span>
                  <span className={`${meta} shrink-0`}>命中 {item.hitCount}</span>
                  <span className={`${meta} shrink-0`}>保留 {(item.retained * 100).toFixed(1)}%</span>
                  <Pill tone={item.pass ? "ok" : "error"}>{item.pass ? "通过" : "未通过"}</Pill>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      ) : null}
    </>
  );
}
