/**
 * 扫描件补录：把 OCR 出来的正文重新变成可检索的切片。
 *
 * 红线：
 * - 只允许「待 OCR / 解析失败」的文档补录，绝不覆盖已解析文档（避免证据链指向旧切片）；
 * - 补录后重建切片并重新向量化，状态转 parsed；向量失败不阻断（检索降级为关键词）；
 * - 分页由人工标记「【第 N 页】」决定，没有标记就视为一页——页码不猜。
 */

import type { PoolClient } from "pg";

import { auditInTx } from "@/lib/audit";
import { embedTexts } from "@/lib/ai/openai";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { chunkPages } from "@/lib/knowledge/chunk";
import { folderLabel } from "@/lib/knowledge/folders";
import { requireContextPermission } from "@/lib/permissions/server";

export interface NeedsOcrDocument {
  id: string;
  title: string;
  status: string;
  pageCount: number | null;
  departmentName: string;
  folderLabel: string;
  createdAt: string;
  runGoal: string | null;
}

export interface OcrSubmitResult {
  pages: number;
  chunks: number;
  embedded: boolean;
}

const MAX_TEXT = 2_000_000;
const PAGE_MARKER = /^[ \t]*(?:【第\s*(\d+)\s*页】|\[第\s*(\d+)\s*页\]|-{2,}\s*第\s*(\d+)\s*页\s*-{2,})[ \t]*$/gm;

/** 按「【第 N 页】」把文本切页；没有标记则整篇一页 */
export function splitOcrPages(raw: string): string[] {
  const text = raw.replace(/\r\n?/g, "\n");
  const markers = [...text.matchAll(PAGE_MARKER)];
  if (markers.length === 0) {
    const single = text.trim();
    return single.length > 0 ? [single] : [];
  }

  const pages: string[] = [];
  const leading = text.slice(0, markers[0].index).trim();
  if (leading.length > 0) {
    pages.push(leading);
  }

  markers.forEach((marker, index) => {
    const start = (marker.index ?? 0) + marker[0].length;
    const end = index + 1 < markers.length ? markers[index + 1].index : text.length;
    const page = text.slice(start, end).trim();
    if (page.length > 0) {
      pages.push(page);
    }
  });

  return pages;
}

export interface ParsedPages {
  pages: string[];
  hasText: boolean;
}

export interface OcrPages {
  text: string;
  model: string;
}

/**
 * 合并「解析结果」与「自动 OCR 结果」——入库决策的唯一出口。
 *
 * 规则：
 * - 有文本层：永远用解析结果，OCR 结果不参与（不让模型改写原生文本）；
 * - 扫描件 + 识别成功且切出页：按 OCR 正文入库，并记录模型名；
 * - 扫描件 + 未识别 / 识别为空：返回空页，调用方如实标 needs_ocr，绝不假装读过。
 */
export function mergeScannedPages(
  parsed: ParsedPages,
  scanned: OcrPages | null,
): { pages: string[]; ocrModel: string | null } {
  if (parsed.hasText) {
    return { pages: parsed.pages, ocrModel: null };
  }
  if (!scanned) {
    return { pages: [], ocrModel: null };
  }
  const pages = splitOcrPages(scanned.text);
  return pages.length > 0
    ? { pages, ocrModel: scanned.model }
    : { pages: [], ocrModel: null };
}

/** 待 OCR 清单：只读当前账号可见范围，按上传时间倒序 */
export async function listNeedsOcrDocuments(
  context: UserContext,
  limit = 30,
): Promise<NeedsOcrDocument[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      title: string;
      status: string;
      page_count: number | null;
      department_name: string;
      folder_key: string;
      created_at: Date;
      run_goal: string | null;
    }>(
      `select d.id, d.title, d.status, d.page_count, dep.name as department_name,
              d.folder_key, d.created_at, r.goal as run_goal
         from documents d
         join departments dep on dep.id = d.department_id
         left join ingest_runs r on r.id = d.ingest_run_id
        where d.status in ('needs_ocr', 'failed') and d.deleted_at is null
        order by d.created_at desc
        limit ${safeLimit}`,
    );

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      pageCount: row.page_count,
      departmentName: row.department_name,
      folderLabel: folderLabel(row.folder_key),
      createdAt: row.created_at.toISOString(),
      runGoal: row.run_goal,
    }));
  });
}

