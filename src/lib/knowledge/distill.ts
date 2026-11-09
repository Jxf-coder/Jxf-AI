/**
 * 蒸馏：从一份文档的切片里生成待确认知识卡。
 *
 * 红线：
 * - 没有 AI 就明确拒绝，不伪造卡片；
 * - 每条证据引文必须能在切片原文里逐字找到（verifyQuoteInChunk），找不到的证据直接丢弃；
 * - 一条证据都没有的候选卡不入库（否则永远过不了确认门槛）；
 * - 与同部门既有卡「同一件事但数字不同」时标记冲突，冲突卡不可确认；
 * - 目录由路由决定（05 经验 / 04 案例 / 03 规范…），低置信度标记 route_pending；
 * - 蒸馏多卡不写 source_document_id，改用 source_ref.documentId + dedupe_key。
 */

import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { chatCompletion } from "@/lib/ai/openai";
import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { distillDedupeKey } from "@/lib/knowledge/experience/dedupe";
import { routeFolder } from "@/lib/knowledge/experience/routing";
import { normalizeForMatch, numbersDiffer, titleKey, verifyQuoteInChunk } from "@/lib/knowledge/evidence";
import { errorMessage, log } from "@/lib/logger";
import { requireContextPermission } from "@/lib/permissions/server";

const CARD_KINDS = new Set(["object", "decision", "preference", "fact", "faq", "case", "viewpoint"]);

const MAX_CHUNKS = 30;
const MAX_PROMPT_CHARS = 12_000;

interface ChunkRow {
  id: string;
  ord: number;
  page_no: number | null;
  char_start: number;
  text: string;
}

interface DistillCandidate {
  kind?: string;
  title?: string;
  body?: string;
  evidence?: Array<{ ord?: number; quote?: string }>;
}

interface EvidenceRow {
  chunkId: string;
  pageNo: number | null;
  quote: string;
  charStart: number;
  charEnd: number;
  sourceHash: string;
  quoteHash: string;
}

export interface DistillResult {
  created: number;
  rejected: number;
  conflicts: number;
  reason?: string;
}

