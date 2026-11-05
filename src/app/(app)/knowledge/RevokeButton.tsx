"use client";

import { useState, useTransition } from "react";

import { inline, linkBtn, meta } from "./ui";
import { revokeRunAction } from "./actions";

export function RevokeButton({ runId }: { runId: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");

  return (
    <span className={inline}>
      <button
        type="button"
        className={linkBtn}
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
      {message ? <span className={meta}>{message}</span> : null}
    </span>
  );
}
