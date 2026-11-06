/**
 * 单轮 RAG 问答（M2-D）。
 *
 * 链路：问题 → 混合检索（confirmed 卡片）→ AI 生成（带编号引用）→ 引用与数字校验 → 问答审计。
 *
 * 红线：
 * - 只召回已确认卡片；没有命中就如实说「没查到」，并沉淀知识缺口；
 * - 答案里的编号必须落在本轮召回集合内，否则记入 invalid_cites；
 * - 答案里的数字必须能在卡片正文或证据原文中找到，否则记入 unverified_numbers；
 * - 未配置 AI 时不做生成，只返回检索结果（retrieval_only）。
 */

import { chatCompletion, embedTexts } from "@/lib/ai/openai";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { extractNumbers } from "@/lib/knowledge/evidence";
import { loadEnv } from "@/lib/env";
import { log } from "@/lib/logger";
import { requireContextPermission } from "@/lib/permissions/server";

export interface QaCitation {
  index: number;
  cardId: string;
  title: string;
  quotes: string[];
}

export interface QaAnswer {
  mode: "ai" | "retrieval_only" | "no_match";
  answer: string;
  citations: QaCitation[];
  invalidCites: number[];
  unverifiedNumbers: string[];
  gapRecorded: boolean;
}

interface RecalledCard {
  card_id: string;
  title: string;
  body: string;
  score: number;
  quotes: string[];
}

const MAX_QUESTION_LENGTH = 500;

export async function answerQuestion(context: UserContext, rawQuestion: string): Promise<QaAnswer> {
  const question = rawQuestion.trim();
  if (question.length < 2) {
    throw new Error("问题太短");
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new Error(`问题过长（≤ ${MAX_QUESTION_LENGTH} 字）`);
  }

  const departmentId = context.activeDepartmentId;
  if (!departmentId) {
    throw new Error("当前账号没有有效部门上下文");
  }

  const env = loadEnv();
  const [embedding] = (await embedTexts([question])) ?? [];

  const recalled = await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "knowledge:read", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    const { rows } = await client.query<{ card_id: string; title: string; body: string; score: number }>(
      "select card_id, title, body, score from app.hybrid_search_cards($1, $2::vector, $3, 60)",
      [question, embedding ? `[${embedding.join(",")}]` : null, env.ai.topK],
    );

    if (rows.length === 0) {
      return [] as RecalledCard[];
    }

    const evidence = await client.query<{ card_id: string; quote: string }>(
      `select card_id, quote
         from card_evidence
        where card_id = any($1::uuid[])
          and verified
        order by page_no nulls last, char_start`,
      [rows.map((row) => row.card_id)],
    );

    const quotesByCard = new Map<string, string[]>();
    for (const row of evidence.rows) {
      const list = quotesByCard.get(row.card_id) ?? [];
      list.push(row.quote);
      quotesByCard.set(row.card_id, list);
    }

    return rows.map((row) => ({
      card_id: row.card_id,
      title: row.title,
      body: row.body,
      score: Number(row.score),
      quotes: (quotesByCard.get(row.card_id) ?? []).slice(0, 2),
    }));
  });

  if (recalled.length === 0) {
    const gapRecorded = await recordMiss(context, departmentId, question, "未检索到已确认的知识卡");
    return {
      mode: "no_match",
      answer: "知识库里没有找到已确认的答案。已记录为知识缺口，可上传相关文档或补充知识卡。",
      citations: [],
      invalidCites: [],
      unverifiedNumbers: [],
      gapRecorded,
    };
  }

  const citations: QaCitation[] = recalled.map((card, index) => ({
    index: index + 1,
    cardId: card.card_id,
    title: card.title,
    quotes: card.quotes,
  }));

  const generated = env.ai.enabled
    ? await chatCompletion(
        [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserPrompt(question, recalled) },
        ],
        { temperature: 0.1, tier: "deep" },
      )
    : null;

  const contextText = recalled
    .map((card) => `${card.title}\n${card.body}\n${card.quotes.join("\n")}`)
    .join("\n");

  if (!generated) {
    const fallback = recalled
      .slice(0, 3)
      .map((card, index) => `[${index + 1}] ${card.title}：${card.body}`)
      .join("\n\n");
    await recordAnswer(context, departmentId, question, fallback, citations.slice(0, 3), [], []);
    return {
      mode: "retrieval_only",
      answer: `未启用 AI 生成，以下为检索到的已确认知识：\n\n${fallback}`,
      citations: citations.slice(0, 3),
      invalidCites: [],
      unverifiedNumbers: [],
      gapRecorded: false,
    };
  }

  const citedIndexes = new Set<number>();
  for (const match of generated.matchAll(/\[(\d+)\]/g)) {
    citedIndexes.add(Number(match[1]));
  }

  const invalidCites = [...citedIndexes].filter((index) => index < 1 || index > recalled.length).sort((left, right) => left - right);
  const validIndexes = [...citedIndexes].filter((index) => index >= 1 && index <= recalled.length).sort((left, right) => left - right);
  const citedCards = validIndexes.map((index) => citations[index - 1]);

  const contextNumbers = new Set(extractNumbers(contextText));
  const unverifiedNumbers = extractNumbers(generated).filter((value) => !contextNumbers.has(value));

  await recordAnswer(
    context,
    departmentId,
    question,
    generated,
    citedCards,
    invalidCites,
    unverifiedNumbers,
  );

  if (invalidCites.length > 0) {
    log("warn", "knowledge_qa_invalid_cites", {
      department_id: departmentId,
      invalid_cites: invalidCites,
      recalled: recalled.length,
    });
  }

  return {
    mode: "ai",
    answer: generated,
    citations: citedCards,
    invalidCites,
    unverifiedNumbers,
    gapRecorded: false,
  };
}

