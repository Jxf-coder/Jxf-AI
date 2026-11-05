"use client";

import { useState, useTransition } from "react";

import { actions, btnBlue, btnDark, btnGhost, fieldLabel, input, linkBtn, meta } from "@/components/knowledge/tokens";
import { confirmCardAction, dropCardAction, updateCardAction } from "./actions";

interface CardActionsProps {
  cardId: string;
  title: string;
  body: string;
  canConfirm: boolean;
  canWrite: boolean;
  status: "pending" | "confirmed" | "dropped";
}

export function CardActions({ cardId, title, body, canConfirm, canWrite, status }: CardActionsProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftBody, setDraftBody] = useState(body);

  function run(action: () => Promise<{ ok: boolean; message: string }>) {
    startTransition(async () => {
      const result = await action();
      setMessage(result.ok ? "" : result.message);
    });
  }

  return (
    <div className={actions}>
      {status === "pending" && canConfirm ? (
        <button type="button" className={btnBlue} disabled={pending} onClick={() => run(() => confirmCardAction(cardId))}>
          确认
        </button>
      ) : null}

      {canWrite && status !== "dropped" ? (
        <button
          type="button"
          className={btnGhost}
          disabled={pending}
          onClick={() => run(() => dropCardAction(cardId))}
        >
          作废
        </button>
      ) : null}

      {canWrite && status === "pending" ? (
        <button type="button" className={linkBtn} onClick={() => setEditing((value) => !value)}>
          {editing ? "收起编辑" : "人工修订"}
        </button>
      ) : null}

      {editing ? (
        <div className="mt-1 flex w-full flex-col gap-3">
          <label className="block">
            <span className={fieldLabel}>标题</span>
            <input
              className={input}
              type="text"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              maxLength={120}
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>正文</span>
            <textarea
              className={`${input} resize-y`}
              rows={4}
              value={draftBody}
              onChange={(event) => setDraftBody(event.target.value)}
              maxLength={4000}
            />
          </label>
          <div className={actions}>
            <button
              type="button"
              className={btnDark}
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const result = await updateCardAction(cardId, draftTitle, draftBody);
                  if (result.ok) {
                    setEditing(false);
                  }
                  return result;
                })
              }
            >
              保存修订
            </button>
          </div>
        </div>
      ) : null}

      {message ? <span className={meta}>{message}</span> : null}
    </div>
  );
}
