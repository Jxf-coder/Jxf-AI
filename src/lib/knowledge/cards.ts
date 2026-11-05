/**
 * 知识卡生命周期：生成（人工）→ 确认 → 作废。
 *
 * 确认门槛在服务端重新校验一次（不依赖 v_confirmable_cards）：
 *   1. 仍是 pending
 *   2. 无冲突
 *   3. 未过期
 *   4. 人工编辑过 或 至少一条已核对证据
 */

import type { PoolClient } from "pg";

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";

export type CardStatus = "pending" | "confirmed" | "dropped";
export type CardKind = "object" | "decision" | "preference" | "fact" | "faq" | "case" | "viewpoint";

export interface CardEvidenceView {
  id: string;
  quote: string;
  locator: string | null;
  pageNo: number | null;
  verified: boolean;
  documentId: string | null;
  documentTitle: string | null;
}

export interface CardView {
  id: string;
  kind: CardKind;
  title: string;
  body: string;
  status: CardStatus;
  origin: string;
  humanEdited: boolean;
  conflictWith: string[];
  validUntil: string | null;
  departmentId: string;
  departmentName: string;
  confirmedAt: Date | null;
  createdAt: Date;
  evidence: CardEvidenceView[];
}

const CARD_KINDS: readonly CardKind[] = [
  "object",
  "decision",
  "preference",
  "fact",
  "faq",
  "case",
  "viewpoint",
];

export function isCardKind(value: string): value is CardKind {
  return (CARD_KINDS as readonly string[]).includes(value);
}

interface CardRow {
  id: string;
  kind: CardKind;
  title: string;
  body: string;
  status: CardStatus;
  origin: string;
  human_edited: boolean;
  conflict_with: string[];
  valid_until: string | null;
  department_id: string;
  department_name: string;
  confirmed_at: Date | null;
  created_at: Date;
  evidence: CardEvidenceView[] | null;
}

export async function listCards(context: UserContext, status: CardStatus, limit = 100): Promise<CardView[]> {
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<CardRow>(
      `select c.id, c.kind, c.title, c.body, c.status, c.origin, c.human_edited,
              c.conflict_with, c.valid_until, c.department_id, d.name as department_name,
              c.confirmed_at, c.created_at,
              (select coalesce(json_agg(json_build_object(
                        'id', e.id, 'quote', e.quote, 'locator', e.locator, 'pageNo', e.page_no,
                        'verified', e.verified, 'documentId', e.document_id,
                        'documentTitle', doc.title) order by e.page_no nulls last, e.char_start), '[]'::json)
                 from card_evidence e
                 left join documents doc on doc.id = e.document_id
                where e.card_id = c.id) as evidence
         from knowledge_cards c
         join departments d on d.id = c.department_id
        where c.status = $1
        order by c.created_at desc
        limit $2`,
      [status, limit],
    );

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      status: row.status,
      origin: row.origin,
      humanEdited: row.human_edited,
      conflictWith: row.conflict_with ?? [],
      validUntil: row.valid_until,
      departmentId: row.department_id,
      departmentName: row.department_name,
      confirmedAt: row.confirmed_at,
      createdAt: row.created_at,
      evidence: row.evidence ?? [],
    }));
  });
}

export interface CreateCardInput {
  kind: CardKind;
  title: string;
  body: string;
}

/** 人工建卡：作者本人写过，human_edited = true，可直接确认 */
export async function createManualCard(context: UserContext, input: CreateCardInput): Promise<string> {
  const departmentId = context.activeDepartmentId;
  if (!departmentId) {
    throw new Error("当前账号没有有效部门上下文");
  }

  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length === 0 || body.length === 0) {
    throw new Error("标题与正文不能为空");
  }
  if (title.length > 120) {
    throw new Error("标题过长（≤ 120 字）");
  }
  if (body.length > 4000) {
    throw new Error("正文过长（≤ 4000 字）");
  }

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    const card = await client.query<{ id: string }>(
      `insert into knowledge_cards
         (tenant_id, department_id, kind, title, body, status, origin, human_edited, rev)
       values ($1, $2, $3, $4, $5, 'pending', 'manual', true, 1)
       returning id`,
      [context.tenantId, departmentId, input.kind, title, body],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.card_created",
      targetType: "knowledge_card",
      targetId: card.rows[0].id,
      departmentId,
      payload: { kind: input.kind },
    });

    return card.rows[0].id;
  });
}

