import { EmptyState } from "@/components/knowledge/EmptyState";
import { Pill } from "@/components/knowledge/Pill";
import { SectionCard } from "@/components/knowledge/SectionCard";
import { badgeRow, meta } from "@/components/knowledge/tokens";
import type { UserContext } from "@/lib/db/user-context";
import { listQaLogs } from "@/lib/knowledge/qa";

import { QaPanel } from "../QaPanel";

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

interface QaTabProps {
  context: UserContext;
  aiEnabled: boolean;
}

/** 问答来源：面板 + 审计回放 */
export async function QaTab({ context, aiEnabled }: QaTabProps) {
  const logs = await listQaLogs(context, 50);

  return (
    <>
      <QaPanel aiEnabled={aiEnabled} />

      <SectionCard
        title="问答来源"
        count={logs.length}
        desc="每条问答都可回放：引用了哪几张卡、有没有越界编号、答案里的数字能不能在原文里找到。"
      >
        {logs.length === 0 ? (
          <EmptyState>还没有问答记录。</EmptyState>
        ) : (
          <ul className="mt-2 list-none divide-y divide-black/[0.04] p-0">
            {logs.map((log) => (
              <li key={log.id} className="py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="break-words text-[13px] font-medium text-zinc-900">{log.question}</span>
                  <span className={meta}>{DATE_FORMATTER.format(log.createdAt)}</span>
                </div>

                <div className={`${badgeRow} mt-1.5`}>
                  <Pill tone={log.citedCards.length > 0 ? "ok" : "muted"}>
                    引用 {log.citedCards.length} 张
                  </Pill>
                  {log.invalidCites.length > 0 ? (
                    <Pill tone="error">越界引用 {log.invalidCites.map((index) => `[${index}]`).join(" ")}</Pill>
                  ) : null}
                  {log.unverifiedNumbers.length > 0 ? (
                    <Pill tone="error">未核实数字 {log.unverifiedNumbers.join("、")}</Pill>
                  ) : null}
                  {log.gapId ? <Pill tone="warn">已记入缺口</Pill> : null}
                </div>

                <details className="mt-2 rounded-xl bg-apple-canvas px-3 py-2">
                  <summary className="cursor-pointer text-[11px] text-zinc-500">看答案与引用</summary>
                  <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-zinc-700">
                    {log.answer}
                  </p>
                  {log.citedCards.length > 0 ? (
                    <ul className={`${meta} mt-1.5 list-none space-y-0.5 p-0`}>
                      {log.citedCards.map((card) => (
                        <li key={card.id}>· {card.title}</li>
                      ))}
                    </ul>
                  ) : null}
                </details>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </>
  );
}
