/**
 * 知识卡生命周期：生成（人工 / 蒸馏 / 巡读）→ 确认 → 作废。
 *
 * 确认门槛在服务端重新校验一次（不依赖 v_confirmable_cards）：
 *   1. 仍是 pending
 *   2. 无冲突
 *   3. 未过期
 *   4. 人工编辑过 或 至少一条已核对证据
 *
 * 批量操作一律逐卡调用单卡服务，禁止写成一条 UPDATE ... WHERE id = ANY(...)。
 */

import type { PoolClient } from "pg";

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";

export type CardStatus = "pending" | "confirmed" | "dropped";
export type CardFilterStatus = CardStatus | "all";
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
  category: string | null;
  product: string | null;
  externalOk: boolean;
  rev: number;
  ingestRunId: string | null;
  extra: Record<string, unknown>;
  /** 至少一条已核对证据；用于「证据没对上」与确认预检 */
  hasVerifiedEvidence: boolean;
  evidence: CardEvidenceView[];
}

export interface CardFilters {
  status?: CardFilterStatus;
  kind?: string;
  category?: string;
  product?: string;
  q?: string;
  problems?: boolean;
  ingestRunId?: string;
  limit?: number;
}

/** 批量改字段的白名单；status / title / body 等不在其中 */
export interface CardMetaPatch {
  category?: string | null;
  product?: string | null;
  validUntil?: string | null;
  externalOk?: boolean;
  source?: string | null;
  version?: string | null;
  owner?: string | null;
}

export interface BulkResult {
  passed: string[];
  failed: Array<{ id: string; reason: string }>;
  patched: number;
}

const META_KEYS = ["source", "version", "owner"] as const;

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
  category: string | null;
  product: string | null;
  external_ok: boolean;
  rev: number;
  ingest_run_id: string | null;
  extra: Record<string, unknown> | null;
  has_verified_evidence: boolean;
  evidence: CardEvidenceView[] | null;
}

function normText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function listCards(context: UserContext, filters: CardFilters = {}): Promise<CardView[]> {
  return withUserContext(context, async (client) => {
    const where: string[] = [];
    const values: unknown[] = [];
    const bind = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (filters.status && filters.status !== "all") {
      where.push(`c.status = ${bind(filters.status)}`);
    }
    if (filters.kind) {
      where.push(`c.kind = ${bind(filters.kind)}`);
    }
    if (filters.category) {
      where.push(`coalesce(c.category, '未分类') = ${bind(filters.category)}`);
    }
    if (filters.product) {
      where.push(`c.product = ${bind(filters.product)}`);
    }
    if (filters.ingestRunId) {
      where.push(`c.ingest_run_id = ${bind(filters.ingestRunId)}`);
    }
    if (filters.q) {
      const like = `%${filters.q}%`;
      const param = bind(like);
      where.push(`(c.title ilike ${param} or c.body ilike ${param} or coalesce(c.extra->>'source', '') ilike ${param})`);
    }
    if (filters.problems) {
      where.push(`(
        c.conflict_with <> '{}'
        or (c.status = 'confirmed' and c.valid_until is not null and c.valid_until < current_date)
        or (c.status = 'pending' and c.human_edited = false
            and not exists (select 1 from card_evidence e where e.card_id = c.id and e.verified))
      )`);
    }

    const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500);
    values.push(limit);

    const { rows } = await client.query<CardRow>(
      `select c.id, c.kind, c.title, c.body, c.status, c.origin, c.human_edited,
              c.conflict_with, c.valid_until, c.department_id, d.name as department_name,
              c.confirmed_at, c.created_at, c.category, c.product, c.external_ok, c.rev,
              c.ingest_run_id, c.extra,
              exists (select 1 from card_evidence e
                       where e.card_id = c.id and e.verified and btrim(e.quote) <> '') as has_verified_evidence,
              (select coalesce(json_agg(json_build_object(
                        'id', e.id, 'quote', e.quote, 'locator', e.locator, 'pageNo', e.page_no,
                        'verified', e.verified, 'documentId', e.document_id,
                        'documentTitle', doc.title) order by e.page_no nulls last, e.char_start), '[]'::json)
                 from card_evidence e
                 left join documents doc on doc.id = e.document_id
                where e.card_id = c.id) as evidence
         from knowledge_cards c
         join departments d on d.id = c.department_id
        ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
        order by c.created_at desc
        limit $${values.length}`,
      values,
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
      category: row.category,
      product: row.product,
      externalOk: row.external_ok,
      rev: row.rev,
      ingestRunId: row.ingest_run_id,
      extra: row.extra ?? {},
      hasVerifiedEvidence: row.has_verified_evidence,
      evidence: row.evidence ?? [],
    }));
  });
}

