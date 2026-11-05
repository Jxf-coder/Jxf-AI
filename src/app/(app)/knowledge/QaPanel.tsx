"use client";

import { useState, useTransition } from "react";

import { askAction, type AskResult } from "./actions";

export function QaPanel({ aiEnabled }: { aiEnabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);

  const answer = result?.answer;

  return (
    <div className="card">
      <div className="card-title">知识问答</div>
      <p className="hint">
        {aiEnabled
          ? "只依据已确认的知识卡作答，引用编号与数字会逐条校验。"
          : "未启用 AI 生成：这里只返回检索到的已确认知识卡。"}
      </p>

      <label>
        问题
        <textarea
          rows={2}
          value={question}
          maxLength={500}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="例如：食品接触材料的迁移量限值是多少？"
        />
      </label>

      <div className="perm-savebar">
        <button
          type="button"
          className="button"
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

      {result && !result.ok ? <div className="alert-error">{result.message}</div> : null}

      {answer ? (
        <div className="qa-answer">
          <div className="badge-row">
            <span className={`badge ${answer.mode === "no_match" ? "badge-error" : "badge-ok"}`}>
              {answer.mode === "ai" ? "AI 生成" : answer.mode === "retrieval_only" ? "仅检索" : "未命中"}
            </span>
            {answer.gapRecorded ? <span className="badge badge-accent">已记录知识缺口</span> : null}
            {answer.invalidCites.length > 0 ? (
              <span className="badge badge-error">
                越界引用 {answer.invalidCites.map((index) => `[${index}]`).join(" ")}
              </span>
            ) : null}
            {answer.unverifiedNumbers.length > 0 ? (
              <span className="badge badge-error">
                未核实数字 {answer.unverifiedNumbers.join("、")}
              </span>
            ) : null}
          </div>

          <p className="qa-answer-text">{answer.answer}</p>

          {answer.citations.length > 0 ? (
            <>
              <div className="meta-label">引用来源</div>
              <ul className="evidence-list">
                {answer.citations.map((citation) => (
                  <li key={citation.cardId}>
                    <span className="evidence-quote">
                      [{citation.index}] {citation.title}
                    </span>
                    {citation.quotes.length > 0 ? (
                      <span className="hint">证据：{citation.quotes.join(" / ")}</span>
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
