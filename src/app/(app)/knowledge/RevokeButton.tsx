"use client";

import { useState, useTransition } from "react";

import { revokeRunAction } from "./actions";

export function RevokeButton({ runId }: { runId: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");

  return (
    <>
      <button
        type="button"
        className="button-ghost"
        disabled={pending}
        onClick={() => {
          const formData = new FormData();
          formData.set("runId", runId);
          startTransition(async () => {
            const result = await revokeRunAction(formData);
            setMessage(result.ok ? "" : result.message);
          });
        }}
      >
        {pending ? "撤回中…" : "撤回批次"}
      </button>
      {message ? <span className="hint">{message}</span> : null}
    </>
  );
}
