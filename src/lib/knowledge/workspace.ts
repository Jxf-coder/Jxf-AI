/**
 * 知识库工作区只读查询（双栏布局用）。
 *
 * 红线：
 * - 全部在 withUserContext 的 jxf_app 连接内执行，隔离只由 RLS 决定；
 * - 只读，不写库，不改任何既有服务；
 * - 左侧目录、文档正文、图谱关系各自独立取数，互不依赖。
 */

import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export interface TreeCard {
  id: string;
  title: string;
  status: string;
  category: string;
}

export interface TreeDocument {
  id: string;
  title: string;
  status: string;
  mime: string;
  pageCount: number | null;
  charCount: number;
}

export interface TreeRun {
  id: string;
  label: string;
  createdAt: Date | null;
  documents: TreeDocument[];
}

export interface TreeDepartment {
  id: string;
  name: string;
  runs: TreeRun[];
}

export interface WorkspaceTree {
  cardGroups: Array<{ category: string; cards: TreeCard[] }>;
  departments: TreeDepartment[];
  pending: {
    needsOcr: TreeDocument[];
    failed: TreeDocument[];
    pendingCards: TreeCard[];
  };
  totals: { cards: number; documents: number; pending: number };
}

interface CardRow {
  id: string;
  title: string;
  status: string;
  category: string | null;
}

interface DocumentRow {
  id: string;
  title: string;
  status: string;
  mime: string;
  page_count: number | null;
  char_count: number;
  ingest_run_id: string | null;
  department_id: string;
  department_name: string;
  run_goal: string | null;
  run_created_at: Date | null;
}

function toCard(row: CardRow): TreeCard {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    category: (row.category ?? "").trim() || "未分类",
  };
}

function toDocument(row: DocumentRow): TreeDocument {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    mime: row.mime,
    pageCount: row.page_count,
    charCount: row.char_count,
  };
}

function sortByCategory(groups: Array<{ category: string; cards: TreeCard[] }>) {
  return groups.sort((a, b) => {
    if (a.category === "未分类") return 1;
    if (b.category === "未分类") return -1;
    return a.category.localeCompare(b.category, "zh");
  });
}

/** 左侧目录：知识卡按分类、文档按「部门 → 入库批次」、待处理按状态归集 */
export async function loadWorkspaceTree(context: UserContext): Promise<WorkspaceTree> {
  return withUserContext(context, async (client) => {
    const [cards, documents] = await Promise.all([
      client.query<CardRow>(
        `select id, title, status, category
           from knowledge_cards
          where status in ('pending', 'confirmed')
          order by coalesce(category, '未分类'), title
          limit 300`,
      ),
      client.query<DocumentRow>(
        `select d.id, d.title, d.status, d.mime, d.page_count, d.char_count,
                d.ingest_run_id, d.department_id,
                dep.name as department_name,
                r.goal as run_goal, r.created_at as run_created_at
           from documents d
           join departments dep on dep.id = d.department_id
           left join ingest_runs r on r.id = d.ingest_run_id
          order by dep.name, r.created_at desc nulls last, d.created_at desc
          limit 300`,
      ),
    ]);

    const cardBuckets = new Map<string, TreeCard[]>();
    for (const row of cards.rows) {
      const card = toCard(row);
      const bucket = cardBuckets.get(card.category) ?? [];
      bucket.push(card);
      cardBuckets.set(card.category, bucket);
    }

    const departments = new Map<string, { id: string; name: string; runs: Map<string, TreeRun> }>();
    for (const row of documents.rows) {
      const department =
        departments.get(row.department_id) ??
        { id: row.department_id, name: row.department_name, runs: new Map<string, TreeRun>() };
      departments.set(row.department_id, department);

      const runKey = row.ingest_run_id ?? "unassigned";
      const run =
        department.runs.get(runKey) ??
        {
          id: runKey,
          label: row.run_goal?.trim() || (row.ingest_run_id ? "未命名批次" : "未归批次"),
          createdAt: row.run_created_at,
          documents: [] as TreeDocument[],
        };
      run.documents.push(toDocument(row));
      department.runs.set(runKey, run);
    }

    const allDocuments = documents.rows.map(toDocument);
    const allCards = cards.rows.map(toCard);
    const pendingCards = allCards.filter((card) => card.status === "pending");
    const needsOcr = allDocuments.filter((document) => document.status === "needs_ocr");
    const failed = allDocuments.filter((document) => document.status === "failed");

    return {
      cardGroups: sortByCategory(
        Array.from(cardBuckets.entries()).map(([category, list]) => ({ category, cards: list })),
      ),
      departments: Array.from(departments.values()).map((department) => ({
        id: department.id,
        name: department.name,
        runs: Array.from(department.runs.values()),
      })),
      pending: { needsOcr, failed, pendingCards },
      totals: {
        cards: allCards.length,
        documents: allDocuments.length,
        pending: needsOcr.length + failed.length + pendingCards.length,
      },
    };
  });
}

export interface DocumentContent {
  id: string;
  title: string;
  status: string;
  mime: string;
  pageCount: number | null;
  charCount: number;
  departmentName: string;
  chunkCount: number;
  /** 切片按 ord 拼接；扫描件没有切片，返回空串 */
  text: string;
}

