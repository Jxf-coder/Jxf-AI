"use client";

import { useState, useTransition } from "react";

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
    <div className="akb-actions">
      {status === "pending" && canConfirm ? (
        <button type="button" className="akb-btn is-blue" disabled={pending} onClick={() => run(() => confirmCardAction(cardId))}>
          确认
        </button>
      ) : null}

      {canWrite && status !== "dropped" ? (
        <button
          type="button"
          className="akb-btn is-ghost"
          disabled={pending}
          onClick={() => run(() => dropCardAction(cardId))}
        >
          作废
        </button>
      ) : null}

      {canWrite && status === "pending" ? (
        <button type="button" className="akb-link" onClick={() => setEditing((value) => !value)}>
          {editing ? "收起编辑" : "人工修订"}
        </button>
      ) : null}

      {editing ? (
        <div className="akb-card-edit">
          <label className="akb-field">
            <span className="akb-label">标题</span>
            <input
              className="akb-input"
              type="text"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              maxLength={120}
            />
          </label>
          <label className="akb-field">
            <span className="akb-label">正文</span>
            <textarea
              className="akb-textarea"
              rows={4}
              value={draftBody}
              onChange={(event) => setDraftBody(event.target.value)}
              maxLength={4000}
            />
          </label>
          <div className="akb-actions">
            <button
              type="button"
              className="akb-btn"
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

      {message ? <span className="akb-evidence-meta">{message}</span> : null}
    </div>
  );
}
