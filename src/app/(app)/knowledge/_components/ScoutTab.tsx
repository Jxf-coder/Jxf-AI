"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { EmptyState } from "@/components/knowledge/EmptyState";
import { Field } from "@/components/knowledge/Field";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { Pill } from "@/components/knowledge/Pill";
import { SectionCard } from "@/components/knowledge/SectionCard";
import { badge, btnBlue, btnGhost, formGrid, input, linkBtn, meta } from "@/components/knowledge/tokens";

import { loadRunDetailAction, revokeRunAction, type RunDetailView } from "../actions";
import { filesFromDataTransfer, filesFromInput, type DroppedFile } from "./file-drop";

export interface ScoutRunItem {
  id: string;
  status: string;
  goal: string | null;
  counts: Record<string, number>;
  createdAt: string;
  creatorName: string | null;
}

const RUN_STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  running: "进行中",
  done: "完成",
  failed: "失败",
  revoked: "已撤回",
};

const DECISION_LABEL: Record<string, string> = {
  pending: "未处理",
  rule_keep: "已入库",
  model_keep: "已入库",
  rule_skip: "已跳过",
  model_skip: "已跳过",
  ask: "待人工",
  error: "出错",
};

function statusTone(status: string): "ok" | "warn" | "error" | "muted" {
  if (status === "done") return "ok";
  if (status === "failed") return "error";
  if (status === "revoked") return "muted";
  return "warn";
}

