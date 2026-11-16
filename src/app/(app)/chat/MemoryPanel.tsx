"use client";

import { useState, useTransition } from "react";

import type { ThreadMemoryView } from "@/lib/runtime/memory";

import { addMemoryAction, deleteMemoryAction } from "./actions";

interface MemoryPanelProps {
  threadId: string;
  initialMemories: ThreadMemoryView[];
}

/** 会话记忆：仅本人可见，手动置顶后随本会话运行注入 */
export function MemoryPanel({ threadId, initialMemories }: MemoryPanelProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ThreadMemoryView[]>(initialMemories);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  function add() {
    const content = draft.trim();
    if (content.length === 0) {
      return;
    }
    startTransition(async () => {
      const result = await addMemoryAction(threadId, content);
      setFailed(!result.ok);
      setMessage(result.message);
      if (result.ok) {
        setItems((current) => [
          ...current,
          {
            id: result.memoryId ?? `local-${Date.now()}`,
            content,
            createdAt: new Date().toISOString(),
          },
        ]);
        setDraft("");
      }
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      const result = await deleteMemoryAction(id);
      setFailed(!result.ok);
      setMessage(result.message);
      if (result.ok) {
        setItems((current) => current.filter((item) => item.id !== id));
      }
    });
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="rounded-lg px-2 py-1 text-[12px] text-zinc-500 transition-colors hover:bg-black/[0.04] hover:text-zinc-800"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        记忆{items.length > 0 ? ` (${items.length})` : ""}
      </button>

      {open ? (
        <div className="absolute right-0 top-8 z-20 w-80 rounded-2xl border border-hairline bg-white p-3 shadow-card">
          <p className="text-[12px] font-semibold text-zinc-900">会话记忆</p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            只在本会话生效、仅自己可见；不进入知识卡片库。
          </p>

          {items.length === 0 ? (
            <p className="mt-3 rounded-xl bg-apple-canvas px-3 py-3 text-[11px] text-zinc-500">
              还没有置顶记忆。可以把称呼、口径、禁用词等写在这里。
            </p>
          ) : (
            <ul className="mt-2 max-h-48 list-none space-y-1 overflow-y-auto p-0">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-start gap-2 rounded-xl bg-apple-canvas px-2.5 py-2"
                >
                  <span className="min-w-0 flex-1 break-words text-[12px] leading-relaxed text-zinc-700">
                    {item.content}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-[11px] text-zinc-400 transition-colors hover:text-rose-600"
                    disabled={pending}
                    onClick={() => remove(item.id)}
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3">
            <textarea
              className="w-full resize-y rounded-xl border-0 bg-apple-canvas px-3 py-2 text-[12px] text-zinc-900 outline-none placeholder:text-zinc-400 focus:bg-white focus:ring-2 focus:ring-apple-blue/20"
              rows={3}
              maxLength={500}
              value={draft}
              placeholder="例如：我所在部门是品控一组；回答不要用「亲」"
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[10px] text-zinc-400">{draft.trim().length}/500</span>
              <button
                type="button"
                className="rounded-xl bg-apple-blue px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-apple-blue-hover disabled:opacity-40"
                disabled={pending || draft.trim().length === 0}
                onClick={add}
              >
                {pending ? "保存中…" : "置顶"}
              </button>
            </div>
          </div>

          {message ? (
            <p className={`mt-2 text-[11px] ${failed ? "text-rose-600" : "text-zinc-500"}`}>
              {message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
