"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Pill } from "@/components/knowledge/Pill";
import { btnGhost, fieldLabel, input, meta } from "@/components/knowledge/tokens";

import { patchCardMetaAction } from "../actions";

export interface MetaRowCard {
  id: string;
  title: string;
  status: string;
  departmentName: string;
  source: string;
  version: string;
  owner: string;
  validUntil: string;
}

const STATUS_TONE = {
  pending: "warn",
  confirmed: "ok",
  dropped: "muted",
} as const;

const STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  confirmed: "已确认",
  dropped: "已丢弃",
};

/** 单张卡的四字段补全：来源 / 版本 / 负责人 / 有效期 */
export function MetaRow({ card, canWrite }: { card: MetaRowCard; canWrite: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [source, setSource] = useState(card.source);
  const [version, setVersion] = useState(card.version);
  const [owner, setOwner] = useState(card.owner);
  const [validUntil, setValidUntil] = useState(card.validUntil);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  const dirty =
    source !== card.source ||
    version !== card.version ||
    owner !== card.owner ||
    validUntil !== card.validUntil;

  function save() {
    startTransition(async () => {
      const result = await patchCardMetaAction(card.id, {
        source,
        version,
        owner,
        validUntil: validUntil || null,
      });
      setFailed(!result.ok);
      setMessage(result.message);
      if (result.ok) {
        router.refresh();
      }
    });
  }

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[14px] font-semibold tracking-tight text-zinc-900">{card.title}</span>
        <Pill tone={STATUS_TONE[card.status as keyof typeof STATUS_TONE] ?? "muted"}>
          {STATUS_LABEL[card.status] ?? card.status}
        </Pill>
        <span className={meta}>{card.departmentName}</span>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className={fieldLabel}>来源</span>
          <input
            className={input}
            value={source}
            maxLength={200}
            placeholder="文件 / 链接 / 谁说的"
            disabled={!canWrite}
            onChange={(event) => setSource(event.target.value)}
          />
        </label>
        <label className="block">
          <span className={fieldLabel}>版本</span>
          <input
            className={input}
            value={version}
            maxLength={20}
            placeholder="v1"
            disabled={!canWrite}
            onChange={(event) => setVersion(event.target.value)}
          />
        </label>
        <label className="block">
          <span className={fieldLabel}>负责人</span>
          <input
            className={input}
            value={owner}
            maxLength={40}
            placeholder="谁负责维护"
            disabled={!canWrite}
            onChange={(event) => setOwner(event.target.value)}
          />
        </label>
        <label className="block">
          <span className={fieldLabel}>有效期</span>
          <input
            className={input}
            type="date"
            value={validUntil}
            disabled={!canWrite}
            onChange={(event) => setValidUntil(event.target.value)}
          />
        </label>
      </div>

      <div className="mt-2 flex items-center gap-2">
        {canWrite ? (
          <button type="button" className={btnGhost} disabled={!dirty || pending} onClick={save}>
            {pending ? "保存中…" : "保存"}
          </button>
        ) : null}
        {message ? (
          <span className={`text-[11px] ${failed ? "text-rose-600" : "text-zinc-500"}`}>{message}</span>
        ) : null}
      </div>
    </li>
  );
}
