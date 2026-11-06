"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { EmptyState } from "@/components/knowledge/EmptyState";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { Pill } from "@/components/knowledge/Pill";
import { SectionCard } from "@/components/knowledge/SectionCard";
import { btnBlue, btnGhost, input, linkBtn, meta } from "@/components/knowledge/tokens";

import { addGapAction, closeGapAction, reopenGapAction } from "../actions";

export interface GapItem {
  id: string;
  question: string;
  status: string;
  source: string | null;
  repeatCount: number;
  createdAt: string;
}

const FILTERS = [
  { key: "open", label: "待补" },
  { key: "closed", label: "已补" },
  { key: "all", label: "全部" },
] as const;

const SOURCE_LABEL: Record<string, string> = {
  manual: "手动记的",
  qa_miss: "问答未命中",
  expired: "知识过期",
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

interface GapsClientProps {
  gaps: GapItem[];
  status: string;
  canWrite: boolean;
}

export function GapsClient({ gaps, status, canWrite }: GapsClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [question, setQuestion] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  function apply(next: string) {
    router.push(`/knowledge?tab=gaps&gapStatus=${next}`);
  }

  function run(action: () => Promise<{ ok: boolean; message: string }>) {
    startTransition(async () => {
      const result = await action();
      setFailed(!result.ok);
      setMessage(result.message);
      if (result.ok) {
        setQuestion("");
        router.refresh();
      }
    });
  }

  return (
    <SectionCard
      title="知识缺口"
      count={gaps.length}
      desc="问答未命中会自动沉淀，也可以手动记一条；补完文档或卡片后标记「已补」，需要时再重开。"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((filter) => {
          const active = status === filter.key;
          return (
            <button
              key={filter.key}
              type="button"
              onClick={() => apply(filter.key)}
              aria-pressed={active}
              className={`rounded-full px-3 py-1 text-[12px] transition-colors ${
                active
                  ? "bg-apple-blue-soft font-semibold text-apple-blue"
                  : "bg-apple-canvas text-zinc-500 hover:text-zinc-900"
              }`}
            >
              {filter.label}
            </button>
          );
        })}
      </div>

      {canWrite ? (
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (question.trim().length >= 2) {
              run(() => addGapAction(question));
            }
          }}
        >
          <input
            className={`${input} min-w-[240px] flex-1`}
            value={question}
            maxLength={300}
            placeholder="手动记一条缺口，例如：客户问 2027 年新规怎么执行"
            onChange={(event) => setQuestion(event.target.value)}
          />
          <button type="submit" className={btnBlue} disabled={pending || question.trim().length < 2}>
            {pending ? "提交中…" : "记一条"}
          </button>
        </form>
      ) : null}

      {message ? (
        <InlineMessage tone={failed ? "error" : "info"} className="mt-3 mb-0">
          {message}
        </InlineMessage>
      ) : null}

      {gaps.length === 0 ? (
        <div className="mt-3">
          <EmptyState>{status === "closed" ? "还没有已补的缺口。" : "没有缺口。"}</EmptyState>
        </div>
      ) : (
        <ul className="mt-2 list-none divide-y divide-black/[0.04] p-0">
          {gaps.map((gap) => (
            <li key={gap.id} className="flex items-start gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="break-words text-[13px] leading-relaxed text-zinc-900">{gap.question}</p>
                <p className={`${meta} mt-0.5`}>
                  {SOURCE_LABEL[gap.source ?? "manual"] ?? gap.source ?? "手动记的"} ·{" "}
                  {formatDate(gap.createdAt)}
                  {gap.repeatCount > 0 ? ` · 被追问 ${gap.repeatCount} 次` : ""}
                </p>
              </div>
              <Pill tone={gap.status === "open" ? "warn" : "ok"}>
                {gap.status === "open" ? "待补" : "已补"}
              </Pill>
              {canWrite ? (
                gap.status === "open" ? (
                  <button
                    type="button"
                    className={linkBtn}
                    disabled={pending}
                    onClick={() => run(() => closeGapAction(gap.id))}
                  >
                    已补
                  </button>
                ) : (
                  <button
                    type="button"
                    className={linkBtn}
                    disabled={pending}
                    onClick={() => run(() => reopenGapAction(gap.id))}
                  >
                    重开
                  </button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
