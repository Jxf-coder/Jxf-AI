/**
 * 入库流水线（M2-B）：上传 → 规则筛 → 解析 → 分块 → 向量化 → 落库。
 *
 * 事务边界：解析 / 向量化 / 对象存储都在事务外完成，事务内只做去重判断与写入，
 * 避免长事务持锁；embedding 失败不阻断入库，切片保留为空向量（检索自动降级）。
 *
 * 扫描件（无文本层）落 documents.status = 'needs_ocr'，不生成切片——不假装读过。
 */

import { createHash } from "node:crypto";
import path from "node:path";

import type { PoolClient } from "pg";

import { embedTexts } from "@/lib/ai/openai";
import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { chunkPages, type TextChunk } from "@/lib/knowledge/chunk";
import {
  DEFAULT_DOCUMENT_FOLDER,
  isFolderKey,
  type FolderKey,
} from "@/lib/knowledge/folders";
import { fileExtension, parseDocument, UnsupportedDocumentError } from "@/lib/knowledge/parse";
import { errorMessage, log } from "@/lib/logger";
import { requireContextPermission } from "@/lib/permissions/server";
import { putObject, uploadKey } from "@/lib/storage/local";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_PER_RUN = 20;

const ALLOWED_EXTENSIONS = new Set(["pdf", "docx", "txt", "md", "markdown", "csv", "json", "html", "htm", "log", "xml"]);

