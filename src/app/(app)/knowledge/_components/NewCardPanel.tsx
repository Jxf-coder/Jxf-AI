"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Field } from "@/components/knowledge/Field";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { actions, btnDark, formGrid, input } from "@/components/knowledge/tokens";

import { createCardAction } from "../cards/actions";
import { CARD_KIND_LABEL } from "./card-labels";

/** 手写一张知识卡：折叠面板，保存后进入待确认 */
export function NewCardPanel() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState("fact");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("");
  const [product, setProduct] = useState("");
  const [source, setSource] = useState("");
  const [owner, setOwner] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  function submit() {
    startTransition(async () => {
      const result = await createCardAction(kind, title, body, {
        category,
        product,
        source,
        owner,
        validUntil,
      });
      setFailed(!result.ok);
      setMessage(result.message);
      if (result.ok) {
        setTitle("");
        setBody("");
        router.refresh();
      }
    });
  }

  return (
    <details className="mt-3 rounded-2xl border border-dashed border-black/[0.08] px-3.5 py-3">
      <summary className="cursor-pointer text-[13px] font-medium text-zinc-800">手写一张知识卡</summary>

      <div className={`${formGrid} mt-3`}>
        <Field label="类型">
          <select className={input} value={kind} onChange={(event) => setKind(event.target.value)}>
            {Object.entries(CARD_KIND_LABEL).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </Field>
        <Field label="标题">
          <input
            className={input}
            value={title}
            maxLength={120}
            placeholder="一句话结论"
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="分类">
          <input
            className={input}
            value={category}
            maxLength={40}
            placeholder="例如：包材"
            onChange={(event) => setCategory(event.target.value)}
          />
        </Field>
        <Field label="产品（空 = 通用）">
          <input
            className={input}
            value={product}
            maxLength={40}
            onChange={(event) => setProduct(event.target.value)}
          />
        </Field>
        <Field label="来源">
          <input
            className={input}
            value={source}
            maxLength={200}
            placeholder="文件 / 链接 / 谁说的"
            onChange={(event) => setSource(event.target.value)}
          />
        </Field>
        <Field label="负责人">
          <input
            className={input}
            value={owner}
            maxLength={40}
            onChange={(event) => setOwner(event.target.value)}
          />
        </Field>
        <Field label="有效期">
          <input
            className={input}
            type="date"
            value={validUntil}
            onChange={(event) => setValidUntil(event.target.value)}
          />
        </Field>
      </div>

      <Field label="正文" className="mt-3 block">
        <textarea
          className={`${input} resize-y`}
          rows={4}
          value={body}
          maxLength={4000}
          placeholder="事实写依据，决策写为什么这么改，问答写标准答法"
          onChange={(event) => setBody(event.target.value)}
        />
      </Field>

      <div className={actions}>
        <button
          type="button"
          className={btnDark}
          disabled={pending || title.trim().length === 0 || body.trim().length === 0}
          onClick={submit}
        >
          {pending ? "创建中…" : "保存为待确认"}
        </button>
      </div>

      <p className="mt-2 text-[12px] text-zinc-500">
        手写卡按已人工核对处理，可直接确认；要保留可追溯依据，请在保存后为它补一条证据。
      </p>

      {message ? (
        <InlineMessage tone={failed ? "error" : "info"} className="mt-3 mb-0">
          {message}
        </InlineMessage>
      ) : null}
    </details>
  );
}
