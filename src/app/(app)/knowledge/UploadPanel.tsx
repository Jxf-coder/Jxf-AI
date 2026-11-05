"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Field } from "@/components/knowledge/Field";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import {
  actions,
  badge,
  btnDark,
  card,
  cardDesc,
  cardHead,
  cardTitle,
  fileInput,
  formGrid,
  input,
} from "@/components/knowledge/tokens";

interface IngestResponse {
  ok: boolean;
  error?: string;
  counts?: {
    files: number;
    kept: number;
    skipped: number;
    needsOcr: number;
    errors: number;
    documents: number;
    chunks: number;
    embedded: number;
    embeddingSkipped: number;
  };
  files?: Array<{ name: string; decision: string; reason?: string; error?: string; chunkCount?: number }>;
}

const DECISION_LABEL: Record<string, string> = {
  rule_keep: "已入库",
  rule_skip: "已跳过",
  ask: "待人工",
  error: "解析失败",
};

export function UploadPanel({ canWrite, aiEnabled }: { canWrite: boolean; aiEnabled: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IngestResponse | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const files = inputRef.current?.files;
    if (!files || files.length === 0) {
      setResult({ ok: false, error: "请先选择文件" });
      return;
    }

    const body = new FormData();
    for (const file of Array.from(files)) {
      body.append("files", file);
    }
    if (goal.trim()) {
      body.append("goal", goal.trim());
    }

    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/knowledge/upload", { method: "POST", body });
      const payload = (await response.json()) as IngestResponse;
      setResult(payload);
      if (payload.ok) {
        if (inputRef.current) {
          inputRef.current.value = "";
        }
        setGoal("");
        router.refresh();
      }
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : "上传失败" });
    } finally {
      setBusy(false);
    }
  }

  if (!canWrite) {
    return <InlineMessage>当前账号没有「知识入库」权限，只能查看本部门文档与知识卡。</InlineMessage>;
  }

  return (
    <form className={card} onSubmit={onSubmit}>
      <div className={cardHead}>
        <h2 className={cardTitle}>上传文档</h2>
        <span className={badge()}>≤ 20MB · ≤ 20 个</span>
      </div>
      <p className={cardDesc}>
        支持 PDF / DOCX / TXT / Markdown / CSV。扫描件会标记为「待 OCR」，不生成切片。
      </p>
      {!aiEnabled ? (
        <InlineMessage>
          未配置 AI 密钥：本次入库只做解析与分块，检索走 pg_bigm 纯关键词通道，向量通道自动跳过。
        </InlineMessage>
      ) : null}

      <div className={formGrid}>
        <Field label="文件">
          <input ref={inputRef} className={fileInput} type="file" name="files" multiple />
        </Field>
        <Field label="入库目标（选填）">
          <input
            className={input}
            type="text"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="例如：补齐 2026 年食品接触材料验收标准"
            maxLength={200}
          />
        </Field>
      </div>

      <div className={actions}>
        <button type="submit" className={btnDark} disabled={busy}>
          {busy ? "正在解析入库…" : "开始入库"}
        </button>
      </div>

      {result ? (
        <InlineMessage tone={result.ok ? "info" : "error"} className="mt-4 mb-0">
          {result.ok && result.counts ? (
            <>
              <div>
                批次完成：文件 {result.counts.files} · 入库 {result.counts.documents} · 跳过 {result.counts.skipped} ·
                待人工 {result.counts.needsOcr} · 切片 {result.counts.chunks} · 向量 {result.counts.embedded}
                {result.counts.embeddingSkipped > 0 ? ` · 未向量化 ${result.counts.embeddingSkipped}` : ""}
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {(result.files ?? []).map((file) => (
                  <li key={`${file.name}-${file.decision}`}>
                    {file.name} — {DECISION_LABEL[file.decision] ?? file.decision}
                    {file.reason ? `（${file.reason}）` : ""}
                    {file.error ? `（${file.error}）` : ""}
                    {file.chunkCount !== undefined ? `，${file.chunkCount} 个切片` : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            result.error ?? "上传失败"
          )}
        </InlineMessage>
      ) : null}
    </form>
  );
}