export interface IngestFileInput {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export type IngestDecision = "rule_keep" | "rule_skip" | "ask" | "error";

export interface IngestFileResult {
  name: string;
  decision: IngestDecision;
  reason?: string;
  error?: string;
  documentId?: string;
  chunkCount?: number;
  embedded?: boolean;
}

export interface IngestCounts {
  files: number;
  kept: number;
  skipped: number;
  needsOcr: number;
  errors: number;
  documents: number;
  chunks: number;
  embedded: number;
  embeddingSkipped: number;
}

export interface IngestResult {
  runId: string;
  counts: IngestCounts;
  files: IngestFileResult[];
}

interface PreparedDocument {
  input: IngestFileInput;
  sha256: string;
  storageKey: string;
  status: "parsed" | "needs_ocr";
  pageCount: number;
  chunks: TextChunk[];
  charCount: number;
  embeddings: number[][] | null;
}

interface ExistingAsset {
  assetId: string;
  documentId: string | null;
}

export interface IngestOptions {
  /** 追加到已有批次：逐文件上传时复用同一个 run */
  runId?: string;
  /** 目标标准目录；缺省落「01-原始素材」 */
  folderKey?: string;
}

export async function ingestUpload(
  context: UserContext,
  inputs: IngestFileInput[],
  goal?: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  if (!context.activeDepartmentId) {
    throw new Error("当前账号没有有效部门上下文，无法入库");
  }
  if (inputs.length === 0) {
    throw new Error("没有收到文件");
  }
  if (inputs.length > MAX_FILES_PER_RUN) {
    throw new Error(`单次最多上传 ${MAX_FILES_PER_RUN} 个文件`);
  }

  const departmentId = context.activeDepartmentId;
  const results: IngestFileResult[] = [];
  const prepared: PreparedDocument[] = [];

  // 0. 冻结落盘维度：部门 slug + 上传者当前岗位 + 目标标准目录
  const scope = await withUserContext(context, async (client) => {
    const department = await client.query<{ slug: string }>(
      `select slug from departments where id = $1`,
      [departmentId],
    );
    const membership = await client.query<{ position: string | null }>(
      `select position from memberships
        where user_id = $1 and department_id = $2 and status = 'active'
        limit 1`,
      [context.userId, departmentId],
    );
    return {
      departmentSlug: department.rows[0]?.slug ?? departmentId.slice(0, 8),
      role: (membership.rows[0]?.position ?? "").trim(),
    };
  });

  const roleKey = scope.role;
  const folderKey: FolderKey = isFolderKey(options.folderKey)
    ? options.folderKey
    : DEFAULT_DOCUMENT_FOLDER;

  // 1. 规则筛 + 解析 + 分块 + 向量化（事务外）
  for (const input of inputs) {
    const extension = fileExtension(input.name);

    if (!ALLOWED_EXTENSIONS.has(extension)) {
      results.push({ name: input.name, decision: "rule_skip", reason: `不支持的文件类型：${extension || "未知"}` });
      continue;
    }
    if (input.bytes.byteLength === 0) {
      results.push({ name: input.name, decision: "rule_skip", reason: "空文件" });
      continue;
    }
    if (input.bytes.byteLength > MAX_FILE_BYTES) {
      results.push({ name: input.name, decision: "rule_skip", reason: "文件超过 20MB" });
      continue;
    }

    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    // 物理路径：public/uploads/{部门}/{岗位}/{标准目录}/{sha8}-文件名
    const storageKey = uploadKey({
      department: scope.departmentSlug,
      role: roleKey,
      folder: folderKey,
      filename: `${sha256.slice(0, 8)}-${path.basename(input.name)}`,
    });

    try {
      const parsed = await parseDocument(input.bytes, input.mime, input.name);

      if (!parsed.hasText) {
        prepared.push({
          input,
          sha256,
          storageKey,
          status: "needs_ocr",
          pageCount: parsed.pages.length,
          chunks: [],
          charCount: 0,
          embeddings: null,
        });
        continue;
      }

      const chunked = chunkPages(parsed.pages);
      if (chunked.chunks.length === 0) {
        results.push({ name: input.name, decision: "error", error: "分块结果为空" });
        continue;
      }

      prepared.push({
        input,
        sha256,
        storageKey,
        status: "parsed",
        pageCount: parsed.pages.length,
        chunks: chunked.chunks,
        charCount: chunked.charCount,
        embeddings: await embedTexts(chunked.chunks.map((chunk) => chunk.text)),
      });
    } catch (error) {
      if (error instanceof UnsupportedDocumentError) {
        results.push({ name: input.name, decision: "rule_skip", reason: error.message });
      } else {
        log("warn", "ingest_parse_failed", {
          file: input.name,
          department_id: departmentId,
          error: errorMessage(error),
        });
        results.push({ name: input.name, decision: "error", error: errorMessage(error) });
      }
    }
  }

  // 2. 去重预查（短事务，只读）
  const shas = prepared.map((item) => item.sha256);
  const existing = await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    if (shas.length === 0) {
      return new Map<string, ExistingAsset>();
    }

    const { rows } = await client.query<{ asset_id: string; id: string | null; sha256: string }>(
      `select a.id as asset_id, d.id, a.sha256
         from assets a
         left join documents d on d.asset_id = a.id
        where a.department_id = $1
          and a.sha256 = any($2::text[])`,
      [departmentId, shas],
    );

    return new Map(rows.map((row) => [row.sha256, { assetId: row.asset_id, documentId: row.id }]));
  });

  // 3. 新文件写入对象存储（库内已存在的同 sha 直接跳过）
  const fresh: PreparedDocument[] = [];
  const batchShas = new Set<string>();
  for (const item of prepared) {
    const hit = existing.get(item.sha256);
    if (hit) {
      results.push({
        name: item.input.name,
        decision: "rule_skip",
        reason: "同部门已存在相同内容（sha256 重复）",
        documentId: hit.documentId ?? undefined,
      });
      continue;
    }
    if (batchShas.has(item.sha256)) {
      results.push({ name: item.input.name, decision: "rule_skip", reason: "本批次内文件内容重复" });
      continue;
    }
    batchShas.add(item.sha256);
    await putObject(item.storageKey, item.input.bytes);
    fresh.push(item);
  }

  const skippedCount = results.filter((item) => item.decision === "rule_skip").length;
  const errorCount = results.filter((item) => item.decision === "error").length;

  const counts: IngestCounts = {
    files: 0,
    kept: 0,
    skipped: 0,
    needsOcr: 0,
    errors: 0,
    documents: 0,
    chunks: 0,
    embedded: 0,
    embeddingSkipped: 0,
  };

  // 4. 落库（可追加到已有批次：runId 复用）
  const runId = await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    let createdRunId: string;

    if (options.runId) {
      const existing = await client.query<{
        id: string;
        department_id: string;
        status: string;
        counts: Record<string, number> | null;
      }>(
        `select id, department_id, status, counts
           from ingest_runs
          where id = $1
          for update`,
        [options.runId],
      );
      const row = existing.rows[0];
      if (!row) {
        throw new Error("入库批次不存在");
      }
      if (row.department_id !== departmentId) {
        throw new Error("无权写入该入库批次");
      }
      if (row.status === "revoked") {
        throw new Error("该批次已撤回，不能再追加文件");
      }
      createdRunId = row.id;
      Object.assign(counts, row.counts ?? {});
      await client.query(`update ingest_runs set status = 'running' where id = $1`, [createdRunId]);
    } else {
      const run = await client.query<{ id: string }>(
        `insert into ingest_runs (tenant_id, department_id, kind, goal, status, created_by)
         values ($1, $2, 'upload', $3, 'running', $4)
         returning id`,
        [context.tenantId, departmentId, goal?.trim() || null, context.userId],
      );
      createdRunId = run.rows[0].id;
    }

    counts.files += inputs.length;
    counts.kept += fresh.length;
    counts.skipped += skippedCount;
    counts.errors += errorCount;

    for (const item of fresh) {
      const asset = await client.query<{ id: string }>(
        `insert into assets (tenant_id, department_id, title, storage_key, mime, byte_size, sha256, kind, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, 'document', $8)
         returning id`,
        [
          context.tenantId,
          departmentId,
          item.input.name,
          item.storageKey,
          item.input.mime || "application/octet-stream",
          item.input.bytes.byteLength,
          item.sha256,
          context.userId,
        ],
      );

      const document = await client.query<{ id: string }>(
        `insert into documents
           (tenant_id, department_id, asset_id, ingest_run_id, title, mime, role_key, folder_key,
            page_count, char_count, status, sha256)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         returning id`,
        [
          context.tenantId,
          departmentId,
          asset.rows[0].id,
          createdRunId,
          item.input.name,
          item.input.mime || "application/octet-stream",
          roleKey || null,
          folderKey,
          item.pageCount,
          item.charCount,
          item.status,
          item.sha256,
        ],
      );
      const documentId = document.rows[0].id;

      if (item.chunks.length > 0) {
        const payload = item.chunks.map((chunk, index) => ({
          ord: chunk.ord,
          page_no: chunk.pageNo,
          char_start: chunk.charStart,
          char_end: chunk.charEnd,
          text: chunk.text,
          embedding: item.embeddings?.[index] ? `[${item.embeddings[index].join(",")}]` : null,
        }));

        await client.query(
          `insert into doc_chunks
             (tenant_id, department_id, document_id, ord, page_no, char_start, char_end, text, embedding)
           select $1, $2, $3, x.ord, x.page_no, x.char_start, x.char_end, x.text,
                  case when x.embedding is null then null else x.embedding::vector end
             from jsonb_to_recordset($4::jsonb)
               as x(ord int, page_no int, char_start int, char_end int, text text, embedding text)`,
          [context.tenantId, departmentId, documentId, JSON.stringify(payload)],
        );
      }

      const decision: IngestDecision = item.status === "needs_ocr" ? "ask" : "rule_keep";
      await client.query(
        `insert into ingest_files (run_id, asset_id, source_path, decision, reason, document_id)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          createdRunId,
          asset.rows[0].id,
          item.input.name,
          decision,
          item.status === "needs_ocr" ? "扫描件，未解析出文字，待人工处理" : null,
          documentId,
        ],
      );

      const embedded = Boolean(item.embeddings);
      counts.documents += 1;
      counts.chunks += item.chunks.length;
      if (item.status === "needs_ocr") {
        counts.needsOcr += 1;
      } else if (embedded) {
        counts.embedded += item.chunks.length;
      } else {
        counts.embeddingSkipped += item.chunks.length;
      }

      results.push({
        name: item.input.name,
        decision,
        reason: item.status === "needs_ocr" ? "扫描件待 OCR" : undefined,
        documentId,
        chunkCount: item.chunks.length,
        embedded,
      });
    }

    // 跳过 / 出错的条目同样留痕，便于人工复核
    for (const item of results) {
      if (item.decision === "rule_keep" || item.decision === "ask") {
        continue;
      }
      await client.query(
        `insert into ingest_files (run_id, source_path, decision, reason, error, document_id)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          createdRunId,
          item.name,
          item.decision,
          item.reason ?? null,
          item.error ?? null,
          item.documentId ?? null,
        ],
      );
    }

    const runStatus = counts.kept === 0 && counts.errors > 0 ? "failed" : "done";
    await client.query(
      `update ingest_runs
          set status = $2, counts = $3::jsonb, finished_at = now()
        where id = $1`,
      [createdRunId, runStatus, JSON.stringify(counts)],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.ingest_completed",
      targetType: "ingest_run",
      targetId: createdRunId,
      departmentId,
      payload: { ...counts },
    });

    return createdRunId;
  });

  return { runId, counts, files: results };
}

/** 批次撤回：只撤回本批未确认的产出，已确认的知识卡不回滚 */
export async function revokeIngestRun(context: UserContext, runId: string): Promise<void> {
  await withUserContext(context, async (client: PoolClient) => {
    const run = await client.query<{ department_id: string }>(
      "select department_id from ingest_runs where id = $1",
      [runId],
    );
    const departmentId = run.rows[0]?.department_id;
    if (!departmentId) {
      throw new Error("入库批次不存在");
    }

    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    await client.query(
      `update documents set status = 'revoked' where ingest_run_id = $1 and status <> 'revoked'`,
      [runId],
    );
    await client.query(
      `update knowledge_cards set status = 'dropped'
        where ingest_run_id = $1 and status = 'pending'`,
      [runId],
    );
    await client.query(`update ingest_runs set status = 'revoked' where id = $1`, [runId]);

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.ingest_revoked",
      targetType: "ingest_run",
      targetId: runId,
      departmentId,
    });
  });
}