/** 文档正文：只读，由 doc_chunks 按 ord 拼接，原文不落库也就能编辑 */
export async function loadDocumentContent(
  context: UserContext,
  documentId: string,
): Promise<DocumentContent | null> {
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      title: string;
      status: string;
      mime: string;
      page_count: number | null;
      char_count: number;
      department_name: string;
    }>(
      `select d.id, d.title, d.status, d.mime, d.page_count, d.char_count,
              dep.name as department_name
         from documents d
         join departments dep on dep.id = d.department_id
        where d.id = $1`,
      [documentId],
    );

    const document = rows[0];
    if (!document) {
      return null;
    }

    const chunks = await client.query<{ text: string }>(
      `select text from doc_chunks where document_id = $1 order by ord`,
      [documentId],
    );

    const text = chunks.rows
      .map((chunk) => chunk.text.trim())
      .filter((chunk) => chunk.length > 0)
      .join("\n\n");

    return {
      id: document.id,
      title: document.title,
      status: document.status,
      mime: document.mime,
      pageCount: document.page_count,
      charCount: document.char_count,
      departmentName: document.department_name,
      chunkCount: chunks.rowCount ?? chunks.rows.length,
      text,
    };
  });
}

export interface CardDetail {
  id: string;
  title: string;
  body: string;
  status: string;
  category: string;
  product: string;
  departmentName: string;
  source: string;
  evidenceCount: number;
}

/** 卡片详情：编辑器初始值，同样只读 */
export async function loadCardDetail(
  context: UserContext,
  cardId: string,
): Promise<CardDetail | null> {
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      title: string;
      body: string;
      status: string;
      category: string | null;
      product: string | null;
      extra: Record<string, unknown> | null;
      department_name: string;
      evidence_count: string;
    }>(
      `select c.id, c.title, c.body, c.status, c.category, c.product, c.extra,
              dep.name as department_name,
              (select count(*) from card_evidence e where e.card_id = c.id)::text as evidence_count
         from knowledge_cards c
         join departments dep on dep.id = c.department_id
        where c.id = $1`,
      [cardId],
    );

    const card = rows[0];
    if (!card) {
      return null;
    }

    const source = typeof card.extra?.source === "string" ? card.extra.source : "";

    return {
      id: card.id,
      title: card.title,
      body: card.body,
      status: card.status,
      category: card.category ?? "",
      product: card.product ?? "",
      departmentName: card.department_name,
      source,
      evidenceCount: Number(card.evidence_count) || 0,
    };
  });
}

export interface GraphNode {
  id: string;
  kind: "card" | "document";
  label: string;
  status: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  tone: "evidence" | "unverified" | "conflict";
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totals: { cards: number; documents: number };
}

const GRAPH_CARD_LIMIT = 24;
const GRAPH_DOCUMENT_LIMIT = 24;

/** 图谱关系：卡片 ↔ 证据 ↔ 文档，外加卡片之间的冲突边 */
export async function loadKnowledgeGraph(context: UserContext): Promise<GraphData> {
  return withUserContext(context, async (client) => {
    const [cards, totals] = await Promise.all([
      client.query<{ id: string; title: string; status: string; conflict_with: string[] }>(
        `select id, title, status, conflict_with
           from knowledge_cards
          where status in ('pending', 'confirmed')
          order by (status = 'confirmed') desc, updated_at desc
          limit ${GRAPH_CARD_LIMIT}`,
      ),
      client.query<{ cards: string; documents: string }>(
        `select (select count(*) from knowledge_cards where status in ('pending', 'confirmed'))::text as cards,
                (select count(*) from documents)::text as documents`,
      ),
    ]);

    const cardIds = cards.rows.map((row) => row.id);
    const nodes = new Map<string, GraphNode>();
    for (const row of cards.rows) {
      nodes.set(row.id, { id: row.id, kind: "card", label: row.title, status: row.status });
    }

    const edges: GraphEdge[] = [];

    if (cardIds.length > 0) {
      const evidence = await client.query<{
        card_id: string;
        document_id: string;
        verified: boolean;
      }>(
        `select card_id, document_id, verified
           from card_evidence
          where card_id = any($1::uuid[]) and document_id is not null`,
        [cardIds],
      );

      const documentIds = Array.from(new Set(evidence.rows.map((row) => row.document_id)));
      if (documentIds.length > 0) {
        const documents = await client.query<{ id: string; title: string; status: string }>(
          `select id, title, status from documents where id = any($1::uuid[]) limit ${GRAPH_DOCUMENT_LIMIT}`,
          [documentIds.slice(0, GRAPH_DOCUMENT_LIMIT)],
        );
        for (const row of documents.rows) {
          nodes.set(row.id, { id: row.id, kind: "document", label: row.title, status: row.status });
        }
      }

      const seen = new Set<string>();
      for (const row of evidence.rows) {
        if (!nodes.has(row.document_id)) {
          continue;
        }
        const key = `${row.card_id}:${row.document_id}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        edges.push({
          from: row.card_id,
          to: row.document_id,
          tone: row.verified ? "evidence" : "unverified",
        });
      }

      for (const row of cards.rows) {
        for (const conflictId of row.conflict_with ?? []) {
          if (!nodes.has(conflictId)) {
            continue;
          }
          const key = `conflict:${[row.id, conflictId].sort().join(":")}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          edges.push({ from: row.id, to: conflictId, tone: "conflict" });
        }
      }
    }

    return {
      nodes: Array.from(nodes.values()),
      edges,
      totals: {
        cards: Number(totals.rows[0]?.cards) || 0,
        documents: Number(totals.rows[0]?.documents) || 0,
      },
    };
  });
}
