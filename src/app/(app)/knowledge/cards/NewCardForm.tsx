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
  const [failed, setFailed] = useState(false);

  return (
    <div className="akb-card">
      <div className="akb-card-head">
        <h2 className="akb-card-title">人工新建知识卡</h2>
        <span className="akb-badge">可直接确认</span>
      </div>
      <p className="akb-card-desc">作者本人撰写的内容记为「人工编辑过」，创建后可直接确认。</p>

      <div className="akb-form">
        <label className="akb-field">
          <span className="akb-label">类型</span>
          <select className="akb-select" value={kind} onChange={(event) => setKind(event.target.value)}>
            {Object.entries(KIND_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="akb-field">
          <span className="akb-label">标题</span>
          <input
            className="akb-input"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            placeholder="一句话说明这张卡解决什么问题"
          />
        </label>
      </div>

      <label className="akb-field">
        <span className="akb-label">正文</span>
        <textarea
          className="akb-textarea"
          rows={4}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={4000}
          placeholder="写清结论、适用范围与前提条件"
        />
      </label>

      <div className="akb-actions">
        <button
          type="button"
          className="akb-btn"
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
        <div className={failed ? "akb-alert is-error" : "akb-alert"}>{message}</div>
      ) : null}
    </div>
  );
}
