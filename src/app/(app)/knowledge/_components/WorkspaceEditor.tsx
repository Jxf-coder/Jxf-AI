"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { btnBlue, btnGhost, fieldLabel, input, linkBtn } from "@/components/knowledge/tokens";
import type { EvidenceChunkOption, EvidenceDocumentOption } from "@/lib/knowledge/card-evidence";
import type { CardConflictInfo } from "@/lib/knowledge/cards";
import type { CardDetail, DocumentContent } from "@/lib/knowledge/workspace";

import { DistillButton } from "../DistillButton";
import {
  purgeCardAction,
  purgeDocumentAction,
  restoreCardAction,
  restoreDocumentAction,
  setCardVisibilityAction,
  setDocumentVisibilityAction,
  trashDocumentAction,
} from "../actions";
import {
  addEvidenceAction,
  createCardAction,
  loadEvidenceChunksAction,
  loadEvidenceDocumentsAction,
  removeEvidenceAction,
  updateCardAction,
} from "../cards/actions";

type WorkspaceEditorProps =
  | { mode: "document"; document: DocumentContent; canWrite: boolean; aiEnabled: boolean }
  | { mode: "card"; card: CardDetail; canWrite: boolean };

const DOC_STATUS_LABEL: Record<string, string> = {
  parsed: "已解析",
  needs_ocr: "待 OCR",
  failed: "解析失败",
  revoked: "已撤回",
};

const CARD_STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  confirmed: "已确认",
  dropped: "已丢弃",
};

