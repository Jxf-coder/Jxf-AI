"use client";

import { useState, useTransition } from "react";

import { Field } from "@/components/knowledge/Field";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { Pill } from "@/components/knowledge/Pill";
import { SectionCard } from "@/components/knowledge/SectionCard";
import {
  actions,
  badgeRow,
  bodyText,
  btnBlue,
  evidenceItem,
  evidenceList,
  fieldLabel,
  input,
  meta,
  quote,
} from "@/components/knowledge/tokens";
import { askAction, type AskResult } from "./actions";

export function QaPanel({ aiEnabled }: { aiEnabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);

  const answer = result?.answer;

  return (
    <SectionCard
      title="知识问答"
      right={<Pill tone={aiEnabled ? "ok" : "muted"}>{aiEnabled ? "AI 生成" : "仅检索"}</Pill>}
      desc={
        aiEnabled
          ? "只依据已确认的知识卡作答，引用编号与数字会逐条校验。"
          : "未启用 AI 生成：这里只返回检索到的已确认知识卡。"
      }
    >
      <Field label="问题">
        <textarea
          className={`${input} resize-y`}
          rows={2}
          value={question}
          maxLength={500}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="例如：食品接触材料的迁移量限值是多少？"
        />
      </Field>

      <div className={actions}>
        <button
          type="button"
          className={btnBlue}
          disabled={pending || question.trim().length < 2}
          onClick={() =>
            startTransition(async () => {
              setResult(await askAction(question));
            })
          }
        >
          {pending ? "检索中…" : "提问"}
        </button>
      </div>

      {result && !result.ok ? (
        <InlineMessage tone="error" className="mt-4 mb-0">
          {result.message}
        </InlineMessage>
      ) : null}

      {answer ? (
        <div className="mt-5">
          <div className={badgeRow}>
            <Pill tone={answer.mode === "no_match" ? "error" : "ok"}>
              {answer.mode === "ai" ? "AI 生成" : answer.mode === "retrieval_only" ? "仅检索" : "未命中"}
            </Pill>
            {answer.gapRecorded ? <Pill tone="warn">已记录知识缺口</Pill> : null}
            {answer.invalidCites.length > 0 ? (
              <Pill tone="error">
                越界引用 {answer.invalidCites.map((index) => `[${index}]`).join(" ")}
              </Pill>
            ) : null}
            {answer.unverifiedNumbers.length > 0 ? (
              <Pill tone="error">未核实数字 {answer.unverifiedNumbers.join("、")}</Pill>
            ) : null}
          </div>

          <p className={`${bodyText} mb-4 rounded-2xl bg-apple-canvas px-4 py-3.5`}>{answer.answer}</p>

          {answer.citations.length > 0 ? (
            <>
              <div className={fieldLabel}>引用来源</div>
              <ul className={evidenceList}>
                {answer.citations.map((citation) => (
                  <li key={citation.cardId} className={evidenceItem}>
                    <span className={quote}>
                      [{citation.index}] {citation.title}
                    </span>
                    {citation.quotes.length > 0 ? (
                      <span className={meta}>证据：{citation.quotes.join(" / ")}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </SectionCard>
  );
}
