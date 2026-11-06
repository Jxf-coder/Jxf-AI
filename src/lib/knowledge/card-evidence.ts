/**
 * 证据链编辑：从可读文档的切片里挑原文，逐字核对后挂到知识卡上。
 *
 * 红线：
 * - 引文必须能在切片原文中逐字命中（verifyQuoteInChunk），对不上就拒绝落库；
 * - 文档 / 切片 / 卡片都经 RLS 过滤，写操作再叠加 knowledge:write；
 * - 只允许人工核对过的证据（verified = true），与确认门槛保持一致。
 */

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { verifyQuoteInChunk } from "@/lib/knowledge/evidence";
import { requireContextPermission } from "@/lib/permissions/server";

export interface EvidenceDocumentOption {
  id: string;
  title: string;
  departmentName: string;
  chunkCount: number;
}

export interface EvidenceChunkOption {
  id: string;
  ord: number;
  pageNo: number | null;
  /** 预览用：完整切片可能很长，编辑器只填空引文，最终仍由服务端逐字校验 */
  text: string;
}

export interface CardEvidenceItem {
  id: string;
  quote: string;
  locator: string | null;
  pageNo: number | null;
  verified: boolean;
  documentId: string | null;
  documentTitle: string | null;
}

export interface AddEvidenceInput {
  chunkId: string;
  quote: string;
}

const QUOTE_MAX = 600;
const CHUNK_PREVIEW_MAX = 800;
const DOCUMENT_LIMIT = 30;
const CHUNK_LIMIT = 40;

function locatorOf(pageNo: number | null, ord: number): string {
  return pageNo ? `第 ${pageNo} 页` : `切片 ${ord + 1}`;
}

/** 可选文档：当前账号可读、未删除、未撤回，且至少有一个切片 */
export async function listEvidenceDocuments(context: UserContext): Promise<EvidenceDocumentOption[]> {
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      title: string;
      department_name: string;
      chunk_count: string;
    }>(
      `select d.id, d.title, dep.name as department_name,
              (select count(*) from doc_chunks c where c.document_id = d.id)::text as chunk_count
         from documents d
         join departments dep on dep.id = d.department_id
        where d.deleted_at is null and d.status <> 'revoked'
        order by d.created_at desc
        limit ${DOCUMENT_LIMIT}`,
    );

    return rows
      .filter((row) => Number(row.chunk_count) > 0)
      .map((row) => ({
        id: row.id,
        title: row.title,
        departmentName: row.department_name,
        chunkCount: Number(row.chunk_count),
      }));
  });
}

/** 某文档的切片候选（按 ord 升序，正文截断到 800 字供选择） */
export async function listEvidenceChunks(
  context: UserContext,
  documentId: string,
): Promise<EvidenceChunkOption[]> {
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      ord: number;
      page_no: number | null;
      text: string;
    }>(
      `select c.id, c.ord, c.page_no, left(c.text, ${CHUNK_PREVIEW_MAX}) as text
         from doc_chunks c
         join documents d on d.id = c.document_id
        where c.document_id = $1 and d.deleted_at is null and d.status <> 'revoked'
        order by c.ord
        limit ${CHUNK_LIMIT}`,
      [documentId],
    );

    return rows.map((row) => ({
      id: row.id,
      ord: row.ord,
      pageNo: row.page_no,
      text: row.text,
    }));
  });
}

/**
 * 挂证据：引文在校验通过后落库（verified = true）。
 * 同一卡片 + 同一位置重复添加视为幂等更新，不产生重复行。
 */
export async function addCardEvidence(
  context: UserContext,
  cardId: string,
  input: AddEvidenceInput,
): Promise<CardEvidenceItem> {
  const quote = input.quote.trim();
  if (quote.length === 0) {
    throw new Error("请填写引文");
  }
  if (quote.length > QUOTE_MAX) {
    throw new Error(`引文过长（≤ ${QUOTE_MAX} 字），请截取关键句`);
  }

  return withUserContext(context, async (client) => {
    const card = await client.query<{ department_id: string }>(
      "select department_id from knowledge_cards where id = $1",
      [cardId],
    );
    const departmentId = card.rows[0]?.department_id;
    if (!departmentId) {
      throw new Error("知识卡不存在或无权操作");
    }

    await requireContextPermission(client, context, "knowledge:write", {
      kind: "knowledge_card",
      id: cardId,
      departmentId,
    });

    const chunk = await client.query<{
      id: string;
      document_id: string;
      ord: number;
      page_no: number | null;
      char_start: number;
      text: string;
      document_title: string;
    }>(
      `select c.id, c.document_id, c.ord, c.page_no, c.char_start, c.text, d.title as document_title
         from doc_chunks c
         join documents d on d.id = c.document_id
        where c.id = $1 and d.deleted_at is null and d.status <> 'revoked'`,
      [input.chunkId],
    );
    const source = chunk.rows[0];
    if (!source) {
      throw new Error("切片不存在或无权访问");
    }

    const match = verifyQuoteInChunk(source.text, source.char_start, quote);
    if (!match.verified || match.quote === undefined) {
      throw new Error("引文未能在切片原文中逐字命中，请回到原文复制准确句子");
    }

    const locator = locatorOf(source.page_no, source.ord);
    const saved = await client.query<{
      id: string;
      quote: string;
      locator: string | null;
      page_no: number | null;
      verified: boolean;
    }>(
      `insert into card_evidence
         (card_id, chunk_id, document_id, page_no, locator, quote, char_start, char_end, verified, verified_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, true, now())
       on conflict (card_id, document_id, char_start, char_end)
       do update set
         chunk_id = excluded.chunk_id,
         page_no = excluded.page_no,
         locator = excluded.locator,
         quote = excluded.quote,
         verified = true,
         verified_at = now()
       returning id, quote, locator, page_no, verified`,
      [
        cardId,
        source.id,
        source.document_id,
        source.page_no,
        locator,
        match.quote,
        match.charStart,
        match.charEnd,
      ],
    );
    const row = saved.rows[0];

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.evidence_added",
      targetType: "knowledge_card",
      targetId: cardId,
      departmentId,
      payload: {
        evidenceId: row.id,
        documentId: source.document_id,
        pageNo: source.page_no,
        charStart: match.charStart,
        charEnd: match.charEnd,
      },
    });

    return {
      id: row.id,
      quote: row.quote,
      locator: row.locator,
      pageNo: row.page_no,
      verified: row.verified,
      documentId: source.document_id,
      documentTitle: source.document_title,
    };
  });
}

/** 删除证据：只能删本卡所属部门可写的卡片证据 */
export async function removeCardEvidence(context: UserContext, evidenceId: string): Promise<void> {
  return withUserContext(context, async (client) => {
    const evidence = await client.query<{
      card_id: string;
      department_id: string | null;
    }>(
      `select e.card_id, k.department_id
         from card_evidence e
         join knowledge_cards k on k.id = e.card_id
        where e.id = $1`,
      [evidenceId],
    );
    const row = evidence.rows[0];
    if (!row || !row.department_id) {
      throw new Error("证据不存在或无权操作");
    }

    await requireContextPermission(client, context, "knowledge:write", {
      kind: "knowledge_card",
      id: row.card_id,
      departmentId: row.department_id,
    });

    await client.query("delete from card_evidence where id = $1", [evidenceId]);

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.evidence_removed",
      targetType: "knowledge_card",
      targetId: row.card_id,
      departmentId: row.department_id,
      payload: { evidenceId },
    });
  });
}