const SYSTEM_PROMPT = [
  "你是企业知识库整理助手。",
  "从给定文档切片中抽取可复用、可核对的业务知识，输出 JSON，不要输出任何解释或代码块标记。",
  "输出格式：{\"cards\":[{\"kind\":\"fact|decision|preference|object|faq|case|viewpoint\",\"title\":\"不超过 30 字\",\"body\":\"一条完整、可独立阅读的结论，不要照抄整段\",\"evidence\":[{\"ord\":切片序号,\"quote\":\"原文中连续的一段文字，必须逐字出现\"}]}]}。",
  "要求：每张卡至少一条证据引文；引文必须来自对应切片的原文，不得改写、不得补全；宁缺毋滥，没有可靠结论就返回空数组。",
].join("\n");

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function distillDocument(context: UserContext, documentId: string): Promise<DistillResult> {
  const loaded = await withUserContext(context, async (client) => {
    const document = await client.query<{
      id: string;
      title: string;
      department_id: string;
      folder_key: string;
      ingest_run_id: string | null;
      status: string;
    }>(
      "select id, title, department_id, folder_key, ingest_run_id, status from documents where id = $1",
      [documentId],
    );

    const row = document.rows[0];
    if (!row || row.status !== "parsed") {
      return null;
    }

    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: row.department_id,
      departmentId: row.department_id,
    });

    const chunks = await client.query<ChunkRow>(
      `select id, ord, page_no, char_start, text
         from doc_chunks
        where document_id = $1
        order by ord
        limit $2`,
      [documentId, MAX_CHUNKS],
    );

    return { document: row, chunks: chunks.rows };
  });

  if (!loaded) {
    return { created: 0, rejected: 0, conflicts: 0, reason: "文档不存在或不是已解析状态" };
  }
  if (loaded.chunks.length === 0) {
    return { created: 0, rejected: 0, conflicts: 0, reason: "该文档没有可用切片" };
  }

  const prompt = buildPrompt(loaded.document.title, loaded.chunks);
  const answer = await chatCompletion(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    { temperature: 0.1, tier: "fast" },
  );

  if (!answer) {
    return { created: 0, rejected: 0, conflicts: 0, reason: "AI 未启用或调用失败，未生成卡片" };
  }

  const candidates = parseCandidates(answer);
  if (candidates.length === 0) {
    return { created: 0, rejected: 0, conflicts: 0, reason: "模型没有给出可用结论" };
  }

  const result = await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: loaded.document.department_id,
      departmentId: loaded.document.department_id,
    });

    const existingKeys = await loadExistingCardKeys(client, loaded.document.department_id);

    let created = 0;
    let rejected = 0;
    let conflicts = 0;

    const insertCard = async (input: {
      kind: string;
      title: string;
      body: string;
      conflictIds: string[];
      folderKey: string;
      routeReason: string;
      routeConfidence: number;
      suggestedFolder: string | null;
      routePending: boolean;
      dedupeKey: string;
    }): Promise<string> => {
      const card = await client.query<{ id: string }>(
        `insert into knowledge_cards
           (tenant_id, department_id, kind, title, body, status, origin, human_edited,
            conflict_with, ingest_run_id, rev, role_key,
            folder_key, source_channel, source_ref, route_reason, route_confidence,
            suggested_folder, route_pending, dedupe_key)
         values ($1, $2, $3, $4, $5, 'pending', 'distill', false, $6::uuid[], $7, 1,
                 (select role_key from documents where id = $8::uuid),
                 $9, 'document', $10::jsonb, $11, $12, $13, $14, $15)
         returning id`,
        [
          context.tenantId,
          loaded.document.department_id,
          input.kind,
          input.title,
          input.body,
          input.conflictIds,
          loaded.document.ingest_run_id,
          loaded.document.id,
          input.folderKey,
          JSON.stringify({ documentId: loaded.document.id }),
          input.routeReason,
          input.routeConfidence,
          input.suggestedFolder,
          input.routePending,
          input.dedupeKey,
        ],
      );
      return card.rows[0].id;
    };

    for (const candidate of candidates) {
      const kind = candidate.kind && CARD_KINDS.has(candidate.kind) ? candidate.kind : null;
      const title = (candidate.title ?? "").trim();
      const body = (candidate.body ?? "").trim();
      if (!kind || title.length === 0 || body.length === 0) {
        rejected += 1;
        continue;
      }

      const evidenceRows: EvidenceRow[] = [];

      for (const evidence of candidate.evidence ?? []) {
        const quote = (evidence.quote ?? "").trim();
        if (!quote) {
          continue;
        }
        const pool = evidence.ord ? loaded.chunks.filter((chunk) => chunk.ord === evidence.ord) : loaded.chunks;
        for (const chunk of pool.length > 0 ? pool : loaded.chunks) {
          const match = verifyQuoteInChunk(chunk.text, chunk.char_start, quote);
          if (match.verified && match.quote && match.charStart !== undefined && match.charEnd !== undefined) {
            evidenceRows.push({
              chunkId: chunk.id,
              pageNo: chunk.page_no,
              quote: match.quote,
              charStart: match.charStart,
              charEnd: match.charEnd,
              sourceHash: hashOf(chunk.text),
              quoteHash: hashOf(normalizeForMatch(match.quote)),
            });
            break;
          }
        }
      }

      if (evidenceRows.length === 0) {
        rejected += 1;
        continue;
      }

      const key = titleKey(title);
      const conflictIds = existingKeys
        .filter((existing) => existing.key === key && numbersDiffer(body, existing.body))
        .map((existing) => existing.id);
      if (conflictIds.length > 0) {
        conflicts += 1;
      }

      const route = routeFolder({
        channel: "document",
        kind,
        title,
        body,
        sourceFolder: loaded.document.folder_key,
      });
      const dedupeKey = distillDedupeKey(loaded.document.id, title, body);

      // 同一去重键串行化：并发蒸馏不会撞唯一索引，也不会各写一张
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [dedupeKey]);
      const existing = await client.query<{ id: string; status: string }>(
        `select id, status::text as status
           from knowledge_cards
          where tenant_id = $1 and dedupe_key = $2
          for update`,
        [context.tenantId, dedupeKey],
      );
      const existingRow = existing.rows[0];

      if (existingRow?.status === "confirmed") {
        // 已确认的卡不被草稿覆盖
        rejected += 1;
        continue;
      }

      let cardId: string;
      let isNew = false;

      if (existingRow?.status === "pending") {
        const updated = await client.query<{ id: string }>(
          `update knowledge_cards
              set kind = $2, title = $3, body = $4, folder_key = $5,
                  source_channel = 'document', source_ref = $6::jsonb,
                  route_reason = $7, route_confidence = $8, suggested_folder = $9,
                  route_pending = $10, conflict_with = $11::uuid[],
                  rev = rev + 1, updated_at = now(), updated_by = $12
            where id = $1
            returning id`,
          [
            existingRow.id,
            kind,
            title,
            body,
            route.folderKey,
            JSON.stringify({ documentId: loaded.document.id }),
            route.reason,
            route.confidence,
            route.suggestedFolder,
            route.pending,
            conflictIds,
            context.userId,
          ],
        );
        cardId = updated.rows[0].id;
      } else {
        if (existingRow) {
          // 已作废：释放去重键后按新卡插入，不复用已作废记录
          await client.query("update knowledge_cards set dedupe_key = null where id = $1", [existingRow.id]);
        }
        cardId = await insertCard({
          kind,
          title,
          body,
          conflictIds,
          folderKey: route.folderKey,
          routeReason: route.reason,
          routeConfidence: route.confidence,
          suggestedFolder: route.suggestedFolder,
          routePending: route.pending,
          dedupeKey,
        });
        isNew = true;
      }

      for (const evidence of evidenceRows) {
        await client.query(
          `insert into card_evidence
             (card_id, chunk_id, document_id, page_no, locator, quote, char_start, char_end,
              source_kind, source_ref, source_hash, quote_hash, verified, verified_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'chunk', $9::jsonb, $10, $11, true, now())
           on conflict do nothing`,
          [
            cardId,
            evidence.chunkId,
            loaded.document.id,
            evidence.pageNo,
            evidence.pageNo ? `第 ${evidence.pageNo} 页` : null,
            evidence.quote,
            evidence.charStart,
            evidence.charEnd,
            JSON.stringify({ documentId: loaded.document.id, chunkId: evidence.chunkId }),
            evidence.sourceHash,
            evidence.quoteHash,
          ],
        );
      }

      if (isNew) {
        existingKeys.push({ id: cardId, key, body });
      }
      created += 1;
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.cards_distilled",
      targetType: "document",
      targetId: loaded.document.id,
      departmentId: loaded.document.department_id,
      payload: { created, rejected, conflicts },
    });

    return { created, rejected, conflicts };
  }).catch((error) => {
    log("warn", "knowledge_distill_failed", {
      document_id: documentId,
      error: errorMessage(error),
    });
    throw error;
  });

  return result;
}

