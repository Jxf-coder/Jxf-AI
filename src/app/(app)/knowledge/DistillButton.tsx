"use client";

import { useState, useTransition } from "react";

import { distillAction } from "./cards/actions";

export function DistillButton({ documentId, disabled }: { documentId: string; disabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");

  return (
    <span className="inline-form">
      <button
        type="button"
        className="link-action"
        disabled={disabled || pending}
        title={disabled ? "未配置 AI，无法蒸馏卡片" : "调用 AI 生成待确认知识卡"}
        onClick={() =>
          startTransition(async () => {
            const result = await distillAction(documentId);
            setMessage(result.ok ? result.message : result.message);
          })
        }
      >
        {pending ? "生成中…" : "生成卡片"}
      </button>
      {message ? <span className="hint">{message}</span> : null}
    </span>
  );
}