/** 右侧工作区：文档 / 卡片编辑器，保存一律复用既有服务，不新增写入链路 */
export function WorkspaceEditor(props: WorkspaceEditorProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const isDocument = props.mode === "document";
  const initialTitle = isDocument ? props.document.title : props.card.title;
  const initialBody = isDocument ? props.document.text : props.card.body;
  const initialSource = isDocument ? "" : props.card.source;

  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [source, setSource] = useState(initialSource);
  const [shared, setShared] = useState(
    props.mode === "document"
      ? props.document.visibility === "shared"
      : props.card.visibility === "shared",
  );
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);
  /** 乐观锁基线：文档模式取来源卡的 rev，没有卡时为 0（预期新建） */
  const [baseRev, setBaseRev] = useState(
    isDocument ? (props.document.sourceCard?.rev ?? 0) : props.card.rev,
  );
  const [conflict, setConflict] = useState<CardConflictInfo | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  /** 证据面板：文档 → 切片 → 引文，服务端逐字核对后落库 */
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceDocs, setEvidenceDocs] = useState<EvidenceDocumentOption[]>([]);
  const [evidenceChunks, setEvidenceChunks] = useState<EvidenceChunkOption[]>([]);
  const [evidenceDocId, setEvidenceDocId] = useState("");
  const [evidenceChunkId, setEvidenceChunkId] = useState("");
  const [evidenceQuote, setEvidenceQuote] = useState("");
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [evidenceFailed, setEvidenceFailed] = useState(false);
  const [evidenceMessage, setEvidenceMessage] = useState("");

  const trashed = isDocument && props.document.deletedAt !== null;
  const cardTrashed = !isDocument && props.card.status === "dropped";
  /** 在 99-回收站：只允许恢复或彻底删除 */
  const recycled = trashed || cardTrashed;

  const readOnlyReason = (() => {
    if (!props.canWrite) {
      return "当前账号没有「知识库写入」权限，只能查看";
    }
    if (isDocument) {
      if (trashed) {
        return "这份文档在 99-回收站，恢复后才能继续编辑";
      }
      if (props.document.status === "needs_ocr") {
        return "扫描件没有可解析正文，先补 OCR 再来编辑";
      }
      if (props.document.status === "failed") {
        return "这份文档解析失败，没有正文可编辑";
      }
      if (props.document.text.trim().length === 0) {
        return "这份文档还没有切片正文";
      }
    } else if (cardTrashed) {
      return "这张知识卡已作废，在 99-回收站，恢复后才能编辑";
    }
    return null;
  })();

  const metaLine = isDocument
    ? [
        props.document.departmentName,
        trashed ? "99-回收站" : "",
        props.document.roleKey ? `角色·${props.document.roleKey}` : "",
        props.document.folderLabel,
        DOC_STATUS_LABEL[props.document.status] ?? props.document.status,
        props.document.pageCount ? `${props.document.pageCount} 页` : "",
        `${props.document.charCount} 字`,
        `${props.document.chunkCount} 个切片`,
      ]
        .filter(Boolean)
        .join(" · ")
    : [
        props.card.departmentName,
        cardTrashed ? "99-回收站" : "",
        props.card.roleKey ? `角色·${props.card.roleKey}` : "",
        props.card.folderLabel,
        CARD_STATUS_LABEL[props.card.status] ?? props.card.status,
        `v${props.card.rev}`,
        props.card.updatedByName ? `最后由 ${props.card.updatedByName}` : "",
        props.card.category ? `分类 ${props.card.category}` : "",
        props.card.product ? `产品 ${props.card.product}` : "",
        `证据 ${props.card.evidenceCount} 条`,
      ]
        .filter(Boolean)
        .join(" · ");

  const evidenceTotal = isDocument ? 0 : props.card.evidence.length;
  const evidenceVerified = isDocument
    ? 0
    : props.card.evidence.filter((item) => item.verified).length;

  const blocked = readOnlyReason !== null;
  /** 冲突未处理前禁止再次保存：必须显式选择「载入最新」或「确认覆盖」 */
  const saveDisabled =
    blocked || pending || conflict !== null || title.trim().length === 0 || body.trim().length === 0;

  /** overrideRev：确认覆盖时用冲突版本作为新基线，只放行这一次 */
  function save(overrideRev?: number) {
    const expectedRev = overrideRev ?? baseRev;
    startTransition(async () => {
      const result =
        props.mode === "document"
          ? await createCardAction(
              "fact",
              title.trim(),
              body.trim(),
              { source: source.trim() || `文档：${props.document.title}` },
              props.document.id,
              expectedRev,
            )
          : await updateCardAction(
              props.card.id,
              title.trim(),
              body.trim(),
              source.trim(),
              expectedRev,
            );

      if (result.conflict) {
        setConflict(result.conflict);
        setConfirmOverwrite(false);
        setFailed(false);
        setMessage("");
        return;
      }

      setConflict(null);
      setConfirmOverwrite(false);
      setFailed(!result.ok);
      setMessage(result.message);
      if (result.ok) {
        setBaseRev(typeof result.rev === "number" ? result.rev : expectedRev + 1);
        router.refresh();
      }
    });
  }

  /** 载入库中最新版本，丢弃本地未保存修改 */
  function loadLatest() {
    if (!conflict) {
      return;
    }
    setTitle(conflict.title);
    setBody(conflict.body);
    if (!isDocument) {
      setSource(conflict.source);
    }
    setBaseRev(conflict.rev);
    setConflict(null);
    setConfirmOverwrite(false);
    setFailed(false);
    setMessage(`已载入最新版本 v${conflict.rev}，本地未保存的修改已丢弃`);
  }

  function formatTime(value: string): string {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  /** 切换文档时加载其切片，并默认把首条切片正文填进引文 */
  async function chooseEvidenceDocument(documentId: string) {
    setEvidenceDocId(documentId);
    setEvidenceChunkId("");
    setEvidenceQuote("");
    setEvidenceChunks([]);
    setEvidenceBusy(true);
    const result = await loadEvidenceChunksAction(documentId);
    setEvidenceBusy(false);
    if (!result.ok) {
      setEvidenceFailed(true);
      setEvidenceMessage(result.message ?? "切片加载失败");
      return;
    }
    const chunks = result.chunks ?? [];
    setEvidenceFailed(false);
    setEvidenceMessage("");
    setEvidenceChunks(chunks);
    if (chunks[0]) {
      setEvidenceChunkId(chunks[0].id);
      // 服务端限 600 字；切片可能更长，默认取前缀，用户可再裁剪
      setEvidenceQuote(chunks[0].text.slice(0, 600));
    }
  }

  async function toggleEvidencePanel() {
    if (evidenceOpen) {
      setEvidenceOpen(false);
      return;
    }
    setEvidenceOpen(true);
    setEvidenceMessage("");
    if (evidenceDocs.length > 0) {
      return;
    }
    setEvidenceBusy(true);
    const result = await loadEvidenceDocumentsAction();
    setEvidenceBusy(false);
    if (!result.ok) {
      setEvidenceFailed(true);
      setEvidenceMessage(result.message ?? "文档加载失败");
      return;
    }
    const documents = result.documents ?? [];
    setEvidenceDocs(documents);
    if (documents[0]) {
      await chooseEvidenceDocument(documents[0].id);
    }
  }

  async function submitEvidence() {
    if (props.mode !== "card") {
      return;
    }
    if (!evidenceChunkId || evidenceQuote.trim().length === 0) {
      setEvidenceFailed(true);
      setEvidenceMessage("请先选择切片并填写引文");
      return;
    }
    setEvidenceBusy(true);
    const result = await addEvidenceAction(props.card.id, evidenceChunkId, evidenceQuote);
    setEvidenceBusy(false);
    if (!result.ok) {
      setEvidenceFailed(true);
      setEvidenceMessage(result.message);
      return;
    }
    setEvidenceOpen(false);
    setEvidenceFailed(false);
    setEvidenceMessage("");
    setEvidenceChunkId("");
    setEvidenceQuote("");
    setFailed(false);
    setMessage(result.message);
    router.refresh();
  }

  function removeEvidence(evidenceId: string) {
    startTransition(async () => {
      const result = await removeEvidenceAction(evidenceId);
      setFailed(!result.ok);
      setMessage(result.message);
      if (result.ok) {
        router.refresh();
      }
    });
  }

  return (
    <section className="rounded-2xl border border-hairline bg-white p-4 shadow-card sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] text-zinc-500">{isDocument ? "文档" : "知识卡"}</p>
          <h2 className="mt-0.5 truncate text-[15px] font-semibold tracking-tight text-zinc-900">
            {initialTitle}
          </h2>
          <p className="mt-1 text-[11px] text-zinc-500">{metaLine}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnBlue}
            disabled={saveDisabled}
            title={conflict ? "请先处理版本冲突" : (readOnlyReason ?? undefined)}
            onClick={() => save()}
          >
            {pending ? "保存中…" : isDocument ? "保存为待确认卡片" : "保存"}
          </button>
          <button
            type="button"
            className={btnGhost}
            disabled={pending}
            onClick={() => router.push("/knowledge?tab=scout")}
          >
            取消
          </button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        {isDocument ? (
          <>
            <a className={`${linkBtn} text-[11px]`} href={`/api/knowledge/documents/${props.document.id}`}>
              下载原件
            </a>
            {!recycled ? (
              <DistillButton documentId={props.document.id} disabled={!props.aiEnabled} />
            ) : null}
          </>
        ) : null}

        {props.canWrite ? (
          recycled ? (
            <>
              <button
                type="button"
                className={`${linkBtn} text-[11px]`}
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = isDocument
                      ? await restoreDocumentAction(props.document.id)
                      : await restoreCardAction(props.card.id);
                    setFailed(!result.ok);
                    setMessage(result.message);
                    if (result.ok) {
                      router.refresh();
                    }
                  })
                }
              >
                {isDocument ? "从回收站恢复" : "恢复为待确认"}
              </button>
              <button
                type="button"
                className={`${linkBtn} text-[11px]`}
                disabled={pending}
                onClick={() => {
                  if (!confirmPurge) {
                    setConfirmPurge(true);
                    return;
                  }
                  setConfirmPurge(false);
                  startTransition(async () => {
                    const result = isDocument
                      ? await purgeDocumentAction(props.document.id)
                      : await purgeCardAction(props.card.id);
                    setFailed(!result.ok);
                    setMessage(result.message);
                    if (result.ok) {
                      router.push("/knowledge?tab=scout");
                      router.refresh();
                    }
                  });
                }}
              >
                {confirmPurge ? "确认彻底删除" : "彻底删除"}
              </button>
            </>
          ) : isDocument ? (
            <button
              type="button"
              className={`${linkBtn} text-[11px]`}
              disabled={pending}
              onClick={() => {
                if (!confirmTrash) {
                  setConfirmTrash(true);
                  return;
                }
                setConfirmTrash(false);
                startTransition(async () => {
                  const result = await trashDocumentAction(props.document.id);
                  setFailed(!result.ok);
                  setMessage(result.message);
                  if (result.ok) {
                    router.refresh();
                  }
                });
              }}
            >
              {confirmTrash ? "确认移入回收站" : "移入回收站"}
            </button>
          ) : null
        ) : null}

        {!recycled && props.canWrite ? (
          <button
            type="button"
            className={`${linkBtn} text-[11px]`}
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = isDocument
                  ? await setDocumentVisibilityAction(props.document.id, !shared)
                  : await setCardVisibilityAction(props.card.id, !shared);
                setFailed(!result.ok);
                setMessage(result.message);
                if (result.ok) {
                  setShared(!shared);
                  router.refresh();
                }
              })
            }
          >
            {shared ? "收回共享" : "加入公司共享"}
          </button>
        ) : null}
        <span className="text-[11px] text-zinc-400">
          {recycled
            ? isDocument
              ? "在 99-回收站 · 切片与原件仍保留，恢复后回到原目录"
              : "在 99-回收站 · 恢复后回到待确认"
            : shared
              ? "公司资料（共享） · 全员可读"
              : "仅本部门及下级可见"}
        </span>
      </div>

      {conflict ? (
        <div className="mt-3 rounded-xl border border-rose-200/80 bg-rose-50/50 p-3">
          <p className="text-[12px] font-medium text-rose-700">
            保存被拦截：{conflict.updatedByName ?? "其他人"}已把这张卡更新到 v{conflict.rev}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-rose-600/80">
            你的修改还没有写入，标题与正文仍是本地内容。可载入最新版本再改，或确认覆盖对方版本。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={`${linkBtn} text-[11px]`}
              disabled={pending}
              onClick={loadLatest}
            >
              载入最新内容
            </button>
            <button
              type="button"
              className={`${linkBtn} text-[11px]`}
              disabled={pending}
              onClick={() => {
                if (!confirmOverwrite) {
                  setConfirmOverwrite(true);
                  return;
                }
                setConfirmOverwrite(false);
                save(conflict.rev);
              }}
            >
              {confirmOverwrite ? "确认覆盖对方版本" : "覆盖并保存"}
            </button>
            <span className="text-[10px] tabular-nums text-rose-500/80">
              v{conflict.rev} · {formatTime(conflict.updatedAt)}
            </span>
          </div>
        </div>
      ) : null}

      {readOnlyReason ? (
        <InlineMessage className="mt-3 mb-0">{readOnlyReason}</InlineMessage>
      ) : null}

      <div className="mt-4 grid gap-3">
        <label className="block">
          <span className={fieldLabel}>标题</span>
          <input
            className={input}
            value={title}
            maxLength={120}
            disabled={blocked}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className="block">
          <span className={fieldLabel}>正文 · Markdown</span>
          <textarea
            className={`${input} min-h-[360px] resize-y font-mono text-[12.5px] leading-relaxed`}
            value={body}
            disabled={blocked}
            spellCheck={false}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>

        <label className="block sm:max-w-md">
          <span className={fieldLabel}>来源</span>
          <input
            className={input}
            value={source}
            maxLength={200}
            disabled={blocked}
            placeholder={isDocument ? `文档：${props.document.title}` : "文件 / 链接 / 谁说的"}
            onChange={(event) => setSource(event.target.value)}
          />
        </label>
      </div>

      {!isDocument ? (
        <div className="mt-4 rounded-xl border border-black/[0.06] bg-[#fafafa] px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-medium text-zinc-600">
              证据 · {evidenceTotal} 条
              {evidenceTotal > 0 ? `（${evidenceVerified} 条已对上原文）` : ""}
            </p>
            {props.canWrite && !recycled ? (
              <button
                type="button"
                className={`${linkBtn} text-[11px]`}
                disabled={evidenceBusy}
                onClick={() => void toggleEvidencePanel()}
              >
                {evidenceOpen ? "收起" : "添加证据"}
              </button>
            ) : null}
          </div>

          {props.card.evidence.length === 0 ? (
            <p className="mt-1.5 text-[11px] text-zinc-400">
              还没有证据。挂一条能逐字命中的原文后，这张卡才满足确认门槛。
            </p>
          ) : (
            <ul className="mt-2 grid gap-2">
              {props.card.evidence.map((item) => (
                <li key={item.id} className="flex items-start gap-2 text-[11px]">
                  <span
                    className={`mt-0.5 shrink-0 ${
                      item.verified ? "text-emerald-600" : "text-rose-600"
                    }`}
                    title={item.verified ? "引文已在原文中逐字命中" : "引文未能对上原文"}
                  >
                    {item.verified ? "✓" : "✗"}
                  </span>
                  <div className="min-w-0">
                    <p className="leading-relaxed text-zinc-600">“{item.quote}”</p>
                    <p className="mt-0.5 text-[10px] text-zinc-400">
                      {item.documentTitle ?? "文档"} · {item.locator ?? "未标注位置"}
                    </p>
                  </div>
                  {props.canWrite && !recycled ? (
                    <button
                      type="button"
                      className="ml-auto shrink-0 text-[10px] text-zinc-400 transition-colors hover:text-rose-600"
                      disabled={pending}
                      onClick={() => removeEvidence(item.id)}
                    >
                      移除
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {evidenceOpen ? (
            <div className="mt-3 grid gap-2 border-t border-black/[0.05] pt-3">
              <label className="block">
                <span className={fieldLabel}>来源文档</span>
                <select
                  className={input}
                  value={evidenceDocId}
                  disabled={evidenceBusy}
                  onChange={(event) => void chooseEvidenceDocument(event.target.value)}
                >
                  {evidenceDocs.length === 0 ? <option value="">没有可用文档</option> : null}
                  {evidenceDocs.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.title}（{doc.departmentName} · {doc.chunkCount} 个切片）
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className={fieldLabel}>切片</span>
                <select
                  className={input}
                  value={evidenceChunkId}
                  disabled={evidenceBusy || evidenceChunks.length === 0}
                  onChange={(event) => {
                    const chunk = evidenceChunks.find((item) => item.id === event.target.value);
                    setEvidenceChunkId(event.target.value);
                    if (chunk) {
                      setEvidenceQuote(chunk.text.slice(0, 600));
                    }
                  }}
                >
                  {evidenceChunks.length === 0 ? <option value="">该文档没有切片</option> : null}
                  {evidenceChunks.map((chunk) => (
                    <option key={chunk.id} value={chunk.id}>
                      {chunk.pageNo ? `第 ${chunk.pageNo} 页` : `切片 ${chunk.ord + 1}`} ·{" "}
                      {chunk.text.replace(/\s+/g, " ").slice(0, 36)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className={fieldLabel}>引文 · 必须与原文逐字一致</span>
                <textarea
                  className={`${input} min-h-[90px] resize-y font-mono text-[12px] leading-relaxed`}
                  value={evidenceQuote}
                  maxLength={600}
                  disabled={evidenceBusy}
                  onChange={(event) => setEvidenceQuote(event.target.value)}
                />
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className={`${linkBtn} text-[11px]`}
                  disabled={evidenceBusy || !evidenceChunkId}
                  onClick={() => void submitEvidence()}
                >
                  {evidenceBusy ? "核对中…" : "核对并挂上"}
                </button>
                <button
                  type="button"
                  className={`${linkBtn} text-[11px]`}
                  disabled={evidenceBusy}
                  onClick={() => setEvidenceOpen(false)}
                >
                  取消
                </button>
              </div>

              {evidenceMessage ? (
                <InlineMessage tone={evidenceFailed ? "error" : "info"} className="mt-1 mb-0">
                  {evidenceMessage}
                </InlineMessage>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {isDocument && !trashed ? (
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-400">
          保存不会改动原始文件：内容是切片按顺序拼出的正文，保存后生成一张「待确认」知识卡，可在 00-知识卡
          里继续补充证据并确认。
        </p>
      ) : null}

      {message ? (
        <InlineMessage tone={failed ? "error" : "info"} className="mt-3 mb-0">
          {message}
        </InlineMessage>
      ) : null}

      {!isDocument && props.card.versions.length > 0 ? (
        <details className="mt-4 rounded-xl border border-black/[0.06] bg-[#fafafa] px-3 py-2">
          <summary className="cursor-pointer list-none text-[11px] text-zinc-500">
            版本历史 · 最近 {props.card.versions.length} 条
          </summary>
          <ul className="mt-2 grid gap-1.5">
            {props.card.versions.map((version) => (
              <li key={version.id} className="flex items-center gap-2 text-[11px] text-zinc-500">
                <span className="w-8 shrink-0 tabular-nums text-zinc-600">v{version.rev}</span>
                <span className="truncate">{version.editedByName ?? "—"}</span>
                {version.rev === props.card.rev ? (
                  <span className="shrink-0 text-[10px] text-emerald-600">当前</span>
                ) : null}
                <span className="ml-auto shrink-0 tabular-nums text-zinc-400">
                  {formatTime(version.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