function decisionTone(decision: string): "ok" | "warn" | "error" | "muted" {
  if (decision === "rule_keep" || decision === "model_keep") return "ok";
  if (decision === "ask") return "warn";
  if (decision === "error") return "error";
  return "muted";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

interface ScoutTabProps {
  runs: ScoutRunItem[];
  canWrite: boolean;
}

/** 巡读上传：逐文件入库 + 批次详情 + 整批撤回 */
export function ScoutTab({ runs, canWrite }: ScoutTabProps) {
  const router = useRouter();
  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);

  const [goal, setGoal] = useState("");
  const [maxFiles, setMaxFiles] = useState("40");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; name: string } | null>(null);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const [selected, setSelected] = useState(runs[0]?.id ?? "");
  const [detail, setDetail] = useState<RunDetailView | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  async function loadDetail(id: string) {
    setDetailBusy(true);
    const result = await loadRunDetailAction(id);
    setDetailBusy(false);
    if (result.ok && result.detail) {
      setDetail(result.detail);
    } else {
      setDetail(null);
      setFailed(true);
      setMessage(result.message ?? "批次详情加载失败");
    }
  }

  useEffect(() => {
    if (selected) {
      void loadDetail(selected);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function upload(files: DroppedFile[]) {
    if (!canWrite) {
      return;
    }
    if (files.length === 0) {
      setFailed(true);
      setMessage("没有可上传的文件");
      return;
    }

    const limit = Math.max(1, Math.min(files.length, Number(maxFiles) || 40, 200));
    const queue = files.slice(0, limit);

    setBusy(true);
    setFailed(false);
    setMessage("");

    let runId = "";
    let kept = 0;
    let skipped = 0;
    let errors = 0;

    try {
      for (let index = 0; index < queue.length; index += 1) {
        const item = queue[index];
        setProgress({ done: index, total: queue.length, name: item.path });

        const body = new FormData();
        body.set("file", item.file);
        body.set("path", item.path);
        if (runId) body.set("runId", runId);
        if (goal.trim()) body.set("goal", goal.trim());

        const response = await fetch("/api/knowledge/upload/file", { method: "POST", body });
        const payload = (await response.json().catch(() => ({}))) as {
          ok?: boolean;
          runId?: string;
          error?: string;
          file?: { decision?: string };
        };

        if (payload.runId) {
          runId = payload.runId;
        }
        if (!response.ok || !payload.ok) {
          errors += 1;
          continue;
        }

        const decision = payload.file?.decision ?? "";
        if (decision === "rule_keep" || decision === "model_keep") {
          kept += 1;
        } else {
          skipped += 1;
        }
      }

      setProgress({ done: queue.length, total: queue.length, name: "" });
      setMessage(`本批 ${queue.length} 个文件：入库 ${kept} · 跳过 ${skipped} · 失败 ${errors}`);
      setFailed(errors > 0 && kept === 0);
      router.refresh();

      if (runId) {
        setSelected(runId);
        await loadDetail(runId);
      }
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "上传失败");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!detail) {
      return;
    }
    setDetailBusy(true);
    const formData = new FormData();
    formData.set("runId", detail.id);
    const result = await revokeRunAction(formData);
    setDetailBusy(false);
    setConfirmRevoke(false);
    setFailed(!result.ok);
    setMessage(result.message);
    if (result.ok) {
      await loadDetail(detail.id);
      router.refresh();
    }
  }

  const counts: Array<[string, number]> = detail
    ? [
        ["文件", detail.counts.files ?? 0],
        ["已入库", detail.counts.documents ?? 0],
        ["跳过", detail.counts.skipped ?? 0],
        ["待人工", detail.counts.needsOcr ?? 0],
        ["出错", detail.counts.errors ?? 0],
        ["切片", detail.counts.chunks ?? 0],
        ["向量", detail.counts.embedded ?? 0],
      ]
    : [];

  return (
    <div className="flex flex-col gap-4">
      <SectionCard
        title="上传文档"
        right={<span className={badge()}>单文件 ≤ 20MB</span>}
        desc="支持 PDF / DOCX / TXT / Markdown / CSV；可以拖文件夹，按顺序逐个入库，扫描件会标记为「待 OCR」。"
      >
        {!canWrite ? (
          <InlineMessage>当前账号没有「知识入库」权限，只能查看本部门文档与知识卡。</InlineMessage>
        ) : (
          <>
            <div className={formGrid}>
              <Field label="入库目标（选填）">
                <input
                  className={input}
                  value={goal}
                  maxLength={200}
                  placeholder="例如：补齐 2026 年食品接触材料验收标准"
                  onChange={(event) => setGoal(event.target.value)}
                />
              </Field>
              <Field label="本次最多上传">
                <input
                  className={input}
                  inputMode="numeric"
                  value={maxFiles}
                  maxLength={3}
                  onChange={(event) => setMaxFiles(event.target.value.replace(/\D/g, ""))}
                />
              </Field>
            </div>

            <div
              className={`mt-3 flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-6 text-center transition-colors ${
                dragOver ? "border-apple-blue bg-apple-blue-soft/40" : "border-black/[0.08]"
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                void filesFromDataTransfer(event.dataTransfer, 200).then(upload);
              }}
            >
              {busy && progress ? (
                <>
                  <p className="text-[14px] font-semibold text-zinc-900">
                    上传中 {Math.min(progress.done + 1, progress.total)}/{progress.total}
                  </p>
                  <p className="max-w-full truncate text-[11px] text-zinc-500">{progress.name || "收尾中…"}</p>
                  <div className="mt-1 h-1.5 w-full max-w-[280px] overflow-hidden rounded-full bg-apple-canvas">
                    <div
                      className="h-full bg-apple-blue transition-all"
                      style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
                    />
                  </div>
                </>
              ) : (
                <>
                  <p className="text-[14px] font-semibold text-zinc-900">把文件或文件夹拖到这里</p>
                  <p className="text-[12px] text-zinc-500">
                    按顺序逐个解析入库，源文件不动；重复内容会按 sha256 自动跳过。
                  </p>
                  <div className="mt-2 flex flex-wrap justify-center gap-2">
                    <button
                      type="button"
                      className={btnBlue}
                      disabled={busy}
                      onClick={() => folderRef.current?.click()}
                    >
                      选文件夹
                    </button>
                    <button
                      type="button"
                      className={btnGhost}
                      disabled={busy}
                      onClick={() => filesRef.current?.click()}
                    >
                      选文件
                    </button>
                  </div>
                </>
              )}

              <input
                ref={folderRef}
                type="file"
                multiple
                className="hidden"
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                onChange={(event) => {
                  const picked = filesFromInput(event.target.files, 200);
                  event.target.value = "";
                  void upload(picked);
                }}
              />
              <input
                ref={filesRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  const picked = filesFromInput(event.target.files, 200);
                  event.target.value = "";
                  void upload(picked);
                }}
              />
            </div>

            {message ? (
              <InlineMessage tone={failed ? "error" : "info"} className="mt-3 mb-0">
                {message}
              </InlineMessage>
            ) : null}
          </>
        )}
      </SectionCard>

      <SectionCard title="入库批次" count={`最近 ${runs.length} 次`}>
        {runs.length === 0 ? (
          <EmptyState>还没有入库批次。上传文件后会自动生成一条。</EmptyState>
        ) : (
          <div className="grid gap-3 lg:grid-cols-[280px_1fr]">
            <ul className="flex max-h-[520px] list-none flex-col gap-1 overflow-auto p-0">
              {runs.map((run) => (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(run.id)}
                    className={`w-full rounded-xl border px-2.5 py-2 text-left transition-colors ${
                      selected === run.id
                        ? "border-apple-blue/40 bg-apple-blue-soft/40"
                        : "border-hairline hover:bg-apple-canvas"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[12px] font-semibold text-zinc-900">
                        {run.goal || "未填目标"}
                      </span>
                      <span className="ml-auto shrink-0">
                        <Pill tone={statusTone(run.status)}>
                          {RUN_STATUS_LABEL[run.status] ?? run.status}
                        </Pill>
                      </span>
                    </div>
                    <div className={`${meta} mt-0.5`}>
                      {formatDate(run.createdAt)} · 文件 {run.counts.files ?? 0} · 入库{" "}
                      {run.counts.documents ?? 0} · 跳过 {run.counts.skipped ?? 0}
                    </div>
                  </button>
                </li>
              ))}
            </ul>

            <div className="min-w-0">
              {!detail ? (
                <EmptyState>{detailBusy ? "加载批次详情…" : "选一个批次查看详情。"}</EmptyState>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-semibold text-zinc-900">
                      {detail.goal || "未填目标"}
                    </span>
                    <Pill tone={statusTone(detail.status)}>
                      {RUN_STATUS_LABEL[detail.status] ?? detail.status}
                    </Pill>
                    <span className={`${meta}`}>
                      {detail.creatorName ?? "—"} · {formatDate(detail.createdAt)}
                    </span>

                    <span className="ml-auto flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={linkBtn}
                        disabled={detailBusy}
                        onClick={() => {
                          void loadDetail(detail.id);
                          router.refresh();
                        }}
                      >
                        刷新
                      </button>
                      {canWrite && detail.status !== "revoked" ? (
                        confirmRevoke ? (
                          <>
                            <button type="button" className={linkBtn} disabled={detailBusy} onClick={() => void revoke()}>
                              确认撤回
                            </button>
                            <button type="button" className={linkBtn} onClick={() => setConfirmRevoke(false)}>
                              取消
                            </button>
                          </>
                        ) : (
                          <button type="button" className={linkBtn} onClick={() => setConfirmRevoke(true)}>
                            整批撤回
                          </button>
                        )
                      ) : null}
                    </span>
                  </div>

                  <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                    {counts.map(([label, value]) => (
                      <div key={label} className="rounded-xl bg-apple-canvas px-2 py-1.5">
                        <p className="text-[10px] text-zinc-500">{label}</p>
                        <p className="text-[14px] font-semibold text-zinc-900">{value}</p>
                      </div>
                    ))}
                  </div>

                  {detail.files.length === 0 ? (
                    <p className={`${meta} mt-3`}>这批还没有文件记录。</p>
                  ) : (
                    <ul className="mt-3 max-h-[320px] list-none space-y-1 overflow-auto p-0">
                      {detail.files.map((file) => (
                        <li
                          key={file.id}
                          className="flex flex-wrap items-center gap-2 border-t border-black/[0.04] py-1.5 text-[11px]"
                        >
                          <Pill tone={decisionTone(file.decision)}>
                            {DECISION_LABEL[file.decision] ?? file.decision}
                          </Pill>
                          <span className="min-w-0 flex-1 truncate text-zinc-900" title={file.sourcePath}>
                            {file.sourcePath}
                          </span>
                          <span className="shrink-0 text-zinc-500">
                            {file.reason ?? file.error ?? ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
