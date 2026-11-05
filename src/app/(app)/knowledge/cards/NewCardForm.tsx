"use client";

import { useState, useTransition } from "react";

import { Field } from "@/components/knowledge/Field";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { SectionCard } from "@/components/knowledge/SectionCard";
import { actions, badge, btnDark, formGrid, input } from "@/components/knowledge/tokens";
import { createCardAction } from "./actions";

const KIND_LABEL: Record<string, string> = {
  fact: "事实",
  object: "对象",
  decision: "决策",
  preference: "偏好",
  faq: "问答",
  case: "案例",
  viewpoint: "观点",
};

export function NewCardForm() {
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState("fact");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  return (
    <SectionCard
      title="人工新建知识卡"
      right={<span className={badge()}>可直接确认</span>}
      desc="作者本人撰写的内容记为「人工编辑过」，创建后可直接确认。"
    >
      <div className={formGrid}>
        <Field label="类型">
          <select className={input} value={kind} onChange={(event) => setKind(event.target.value)}>
            {Object.entries(KIND_LABEL).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </Field>
        <Field label="标题">
          <input
            className={input}
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            placeholder="一句话说明这张卡解决什么问题"
          />
        </Field>
      </div>

      <Field label="正文" className="mt-3.5 block">
        <textarea
          className={`${input} resize-y`}
          rows={4}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={4000}
          placeholder="写清结论、适用范围与前提条件"
        />
      </Field>

      <div className={actions}>
        <button
          type="button"
          className={btnDark}
          disabled={pending || title.trim().length === 0 || body.trim().length === 0}
          onClick={() =>
            startTransition(async () => {
              const result = await createCardAction(kind, title, body);
              setFailed(!result.ok);
              setMessage(result.ok ? "已创建，等待确认" : result.message);
              if (result.ok) {
                setTitle("");
                setBody("");
              }
            })
          }
        >
          {pending ? "创建中…" : "创建知识卡"}
        </button>
      </div>

      {message ? (
        <InlineMessage tone={failed ? "error" : "info"} className="mt-4 mb-0">
          {message}
        </InlineMessage>
      ) : null}
    </SectionCard>
  );
}
