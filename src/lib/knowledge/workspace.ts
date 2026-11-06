/**
 * 知识库工作区只读查询（双栏布局用）。
 *
 * 红线：
 * - 全部在 withUserContext 的 jxf_app 连接内执行，隔离只由 RLS 决定；
 * - 只读（setDocumentVisibility 除外，它复用既有写权限校验）；
 * - 目录树按「共享区 / 部门 → 岗位 → 10 个标准目录」组装，空目录也常驻。
 */

import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import {
  listCardVersions,
  type CardEvidenceView,
  type CardVersionView,
} from "@/lib/knowledge/cards";
import { folderLabel, STANDARD_FOLDERS } from "@/lib/knowledge/folders";
import { setShareState } from "@/lib/knowledge/share";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export interface TreeItem {
  kind: "card" | "document";
  id: string;
  title: string;
  status: string;
}

export interface TreeFolder {
  key: string;
  label: string;
  items: TreeItem[];
}

export interface TreeRole {
  name: string;
  folders: TreeFolder[];
}

export interface TreeDepartment {
  id: string;
  name: string;
  /** 岗位层：多岗位部门才展示；单岗位部门直接走 folders */
  roles: TreeRole[];
  /** 部门直属 10 目录：单岗位部门 / 无岗位资料都落这里 */
  folders: TreeFolder[];
}

export interface WorkspaceTree {
  /** 公司资料（共享）区：10 个标准目录常驻 */
  shared: { folders: TreeFolder[]; count: number };
  departments: TreeDepartment[];
  totals: { items: number; shared: number; pending: number; truncated: boolean };
}

interface NodeRow {
  id: string;
  title: string;
  status: string;
  department_id: string;
  role_key: string | null;
  folder_key: string;
  visibility: string;
  /** 仅 documents 有：非空表示在 99-回收站 */
  deleted_at?: Date | null;
}

interface DepartmentRow {
  id: string;
  name: string;
}

interface RoleRow {
  department_id: string;
  role: string;
}

function emptyFolders(): TreeFolder[] {
  return STANDARD_FOLDERS.map((folder) => ({
    key: folder.key,
    label: folder.label,
    items: [] as TreeItem[],
  }));
}

function folderMap(): Map<string, TreeFolder> {
  return new Map(emptyFolders().map((folder) => [folder.key, folder]));
}

function roleName(value: string | null): string {
  return (value ?? "").trim();
}

function sortRoles(names: string[]): string[] {
  return names.sort((a, b) => a.localeCompare(b, "zh"));
}

function countItems(folders: Map<string, TreeFolder>): number {
  let total = 0;
  for (const folder of folders.values()) {
    total += folder.items.length;
  }
  return total;
}

function orderedFolders(folders: Map<string, TreeFolder>): TreeFolder[] {
  return STANDARD_FOLDERS.map(
    (folder) => folders.get(folder.key) ?? { key: folder.key, label: folder.label, items: [] },
  );
}

/** 左侧目录单侧最多加载的条目数；命中上限时 totals.truncated = true，由搜索兜底 */
const NODE_LIMIT = 500;