function buildSystemPrompt(): string {
  return [
    "你是企业内部知识库问答助手。",
    "只能依据给定的知识卡回答，不得引入外部知识，不得编造。",
    "每条结论后必须用 [编号] 标注来源编号；编号只能取给定的卡片编号。",
    "若知识卡不足以回答，直接说明「知识库中没有相关依据」，不要猜测。",
    "答案中的数字、单位、日期必须与知识卡原文完全一致。",
  ].join("\n");
}

function buildUserPrompt(question: string, recalled: RecalledCard[]): string {
  const blocks = recalled.map((card, index) => {
    const quotes = card.quotes.map((quote) => `  原文证据：${quote}`).join("\n");
    return `[${index + 1}] 标题：${card.title}\n  结论：${card.body}${quotes ? `\n${quotes}` : ""}`;
  });

  return [`问题：${question}`, "", "可用知识卡：", ...blocks].join("\n");
}

async function recordAnswer(
  context: UserContext,
  departmentId: string,
  question: string,
  answer: string,
  citations: QaCitation[],
  invalidCites: number[],
  unverifiedNumbers: string[],
): Promise<void> {
  await withUserContext(context, async (client) => {
    await client.query(
      `insert into qa_logs
         (tenant_id, department_id, question, answer, cited_card_ids, invalid_cites, unverified_numbers)
       values ($1, $2, $3, $4, $5::uuid[], $6::text[], $7::text[])`,
      [
        context.tenantId,
        departmentId,
        question,
        answer,
        citations.map((citation) => citation.cardId),
        invalidCites.map((index) => String(index)),
        unverifiedNumbers,
      ],
    );
  });

  if (invalidCites.length > 0) {
    log("warn", "knowledge_qa_invalid_cite_numbers", { invalid_cites: invalidCites });
  }
}

async function recordMiss(
  context: UserContext,
  departmentId: string,
  question: string,
  answer: string,
): Promise<boolean> {
  return withUserContext(context, async (client) => {
    const gap = await client.query<{ id: string }>(
      `insert into knowledge_gaps (tenant_id, department_id, question, status, source)
       values ($1, $2, $3, 'open', 'qa_miss')
       returning id`,
      [context.tenantId, departmentId, question],
    );

    await client.query(
      `insert into qa_logs
         (tenant_id, department_id, question, answer, cited_card_ids, invalid_cites, unverified_numbers, gap_id)
       values ($1, $2, $3, $4, '{}'::uuid[], '{}'::uuid[], '{}'::text[], $5)`,
      [context.tenantId, departmentId, question, answer, gap.rows[0].id],
    );

    return true;
  });
}

export interface QaLogView {
  id: string;
  question: string;
  answer: string;
  citedCards: Array<{ id: string; title: string }>;
  invalidCites: string[];
  unverifiedNumbers: string[];
  gapId: string | null;
  createdAt: Date;
}

/** 问答来源（只读）：引用卡片 + 越界引用 + 未核实数字 */
export async function listQaLogs(context: UserContext, limit = 50): Promise<QaLogView[]> {
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      question: string;
      answer: string;
      invalid_cites: string[];
      unverified_numbers: string[];
      gap_id: string | null;
      created_at: Date;
      cited: Array<{ id: string; title: string }> | null;
    }>(
      `select q.id, q.question, q.answer, q.invalid_cites, q.unverified_numbers, q.gap_id, q.created_at,
              (select coalesce(json_agg(json_build_object('id', c.id, 'title', c.title) order by c.title), '[]'::json)
                 from knowledge_cards c
                where c.id = any(q.cited_card_ids)) as cited
         from qa_logs q
        order by q.created_at desc
        limit $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );

    return rows.map((row) => ({
      id: row.id,
      question: row.question,
      answer: row.answer,
      citedCards: row.cited ?? [],
      invalidCites: row.invalid_cites,
      unverifiedNumbers: row.unverified_numbers,
      gapId: row.gap_id,
      createdAt: row.created_at,
    }));
  });
}