export interface CardFacets {
  categories: Array<{ value: string; count: number }>;
  products: string[];
}

/** 筛选下拉的候选项（按当前可见范围聚合，RLS 生效） */
export async function listCardFacets(context: UserContext): Promise<CardFacets> {
  return withUserContext(context, async (client) => {
    const categories = await client.query<{ value: string; count: number }>(
      `select coalesce(category, '未分类') as value, count(*)::int as count
         from knowledge_cards
        where status <> 'dropped'
        group by 1
        order by 1`,
    );
    const products = await client.query<{ product: string }>(
      `select distinct product
         from knowledge_cards
        where status <> 'dropped' and product is not null and btrim(product) <> ''
        order by 1`,
    );
    return {
      categories: categories.rows,
      products: products.rows.map((row) => row.product),
    };
  });
}

export interface CreateCardInput {
  kind: CardKind;
  title: string;
  body: string;
  category?: string | null;
  product?: string | null;
  validUntil?: string | null;
  source?: string | null;
  version?: string | null;
  owner?: string | null;
  externalOk?: boolean;
  /** 来源文档：传入时按「同一文档只保留一张草稿」做幂等 upsert */
  sourceDocumentId?: string | null;
}

export interface CreateCardResult {
  id: string;
  /** true = 新建；false = 更新了该文档已有的待确认卡片 */
  created: boolean;
  /** 已存在且已确认时为 confirmed：此时不覆盖，返回原卡 id */
  skipped?: "confirmed";
}

/**
 * 人工建卡：作者本人写过，human_edited = true，可直接确认。
 *
 * 幂等：带 sourceDocumentId 时，同一文档反复「保存为待确认卡片」只会更新同一行
 * （部分唯一索引 knowledge_cards_source_document_unique 兜底并发）。
 * 已确认的卡不覆盖内容，避免已采纳知识被草稿悄然替换。
 */
