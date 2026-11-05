"use client";

import { useState, useTransition } from "react";

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

  return (
    <div className="card">
      <div className="card-title">人工新建知识卡</div>
      <p className="hint">作者本人撰写的内容记为「人工编辑过」，创建后可直接确认。</p>

      <div className="form-grid">
        <label>
          类型
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            {Object.entries(KIND_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          标题
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            placeholder="一句话说明这张卡解决什么问题"
          />
        </label>
      </div>

      <label>
        正文
        <textarea
          rows={4}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={4000}
          placeholder="写清结论、适用范围与前提条件"
        />
      </label>

      <div className="perm-savebar">
        <button
          type="button"
          className="button"
          disabled={pending || title.trim().length === 0 || body.trim().length === 0}
          onClick={() =>
            startTransition(async () => {
              const result = await createCardAction(kind, title, body);
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

      {message ? <span className="hint">{message}</span> : null}
    </div>
  );
}
