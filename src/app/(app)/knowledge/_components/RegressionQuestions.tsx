"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { EmptyState } from "@/components/knowledge/EmptyState";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { btnBlue, fieldLabel, input, linkBtn, meta } from "@/components/knowledge/tokens";

import { addRegressionQuestionAction, removeRegressionQuestionAction } from "../actions";

export interface RegressionQuestionItem {
  id: string;
  q: string;
  baselineCount: number;
}

/** 题集维护：手写加题（基线自动取前 3 张命中卡）、删题 */
export function RegressionQuestions({
  questions,
  canWrite,
}: {
  questions: RegressionQuestionItem[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [question, setQuestion] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

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
    <>
      {canWrite ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (question.trim().length >= 2) {
              run(() => addRegressionQuestionAction(question));
            }
          }}
        >
          <label className="min-w-[240px] flex-1">
            <span className={fieldLabel}>加一道题</span>
            <input
              className={input}
              value={question}
              maxLength={200}
              placeholder="例如：食品接触材料迁移量限值是多少"
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          <span className="flex items-end">
            <button type="submit" className={btnBlue} disabled={pending || question.trim().length < 2}>
              {pending ? "提交中…" : "加入题集"}
            </button>
          </span>
        </form>
      ) : null}

      {message ? (
        <InlineMessage tone={failed ? "error" : "info"} className="mt-3 mb-0">
          {message}
        </InlineMessage>
      ) : null}

      {questions.length === 0 ? (
        <div className="mt-3">
          <EmptyState>还没有题。先生成基线题，或手写一道。</EmptyState>
        </div>
      ) : (
        <ul className="mt-2 list-none divide-y divide-black/[0.04] p-0">
          {questions.map((item) => (
            <li key={item.id} className="flex items-start gap-3 py-2">
              <span className="min-w-0 flex-1 break-words text-[13px] leading-relaxed text-zinc-900">
                {item.q}
              </span>
              <span className={`${meta} shrink-0`}>基线 {item.baselineCount} 张</span>
              {canWrite ? (
                <button
                  type="button"
                  className={`${linkBtn} shrink-0`}
                  disabled={pending}
                  onClick={() => run(() => removeRegressionQuestionAction(item.id))}
                >
                  删
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
