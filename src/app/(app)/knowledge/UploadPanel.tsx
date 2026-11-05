"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

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
    return (
      <div className="alert-info">
        当前账号没有「知识入库」权限，只能查看本部门文档与知识卡。
      </div>
    );
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <div className="card-title">上传文档</div>
      <p className="hint">
        支持 PDF / DOCX / TXT / Markdown / CSV，单文件 ≤ 20MB，单次 ≤ 20 个。扫描件会标记为「待 OCR」，不生成切片。
      </p>
      {!aiEnabled ? (
        <div className="alert-info">
          未配置 AI 密钥：本次入库只做解析与分块，检索走 pg_bigm 纯关键词通道，向量通道自动跳过。
        </div>
      ) : null}

      <div className="form-grid">
        <label>
          文件
          <input ref={inputRef} type="file" name="files" multiple />
        </label>
        <label>
          入库目标（选填）
          <input
            type="text"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="例如：补齐 2026 年食品接触材料验收标准"
            maxLength={200}
          />
        </label>
      </div>

      <div className="perm-savebar">
        <button type="submit" className="button" disabled={busy}>
          {busy ? "正在解析入库…" : "开始入库"}
        </button>
      </div>

      {result ? (
        <div className={result.ok ? "alert-info" : "alert-error"}>
          {result.ok && result.counts ? (
            <>
              <div>
                批次完成：文件 {result.counts.files} · 入库 {result.counts.documents} · 跳过 {result.counts.skipped} ·
                待人工 {result.counts.needsOcr} · 切片 {result.counts.chunks} · 向量 {result.counts.embedded}
                {result.counts.embeddingSkipped > 0 ? ` · 未向量化 ${result.counts.embeddingSkipped}` : ""}
              </div>
              <ul>
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
        </div>
      ) : null}
    </form>
  );
}
