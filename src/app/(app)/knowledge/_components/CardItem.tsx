"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Pill } from "@/components/knowledge/Pill";
import {
  actions,
  bodyText,
  btnDark,
  btnGhost,
  evidenceItem,
  evidenceList,
  fieldLabel,
  input,
  inputInline,
  linkBtn,
  meta,
  quote,
} from "@/components/knowledge/tokens";
import type { CardView } from "@/lib/knowledge/cards";
import { folderLabel, STANDARD_FOLDERS } from "@/lib/knowledge/folders";

import {
  changeCardFolderAction,
  confirmCardAction,
  dropCardAction,
  updateCardAction,
} from "../cards/actions";
import { CARD_KIND_LABEL, CARD_ORIGIN_LABEL, CARD_STATUS_LABEL, today } from "./card-labels";

const STATUS_TONE = {
  pending: "warn",
  confirmed: "ok",
  dropped: "muted",
} as const;

interface CardItemProps {
  card: CardView;
  selected: boolean;
  onToggle: (id: string) => void;
  canWrite: boolean;
  canConfirm: boolean;
}

export function CardItem({ card, selected, onToggle, canWrite, canConfirm }: CardItemProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(card.title);
  const [draftBody, setDraftBody] = useState(card.body);
  const [draftSource, setDraftSource] = useState(
    typeof card.extra.source === "string" ? card.extra.source : "",
  );

  const expired = card.status === "confirmed" && card.validUntil !== null && card.validUntil < today();
  const unverified =
    card.status === "pending" &&
    !card.humanEdited &&
    !card.hasVerifiedEvidence &&
    (card.ingestRunId !== null || card.origin === "distill" || card.origin === "scout");
  const verifiedCount = card.evidence.filter((item) => item.verified).length;

  const source = typeof card.extra.source === "string" ? card.extra.source : "";
  const version = typeof card.extra.version === "string" ? card.extra.version : "";
  const owner = typeof card.extra.owner === "string" ? card.extra.owner : "";
  const metaLine = [
    source ? `来源 ${source}` : "",
    version ? `版本 ${version}` : "",
    owner ? `负责人 ${owner}` : "",
    card.validUntil ? `有效至 ${card.validUntil}` : "",
    card.routePending && card.routeReason ? `路由：${card.routeReason}` : "",
    `来自 ${CARD_ORIGIN_LABEL[card.origin] ?? card.origin}`,
  ]
    .filter(Boolean)
    .join(" · ");

  function run(action: () => Promise<{ ok: boolean; message: string }>) {
    startTransition(async () => {
      const result = await action();
      setMessage(result.message);
      if (result.ok) {
        setEditing(false);
        router.refresh();
      }
    });
  }

  return (
    <li className="flex items-start gap-3 py-3">
      <input
        type="checkbox"
        className="mt-1"
        checked={selected}
        onChange={() => onToggle(card.id)}
        aria-label={`选择知识卡：${card.title}`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone="blue">{CARD_KIND_LABEL[card.kind] ?? card.kind}</Pill>
          <Pill tone={STATUS_TONE[card.status]}>{CARD_STATUS_LABEL[card.status] ?? card.status}</Pill>
          <Pill>{folderLabel(card.folderKey)}</Pill>
          {card.routePending ? (
            <span title={card.routeReason ?? "目录规则冲突，需人工选定"}>
              <Pill tone="error">目录待定</Pill>
            </span>
          ) : null}
          {!card.routePending && card.suggestedFolder && card.suggestedFolder !== card.folderKey ? (
            <Pill>建议 {folderLabel(card.suggestedFolder)}</Pill>
          ) : null}
          {card.category ? <Pill>{card.category}</Pill> : null}
          {card.product ? <Pill>{card.product}</Pill> : null}
          {card.externalOk ? <Pill tone="blue">可对外</Pill> : null}
          {expired ? <Pill tone="error">已过期 {card.validUntil}</Pill> : null}
          {unverified ? (
            <Pill tone="error">
              <span title="AI 生成，原文里没找到逐字证据；改过正文或来源后才能确认">证据没对上</span>
            </Pill>
          ) : null}
          {card.conflictWith.length > 0 ? (
            <Pill tone="error">与 {card.conflictWith.length} 张说法冲突</Pill>
          ) : null}
          {card.humanEdited ? <Pill>人改过</Pill> : null}
        </div>

        {editing ? (
          <div className="mt-2 flex flex-col gap-2">
            <label className="block">
              <span className={fieldLabel}>标题</span>
              <input
                className={input}
                value={draftTitle}
                maxLength={120}
                onChange={(event) => setDraftTitle(event.target.value)}
              />
            </label>
            <label className="block">
              <span className={fieldLabel}>正文</span>
              <textarea
                className={`${input} resize-y`}
                rows={4}
                value={draftBody}
                maxLength={4000}
                onChange={(event) => setDraftBody(event.target.value)}
              />
            </label>
            <label className="block">
              <span className={fieldLabel}>来源</span>
              <input
                className={input}
                value={draftSource}
                maxLength={200}
                placeholder="文件 / 链接 / 谁说的"
                onChange={(event) => setDraftSource(event.target.value)}
              />
            </label>
            <div className={actions}>
              <button
                type="button"
                className={btnDark}
                disabled={pending || draftTitle.trim().length === 0 || draftBody.trim().length === 0}
                onClick={() =>
                  run(() => updateCardAction(card.id, draftTitle, draftBody, draftSource))
                }
              >
                保存
              </button>
              <button type="button" className={btnGhost} onClick={() => setEditing(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <>
            <h3 className="mt-1 text-[15px] font-semibold tracking-tight text-zinc-900">{card.title}</h3>
            {card.body ? <p className={`${bodyText} mt-1`}>{card.body}</p> : null}
          </>
        )}

        <p className={`${meta} mt-1`}>{metaLine}</p>

        {card.evidence.length > 0 ? (
          <details className="mt-2 rounded-xl border border-hairline bg-apple-canvas/60 px-3 py-2">
            <summary className="cursor-pointer text-[11px] font-medium text-zinc-500">
              证据 {verifiedCount}/{card.evidence.length} 对上原文
            </summary>
            <ul className={evidenceList}>
              {card.evidence.map((item) => (
                <li key={item.id} className={evidenceItem}>
                  <span className={quote}>
                    <span className={item.verified ? "text-emerald-600" : "text-rose-600"}>
                      {item.verified ? "✓" : "✗"}
                    </span>{" "}
                    “{item.quote}”
                  </span>
                  <span className={meta}>
                    {item.documentTitle ?? "文档"} · {item.locator ?? "未标注位置"}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <p className={`${meta} mt-2`}>
            {card.status === "pending"
              ? "暂无证据。需要人工修订或补充证据后才能确认。"
              : "暂无关联证据。"}
          </p>
        )}

        {card.conflictWith.length > 0 ? (
          <p className="mt-1 text-[11px] text-rose-600">
            冲突：留一张、丢一张，或改正文说清适用条件。
          </p>
        ) : null}

        {message ? <p className={`${meta} mt-1`}>{message}</p> : null}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {canWrite ? (
          <select
            className={`${inputInline} w-auto`}
            value={card.folderKey}
            aria-label="调整知识卡目录"
            disabled={pending}
            onChange={(event) => run(() => changeCardFolderAction(card.id, event.target.value))}
          >
            {STANDARD_FOLDERS.filter((folder) => folder.key !== "99-trash").map((folder) => (
              <option key={folder.key} value={folder.key}>
                {folder.label}
              </option>
            ))}
          </select>
        ) : null}
        {!editing && canWrite ? (
          <button type="button" className={linkBtn} onClick={() => setEditing(true)}>
            改
          </button>
        ) : null}
        {card.status === "pending" && canConfirm ? (
          <button
            type="button"
            className={linkBtn}
            disabled={pending || unverified || card.routePending}
            title={
              card.routePending
                ? "目录待定，先在上方选择目录"
                : unverified
                  ? "证据没对上，先改正文或来源"
                  : "确认这张知识卡"
            }
            onClick={() => run(() => confirmCardAction(card.id))}
          >
            确认
          </button>
        ) : null}
        {canWrite && card.status !== "dropped" ? (
          <button
            type="button"
            className={linkBtn}
            disabled={pending}
            onClick={() => run(() => dropCardAction(card.id))}
          >
            丢弃
          </button>
        ) : null}
      </div>
    </li>
  );
}