interface DocumentRow {
  id: string;
  department_id: string;
  status: string;
  deleted_at: Date | null;
}

async function loadOcrTarget(
  client: PoolClient,
  context: UserContext,
  documentId: string,
): Promise<DocumentRow> {
  const { rows } = await client.query<DocumentRow>(
    "select id, department_id, status, deleted_at from documents where id = $1",
    [documentId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("文档不存在或无权访问");
  }
  if (row.deleted_at) {
    throw new Error("文档在 99-回收站，恢复后才能补录");
  }
  if (row.status !== "needs_ocr" && row.status !== "failed") {
    throw new Error("只有「待 OCR / 解析失败」的文档可以补录正文");
  }

  await requireContextPermission(client, context, "knowledge:write", {
    kind: "document",
    id: documentId,
    departmentId: row.department_id,
  });

  return row;
}

/**
 * 提交 OCR 正文：重建切片、更新统计与状态、写审计。
 * 两段事务：先校验，再在事务外向量化，最后回写；回写前重新校验状态。
 */
export async function submitOcrText(
  context: UserContext,
  documentId: string,
  input: { text: string },
): Promise<OcrSubmitResult> {
  const raw = (input.text ?? "").trim();
  if (raw.length === 0) {
    throw new Error("请粘贴 OCR 识别出的正文");
  }
  if (raw.length > MAX_TEXT) {
    throw new Error("正文过长（≤ 200 万字符），请分多次补录");
  }

  const pages = splitOcrPages(raw);
  const chunked = chunkPages(pages);
  if (chunked.chunks.length === 0) {
    throw new Error("正文为空，无法生成切片");
  }

  await withUserContext(context, (client) => loadOcrTarget(client, context, documentId));

  const embeddings = await embedTexts(chunked.chunks.map((chunk) => chunk.text));

  return withUserContext(context, async (client) => {
    const document = await loadOcrTarget(client, context, documentId);

    await client.query("delete from doc_chunks where document_id = $1", [documentId]);

    const payload = chunked.chunks.map((chunk, index) => ({
      ord: chunk.ord,
      page_no: chunk.pageNo,
      char_start: chunk.charStart,
      char_end: chunk.charEnd,
      text: chunk.text,
      embedding: embeddings?.[index] ? `[${embeddings[index].join(",")}]` : null,
    }));

    await client.query(
      `insert into doc_chunks
         (tenant_id, department_id, document_id, ord, page_no, char_start, char_end, text, embedding)
       select $1, $2, $3, x.ord, x.page_no, x.char_start, x.char_end, x.text,
              case when x.embedding is null then null else x.embedding::vector end
         from jsonb_to_recordset($4::jsonb)
           as x(ord int, page_no int, char_start int, char_end int, text text, embedding text)`,
      [context.tenantId, document.department_id, documentId, JSON.stringify(payload)],
    );

    await client.query(
      `update documents
          set status = 'parsed', char_count = $2, page_count = $3
        where id = $1`,
      [documentId, chunked.charCount, pages.length],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.document_ocr_completed",
      targetType: "document",
      targetId: documentId,
      departmentId: document.department_id,
      payload: {
        pages: pages.length,
        chunks: chunked.chunks.length,
        embedded: Boolean(embeddings),
        charCount: chunked.charCount,
      },
    });

    return {
      pages: pages.length,
      chunks: chunked.chunks.length,
      embedded: Boolean(embeddings),
    };
  });
}
