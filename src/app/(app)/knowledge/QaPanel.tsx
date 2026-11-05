"use client";

import { useState, useTransition } from "react";

import {
  actions,
  alert,
  badge,
  badgeRow,
  bodyText,
  btnBlue,
  card,
  cardDesc,
  cardHead,
  cardTitle,
  evidenceItem,
  evidenceList,
  input,
  label,
  meta,
  quote,
} from "./ui";
import { askAction, type AskResult } from "./actions";

export function QaPanel({ aiEnabled }: { aiEnabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);

  const answer = result?.answer;

  return (
    <div className={card}>
      <div className={cardHead}>
        <h2 className={cardTitle}>知识问答</h2>
        <span className={aiEnabled ? badge("ok") : badge()}>
          {aiEnabled ? "AI 生成" : "仅检索"}
        </span>
      </div>
      <p className={cardDesc}>
        {aiEnabled
          ? "只依据已确认的知识卡作答，引用编号与数字会逐条校验。"
          : "未启用 AI 生成：这里只返回检索到的已确认知识卡。"}
      </p>

      <label className="block">
        <span className={label}>问题</span>
        <textarea
          className={`${input} resize-y`}
          rows={2}
          value={question}
          maxLength={500}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="例如：食品接触材料的迁移量限值是多少？"
        />
      </label>

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

      {result && !result.ok ? <div className={`${alert("error")} mt-4 mb-0`}>{result.message}</div> : null}

      {answer ? (
        <div className="mt-5">
          <div className={badgeRow}>
            <span className={answer.mode === "no_match" ? badge("error") : badge("ok")}>
              {answer.mode === "ai" ? "AI 生成" : answer.mode === "retrieval_only" ? "仅检索" : "未命中"}
            </span>
            {answer.gapRecorded ? <span className={badge("warn")}>已记录知识缺口</span> : null}
            {answer.invalidCites.length > 0 ? (
              <span className={badge("error")}>
                越界引用 {answer.invalidCites.map((index) => `[${index}]`).join(" ")}
              </span>
            ) : null}
            {answer.unverifiedNumbers.length > 0 ? (
              <span className={badge("error")}>
                未核实数字 {answer.unverifiedNumbers.join("、")}
              </span>
            ) : null}
          </div>

          <p className={`${bodyText} mb-4 rounded-2xl bg-apple-canvas px-4 py-3.5`}>{answer.answer}</p>

          {answer.citations.length > 0 ? (
            <>
              <div className={label}>引用来源</div>
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
    </div>
  );
}