/** 左侧目录：共享区 + 部门 → 岗位 → 10 个标准目录 */
export async function loadWorkspaceTree(context: UserContext): Promise<WorkspaceTree> {
  return withUserContext(context, async (client) => {
    const [departments, roles, documents, cards] = await Promise.all([
      client.query<DepartmentRow>(`select id, name from departments order by sort_order, name`),
      client.query<RoleRow>(
        `select distinct department_id, trim(position) as role
           from memberships
          where status = 'active' and nullif(trim(position), '') is not null`,
      ),
      client.query<NodeRow>(
        `select id, title, status, department_id, role_key, folder_key, visibility, deleted_at
           from documents
          order by created_at desc
          limit ${NODE_LIMIT}`,
      ),
      client.query<NodeRow>(
        `select id, title, status, department_id, role_key, folder_key, visibility
           from knowledge_cards
          where status in ('pending', 'confirmed', 'dropped')
          order by created_at desc
          limit ${NODE_LIMIT}`,
      ),
    ]);

    const sharedFolders = folderMap();
    const deptTree = new Map<
      string,
      { name: string; roles: Map<string, Map<string, TreeFolder>>; direct: Map<string, TreeFolder> }
    >();

    function departmentEntry(departmentId: string) {
      let entry = deptTree.get(departmentId);
      if (!entry) {
        entry = {
          name: departments.rows.find((row) => row.id === departmentId)?.name ?? "未命名部门",
          roles: new Map<string, Map<string, TreeFolder>>(),
          direct: folderMap(),
        };
        deptTree.set(departmentId, entry);
      }
      return entry;
    }

    function ensureRole(departmentId: string, name: string) {
      const entry = departmentEntry(departmentId);
      let role = entry.roles.get(name);
      if (!role) {
        role = folderMap();
        entry.roles.set(name, role);
      }
      return role;
    }

    // 先把「有成员但还没有资料」的部门 / 岗位也建出来，保证结构完整
    for (const row of roles.rows) {
      if (!departments.rows.some((department) => department.id === row.department_id)) {
        continue;
      }
      ensureRole(row.department_id, roleName(row.role));
    }

    const pendingDocs: TreeItem[] = [];

    function addNode(row: NodeRow, kind: "card" | "document") {
      const item: TreeItem = { kind, id: row.id, title: row.title, status: row.status };
      const name = roleName(row.role_key);
      // 回收站：软删文档 + 已作废卡片，一律落本部门「99-回收站」，
      // 不留在原目录、岗位层或共享区
      const trashed =
        (kind === "document" && (row.deleted_at ?? null) !== null) ||
        (kind === "card" && row.status === "dropped");
      const target = trashed
        ? departmentEntry(row.department_id).direct
        : row.visibility === "shared"
          ? sharedFolders
          : name
            ? ensureRole(row.department_id, name)
            : departmentEntry(row.department_id).direct;
      const folder = trashed
        ? target.get("99-trash")
        : target.get(row.folder_key) ?? target.get(kind === "card" ? "02-cards" : "01-original");
      if (!folder) {
        return;
      }
      folder.items.push(item);
      if (!trashed && kind === "document" && (row.status === "needs_ocr" || row.status === "failed")) {
        pendingDocs.push(item);
      }
    }

    for (const row of documents.rows) {
      addNode(row, "document");
    }
    for (const row of cards.rows) {
      addNode(row, "card");
    }

    const departmentsOut: TreeDepartment[] = Array.from(deptTree.entries()).map(([id, entry]) => {
      const roleNames = sortRoles(Array.from(entry.roles.keys()));

      // 单岗位部门省略岗位层：无岗位的历史资料并入该岗位，直接展示「部门 → 10 目录」
      if (roleNames.length <= 1) {
        const merged = roleNames.length === 1 ? entry.roles.get(roleNames[0]) ?? folderMap() : folderMap();
        for (const folder of entry.direct.values()) {
          const target = merged.get(folder.key);
          if (target) {
            target.items.push(...folder.items);
          }
        }
        return { id, name: entry.name, roles: [], folders: orderedFolders(merged) };
      }

      const rolesOut: TreeRole[] = roleNames.map((name) => ({
        name,
        folders: orderedFolders(entry.roles.get(name) ?? new Map<string, TreeFolder>()),
      }));

      // 多岗位部门才可能出现「没有岗位的历史资料」，单独成组，避免混进某个真实岗位
      if (countItems(entry.direct) > 0) {
        rolesOut.push({ name: "其他资料", folders: orderedFolders(entry.direct) });
      }

      return { id, name: entry.name, roles: rolesOut, folders: [] };
    });

    const sharedFoldersOut = orderedFolders(sharedFolders);

    const sharedCount = sharedFoldersOut.reduce((sum, folder) => sum + folder.items.length, 0);
    const deptCount = departmentsOut.reduce(
      (sum, department) =>
        sum +
        department.folders.reduce((n, folder) => n + folder.items.length, 0) +
        department.roles.reduce(
          (roleSum, role) => roleSum + role.folders.reduce((n, folder) => n + folder.items.length, 0),
          0,
        ),
      0,
    );
    const pendingCards = cards.rows.filter((row) => row.status === "pending").length;

    return {
      shared: { folders: sharedFoldersOut, count: sharedCount },
      departments: departmentsOut,
      totals: {
        items: deptCount,
        shared: sharedCount,
        pending: pendingDocs.length + pendingCards,
        // 两侧都取最近 500 条：命中上限说明还有更早的条目，界面必须如实提示
        truncated: documents.rows.length >= NODE_LIMIT || cards.rows.length >= NODE_LIMIT,
      },
    };
  });
}