function buildPrompt(title: string, chunks: ChunkRow[]): string {
  const lines: string[] = [`文档标题：${title}`, ""];
  let used = 0;
  for (const chunk of chunks) {
    const piece = `【切片 ${chunk.ord}${chunk.page_no ? ` · 第 ${chunk.page_no} 页` : ""}】\n${chunk.text}`;
    if (used + piece.length > MAX_PROMPT_CHARS) {
      break;
    }
    used += piece.length;
    lines.push(piece, "");
  }
  return lines.join("\n");
}

function parseCandidates(answer: string): DistillCandidate[] {
  const cleaned = answer
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as { cards?: DistillCandidate[] } | DistillCandidate[];
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return Array.isArray(parsed.cards) ? parsed.cards : [];
  } catch (error) {
    log("warn", "knowledge_distill_parse_failed", { error: errorMessage(error) });
    return [];
  }
}

async function loadExistingCardKeys(
  client: PoolClient,
  departmentId: string,
): Promise<Array<{ id: string; key: string; body: string }>> {
  const { rows } = await client.query<{ id: string; title: string; body: string }>(
    `select id, title, body
       from knowledge_cards
      where department_id = $1 and status in ('pending', 'confirmed')
      order by created_at desc
      limit 500`,
    [departmentId],
  );
  return rows.map((row) => ({ id: row.id, key: titleKey(row.title), body: row.body }));
}