export async function createManualCard(
  context: UserContext,
  input: CreateCardInput,
): Promise<CreateCardResult> {
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
  const sourceDocumentId = input.sourceDocumentId?.trim() || null;

  const extra: Record<string, string> = {};
  for (const key of META_KEYS) {
    const value = normText(input[key]);
    if (value) {
      extra[key] = value;
    }
  }

  return withUserContext(context, async (client) => {
    let departmentId = context.activeDepartmentId;

    if (sourceDocumentId) {
      const document = await client.query<{ department_id: string }>(
        "select department_id from documents where id = $1",
        [sourceDocumentId],
      );
      const documentDepartmentId = document.rows[0]?.department_id;
      if (!documentDepartmentId) {
        throw new Error("来源文档不存在或无权访问");
      }
      departmentId = documentDepartmentId;
    }

    if (!departmentId) {
      throw new Error("当前账号没有有效部门上下文");
    }

    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    const saved = await client.query<{ id: string; created: boolean }>(
      `insert into knowledge_cards
         (tenant_id, department_id, kind, title, body, status, origin, human_edited, rev,
          category, product, external_ok, valid_until, extra, role_key, source_document_id)
       values ($1, $2, $3, $4, $5, 'pending', 'manual', true, 1, $6, $7, $8, $9, $10::jsonb,
               coalesce((select nullif(trim(m.position), '') from memberships m
                          where m.user_id = $11 and m.department_id = $2 and m.status = 'active'
                          limit 1), null),
               $12::uuid)
       on conflict (tenant_id, source_document_id) where source_document_id is not null
       do update set
         title = excluded.title,
         body = excluded.body,
         human_edited = true,
         rev = knowledge_cards.rev + 1,
         updated_at = now(),
         status = case when knowledge_cards.status = 'dropped' then 'pending' else knowledge_cards.status end,
         extra = knowledge_cards.extra || excluded.extra
       where knowledge_cards.status <> 'confirmed'
       returning id, (xmax = 0) as created`,
      [
        context.tenantId,
        departmentId,
        input.kind,
        title,
        body,
        normText(input.category),
        normText(input.product),
        input.externalOk ?? false,
        normText(input.validUntil),
        JSON.stringify(extra),
        context.userId,
        sourceDocumentId,
      ],
    );

    const row = saved.rows[0];
    if (!row) {
      // 唯一索引命中但被 where 挡住：该文档的卡片已确认，不覆盖
      const existing = await client.query<{ id: string }>(
        "select id from knowledge_cards where tenant_id = $1 and source_document_id = $2",
        [context.tenantId, sourceDocumentId],
      );
      return { id: existing.rows[0].id, created: false, skipped: "confirmed" } satisfies CreateCardResult;
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: row.created ? "knowledge.card_created" : "knowledge.card_updated",
      targetType: "knowledge_card",
      targetId: row.id,
      departmentId,
      payload: row.created
        ? { kind: input.kind }
        : { kind: input.kind, sourceDocumentId },
    });

    return { id: row.id, created: row.created } satisfies CreateCardResult;
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
  const { rows } = await client.query<GateRow>(
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

/** 人工改写正文：置 human_edited，满足确认门槛；source 合并进 extra */
export async function updateCard(
  context: UserContext,
  cardId: string,
  input: { title: string; body: string; source?: string | null },
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

    const source = normText(input.source);
    await client.query(
      `update knowledge_cards
          set title = $2, body = $3, human_edited = true, rev = rev + 1, updated_at = now(),
              extra = case when $4::text is null then extra else extra || jsonb_build_object('source', $4::text) end
        where id = $1`,
      [cardId, title, body, source],
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

/**
 * 批量改字段：白名单（分类 / 产品 / 有效期 / 可对外 / 来源 / 版本 / 负责人）。
 * 每张卡独立 savepoint，单张失败不拖垮整批；不改 status、不置 humanEdited。
 */
export async function patchCards(
  context: UserContext,
  ids: string[],
  patch: CardMetaPatch,
): Promise<BulkResult> {
  const passed: string[] = [];
  const failed: BulkResult["failed"] = [];

  const extraPatch: Record<string, string | null> = {};
  for (const key of META_KEYS) {
    if (key in patch) {
      extraPatch[key] = normText(patch[key]);
    }
  }

  const hasColumnPatch =
    "category" in patch || "product" in patch || "validUntil" in patch || "externalOk" in patch;
  const hasExtraPatch = Object.keys(extraPatch).length > 0;

  if (!hasColumnPatch && !hasExtraPatch) {
    return { passed, failed, patched: 0 };
  }

  await withUserContext(context, async (client) => {
    for (const id of ids) {
      await client.query("savepoint card_patch");
      try {
        const { rows } = await client.query<{ department_id: string }>(
          "select department_id from knowledge_cards where id = $1",
          [id],
        );
        const departmentId = rows[0]?.department_id;
        if (!departmentId) {
          failed.push({ id, reason: "知识卡不存在" });
          await client.query("rollback to savepoint card_patch");
          continue;
        }

        await requireContextPermission(client, context, "knowledge:write", {
          kind: "knowledge_card",
          id,
          departmentId,
        });

        const sets: string[] = ["rev = rev + 1", "updated_at = now()"];
        const values: unknown[] = [id];

        if ("category" in patch) {
          values.push(normText(patch.category));
          sets.push(`category = $${values.length}`);
        }
        if ("product" in patch) {
          values.push(normText(patch.product));
          sets.push(`product = $${values.length}`);
        }
        if ("validUntil" in patch) {
          values.push(normText(patch.validUntil));
          sets.push(`valid_until = $${values.length}`);
        }
        if ("externalOk" in patch) {
          values.push(Boolean(patch.externalOk));
          sets.push(`external_ok = $${values.length}`);
        }
        if (hasExtraPatch) {
          values.push(JSON.stringify(extraPatch));
          sets.push(`extra = extra || $${values.length}::jsonb`);
        }

        await client.query(`update knowledge_cards set ${sets.join(", ")} where id = $1`, values);

        await auditInTx(client, context, {
          actorUserId: context.userId,
          action: "knowledge.card_patched",
          targetType: "knowledge_card",
          targetId: id,
          departmentId,
          payload: { fields: Object.keys(patch) },
        });

        await client.query("release savepoint card_patch");
        passed.push(id);
      } catch (error) {
        await client.query("rollback to savepoint card_patch");
        failed.push({ id, reason: error instanceof Error ? error.message : "修改失败" });
      }
    }
  });

  return { passed, failed, patched: passed.length };
}

/** 批量确认 / 作废：逐卡调用单卡服务，保留完整确认门槛 */
export async function bulkDecideCards(
  context: UserContext,
  ids: string[],
  action: "confirm" | "drop",
  patch?: CardMetaPatch,
): Promise<BulkResult> {
  const failed: BulkResult["failed"] = [];
  let patched = 0;

  if (patch && Object.keys(patch).length > 0) {
    const patchResult = await patchCards(context, ids, patch);
    patched = patchResult.patched;
    failed.push(...patchResult.failed);
  }

  const blocked = new Set(failed.map((item) => item.id));
  const passed: string[] = [];

  for (const id of ids) {
    if (blocked.has(id)) {
      continue;
    }
    try {
      if (action === "confirm") {
        await confirmCard(context, id);
      } else {
        await dropCard(context, id);
      }
      passed.push(id);
    } catch (error) {
      failed.push({ id, reason: error instanceof Error ? error.message : "操作失败" });
    }
  }

  return { passed, failed, patched };
}