/** 全库标题搜索：绕开目录树单侧上限，只返回当前账号可读范围内的匹配项 */
export async function searchWorkspace(context: UserContext, query: string): Promise<TreeItem[]> {
  const keyword = query.trim().slice(0, 60);
  if (keyword.length === 0) {
    return [];
  }
  const escaped = keyword.replace(/[\\%_]/g, (char) => `\\${char}`);
  const like = `%${escaped}%`;

  return withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      title: string;
      status: string;
      kind: string;
    }>(
      `select id, title, status::text as status, 'document' as kind
         from documents
        where deleted_at is null and title ilike $1
        union all
       select id, title, status::text as status, 'card' as kind
         from knowledge_cards
        where status <> 'dropped' and title ilike $1
        order by title
        limit 50`,
      [like],
    );

    return rows.map((row) => ({
      kind: row.kind === "card" ? ("card" as const) : ("document" as const),
      id: row.id,
      title: row.title,
      status: row.status,
    }));
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
  departmentId: string;
  roleKey: string;
  folderKey: string;
  folderLabel: string;
  visibility: string;
  /** 公司共享审批状态：none / pending_approval / approved / rejected */
  shareStatus: string;
  chunkCount: number;
  /** 非空表示在 99-回收站：编辑器只允许恢复，不允许继续生成卡片 */
  deletedAt: string | null;
  /** 切片按 ord 拼接；扫描件没有切片，返回空串 */
  text: string;
  /**
   * 该文档已保存的卡片（同一文档只会有一张）。
   * 编辑器用它的 rev 作为乐观锁基线；未保存过时为 null。
   */
  sourceCard: {
    id: string;
    rev: number;
    updatedAt: string;
    updatedByName: string | null;
  } | null;
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
      department_id: string;
      role_key: string | null;
      folder_key: string;
      visibility: string;
      share_status: string;
      department_name: string;
      deleted_at: Date | null;
    }>(
      `select d.id, d.title, d.status, d.mime, d.page_count, d.char_count,
              d.department_id, d.role_key, d.folder_key, d.visibility, d.share_status, d.deleted_at,
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

    // 同一文档只会有一张来源卡（部分唯一索引保证）；读不到就是还没保存过
    const sourceCards = await client.query<{
      id: string;
      rev: number;
      updated_at: Date;
      updated_by_name: string | null;
    }>(
      `select c.id, c.rev, c.updated_at,
              (select name from users where id = c.updated_by) as updated_by_name
         from knowledge_cards c
        where c.source_document_id = $1
        limit 1`,
      [documentId],
    );
    const sourceCardRow = sourceCards.rows[0];

    return {
      id: document.id,
      title: document.title,
      status: document.status,
      mime: document.mime,
      pageCount: document.page_count,
      charCount: document.char_count,
      departmentId: document.department_id,
      departmentName: document.department_name,
      roleKey: roleName(document.role_key),
      folderKey: document.folder_key,
      folderLabel: folderLabel(document.folder_key),
      visibility: document.visibility,
      shareStatus: document.share_status,
      chunkCount: chunks.rowCount ?? chunks.rows.length,
      deletedAt: document.deleted_at ? document.deleted_at.toISOString() : null,
      text,
      sourceCard: sourceCardRow
        ? {
            id: sourceCardRow.id,
            rev: sourceCardRow.rev,
            updatedAt: sourceCardRow.updated_at.toISOString(),
            updatedByName: sourceCardRow.updated_by_name,
          }
        : null,
    };
  });
}

/** 共享开关：写仍限本部门（knowledge:write）；L1 直接通过，其余进入待审批 */
export async function setDocumentVisibility(
  context: UserContext,
  documentId: string,
  shared: boolean,
): Promise<void> {
  await setShareState(context, "document", documentId, shared);
}

export interface CardDetail {
  id: string;
  title: string;
  body: string;
  status: string;
  category: string;
  product: string;
  departmentName: string;
  roleKey: string;
  folderKey: string;
  folderLabel: string;
  source: string;
  evidenceCount: number;
  /** department | shared */
  visibility: string;
  /** 公司共享审批状态：none / pending_approval / approved / rejected */
  shareStatus: string;
  /** 当前版本：编辑器保存时作为乐观锁基线 */
  rev: number;
  updatedAt: string;
  updatedByName: string | null;
  /** 已挂证据（含未核对的历史数据，供编辑器删除或补核） */
  evidence: CardEvidenceView[];
  /** 最近若干条版本快照（含当前版本） */
  versions: CardVersionView[];
}

/** 卡片详情：编辑器初始值，同样只读 */
export async function loadCardDetail(
  context: UserContext,
  cardId: string,
): Promise<CardDetail | null> {
  const card = await withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      title: string;
      body: string;
      status: string;
      category: string | null;
      product: string | null;
      role_key: string | null;
      folder_key: string;
      extra: Record<string, unknown> | null;
      department_name: string;
      evidence_count: string;
      visibility: string;
      share_status: string;
      rev: number;
      updated_at: Date;
      updated_by_name: string | null;
    }>(
      `select c.id, c.title, c.body, c.status, c.category, c.product,
              c.role_key, c.folder_key, c.extra, c.visibility, c.share_status, c.rev, c.updated_at,
              (select name from users where id = c.updated_by) as updated_by_name,
              dep.name as department_name,
              (select count(*) from card_evidence e where e.card_id = c.id)::text as evidence_count
         from knowledge_cards c
         join departments dep on dep.id = c.department_id
        where c.id = $1`,
      [cardId],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    const source = typeof row.extra?.source === "string" ? row.extra.source : "";

    const evidenceRows = await client.query<{
      id: string;
      quote: string;
      locator: string | null;
      page_no: number | null;
      verified: boolean;
      document_id: string | null;
      document_title: string | null;
    }>(
      `select e.id, e.quote, e.locator, e.page_no, e.verified, e.document_id,
              d.title as document_title
         from card_evidence e
         left join documents d on d.id = e.document_id
        where e.card_id = $1
        order by e.verified desc, e.page_no nulls last, e.char_start, e.id`,
      [cardId],
    );

    return {
      id: row.id,
      title: row.title,
      body: row.body,
      status: row.status,
      category: row.category ?? "",
      product: row.product ?? "",
      departmentName: row.department_name,
      roleKey: roleName(row.role_key),
      folderKey: row.folder_key,
      folderLabel: folderLabel(row.folder_key),
      source,
      evidenceCount: Number(row.evidence_count) || 0,
      visibility: row.visibility,
      shareStatus: row.share_status,
      rev: row.rev,
      updatedAt: row.updated_at.toISOString(),
      updatedByName: row.updated_by_name,
      evidence: evidenceRows.rows.map((evidence) => ({
        id: evidence.id,
        quote: evidence.quote,
        locator: evidence.locator,
        pageNo: evidence.page_no,
        verified: evidence.verified,
        documentId: evidence.document_id,
        documentTitle: evidence.document_title,
      })),
    } satisfies Omit<CardDetail, "versions">;
  });

  if (!card) {
    return null;
  }

  return { ...card, versions: await listCardVersions(context, cardId, 6) };
}

/** 知识卡共享开关：写仍限本部门（knowledge:write）；L1 直接通过，其余进入待审批 */
export async function setCardVisibility(
  context: UserContext,
  cardId: string,
  shared: boolean,
): Promise<void> {
  await setShareState(context, "card", cardId, shared);
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
