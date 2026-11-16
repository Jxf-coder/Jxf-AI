"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Field } from "@/components/knowledge/Field";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { actions, btnDark, input } from "@/components/knowledge/tokens";

import { createRetroAction } from "../actions";

/** 与 capture.MIN_SOURCE_CHARS 保持一致；此处独立声明避免把服务端依赖带进客户端 */
const MIN_RETRO_CHARS = 200;

/** 写一条人工复盘：进入经验队列，由 worker 异步提炼成待确认卡 */
export function RetroPanel() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  function submit() {
    startTransition(async () => {
      const result = await createRetroAction(title, body);
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
      <summary className="cursor-pointer text-[13px] font-medium text-zinc-800">写一条复盘</summary>

      <Field label="标题" className="mt-3 block">
        <input
          className={input}
          value={title}
          maxLength={120}
          placeholder="例如：第 40 周交付失败复盘"
          onChange={(event) => setTitle(event.target.value)}
        />
      </Field>

      <Field label="正文" className="mt-3 block">
        <textarea
          className={`${input} resize-y`}
          rows={6}
          value={body}
          maxLength={12000}
          placeholder="写清现象、根因、改进动作与验证方式；周报/月报会归到 08，其余复盘归到 05"
          onChange={(event) => setBody(event.target.value)}
        />
      </Field>

      <div className={actions}>
        <button
          type="button"
          className={btnDark}
          disabled={pending || title.trim().length === 0 || body.trim().length < MIN_RETRO_CHARS}
          onClick={submit}
        >
          {pending ? "提交中…" : "提交复盘"}
        </button>
      </div>

      <p className="mt-2 text-[12px] text-zinc-500">
        正文至少 {MIN_RETRO_CHARS} 字；提交后进入经验队列，AI 提炼成待确认卡，确认后才进入检索。
      </p>

      {message ? (
        <InlineMessage tone={failed ? "error" : "info"} className="mt-3 mb-0">
          {message}
        </InlineMessage>
      ) : null}
    </details>
  );
}