interface GateRow {
  id: string;
  status: CardStatus;
  department_id: string;
  conflict_with: string[];
  valid_until: string | null;
  human_edited: boolean;
  verified_evidence: string;
}

export interface CardGate {
  ok: boolean;
  reason?: string;
}

/** 确认门槛：只读检查，供 UI 预检与确认动作复用 */
export async function checkConfirmable(client: PoolClient, cardId: string): Promise<CardGate> {
  const { rows } = await client.query(
    `select c.id, c.status, c.department_id, c.conflict_with, c.valid_until, c.human_edited,
            (select count(*) from card_evidence e
              where e.card_id = c.id and e.verified and btrim(e.quote) <> '')::text as verified_evidence
       from knowledge_cards c
      where c.id = $1`,
    [cardId],
  );

  const row = rows[0];
  if (!row) {
    return { ok: false, reason: "知识卡不存在" };
  }
  if (row.status !== "pending") {
    return { ok: false, reason: "只有待确认的知识卡可以确认" };
  }
  if ((row.conflict_with ?? []).length > 0) {
    return { ok: false, reason: "存在冲突卡，需先处理冲突" };
  }
  if (row.valid_until) {
    const today = new Date().toISOString().slice(0, 10);
    if (row.valid_until < today) {
      return { ok: false, reason: "知识卡已过期" };
    }
  }
  if (!row.human_edited && Number(row.verified_evidence) === 0) {
    return { ok: false, reason: "缺少已核对证据，需人工编辑或补充证据" };
  }
  return { ok: true };
}

export async function confirmCard(context: UserContext, cardId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    const { rows } = await client.query<{ department_id: string }>(
      "select department_id from knowledge_cards where id = $1",
      [cardId],
    );
    const departmentId = rows[0]?.department_id;
    if (!departmentId) {
      throw new Error("知识卡不存在");
    }

    await requireContextPermission(client, context, "knowledge:confirm", {
      kind: "knowledge_card",
      id: cardId,
      departmentId,
    });

    const gate = await checkConfirmable(client, cardId);
    if (!gate.ok) {
      throw new Error(gate.reason ?? "知识卡不满足确认条件");
    }

    await client.query(
      `update knowledge_cards
          set status = 'confirmed', confirmed_by = $2, confirmed_at = now(), rev = rev + 1
        where id = $1`,
      [cardId, context.userId],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.card_confirmed",
      targetType: "knowledge_card",
      targetId: cardId,
      departmentId,
    });
  });
}

export async function dropCard(context: UserContext, cardId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    const { rows } = await client.query<{ department_id: string }>(
      "select department_id from knowledge_cards where id = $1",
      [cardId],
    );
    const departmentId = rows[0]?.department_id;
    if (!departmentId) {
      throw new Error("知识卡不存在");
    }

    await requireContextPermission(client, context, "knowledge:write", {
      kind: "knowledge_card",
      id: cardId,
      departmentId,
    });

    await client.query(
      `update knowledge_cards set status = 'dropped', rev = rev + 1
        where id = $1 and status in ('pending', 'confirmed')`,
      [cardId],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.card_dropped",
      targetType: "knowledge_card",
      targetId: cardId,
      departmentId,
    });
  });
}

/** 人工改写正文：置 human_edited，满足确认门槛 */
export async function updateCard(
  context: UserContext,
  cardId: string,
  input: { title: string; body: string },
): Promise<void> {
  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length === 0 || body.length === 0) {
    throw new Error("标题与正文不能为空");
  }

  await withUserContext(context, async (client) => {
    const { rows } = await client.query<{ department_id: string }>(
      "select department_id from knowledge_cards where id = $1",
      [cardId],
    );
    const departmentId = rows[0]?.department_id;
    if (!departmentId) {
      throw new Error("知识卡不存在");
    }

    await requireContextPermission(client, context, "knowledge:write", {
      kind: "knowledge_card",
      id: cardId,
      departmentId,
    });

    await client.query(
      `update knowledge_cards
          set title = $2, body = $3, human_edited = true, rev = rev + 1, updated_at = now()
        where id = $1`,
      [cardId, title, body],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.card_updated",
      targetType: "knowledge_card",
      targetId: cardId,
      departmentId,
    });
  });
}
