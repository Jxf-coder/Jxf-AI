/**
 * M4 MCP 工具注册表与六维 scope 判定。
 *
 * 六维：技能（skills）/ 产线（pipelines）/ 动作（tools）/ 直写（allowWrite）/
 * 审批（approvalTools）/ 客户端通道（channels）。
 *
 * 红线：
 * - 工具可见性与可调用性都由令牌 scope 决定；
 * - 工具内部仍以令牌绑定的任用身份执行，权限点与 RLS 一律照常校验；
 * - 工具不读取客户端传来的部门 / 用户参数，上下文只来自令牌。
 */

import { listAiEmployees } from "@/lib/ai-employees";
import { embedTexts } from "@/lib/ai/openai";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { loadEnv } from "@/lib/env";
import { FACT_FOLDERS } from "@/lib/knowledge/folders";
import type { PermissionKey } from "@/lib/permissions/catalog";
import { requireContextPermission } from "@/lib/permissions/server";
import { assignWork, listWorkItems } from "@/lib/work-items";

export type McpToolAction = "read" | "write";

/**
 * 工具集版本：新增工具可要求更高的令牌版本，避免存量令牌自动获得新能力。
 * 新签发令牌写入当前版本；存量 v1 需在令牌管理页显式升级。
 */
export const MCP_SCOPE_VERSION = 2;

/** 技能维：工具所属能力域 */
export type McpSkill = "knowledge" | "workitem" | "employee";

export const MCP_SKILLS: readonly McpSkill[] = ["knowledge", "workitem", "employee"];

/**
 * 令牌六维 scope。空数组一律表示「不额外限制」。
 * - skills：技能（能力域）
 * - pipelines：产线（允许派活的 AI 员工 id）
 * - tools：动作（精确工具白名单）
 * - allowWrite：直写（是否允许写类工具）
 * - approvalTools：审批（需要人工审批的写类工具，`*` = 全部写类）
 * - channels：客户端通道（允许的客户端标识）
 */
export interface McpToolScope {
  skills: McpSkill[];
  pipelines: string[];
  tools: string[];
  allowWrite: boolean;
  approvalTools: string[];
  channels: string[];
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  action: McpToolAction;
  skill: McpSkill;
  /** 需要的最低工具集版本；缺省 1（存量令牌可见） */
  minScopeVersion?: number;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, context: UserContext) => Promise<unknown>;
}

async function assertDepartmentPermission(
  context: UserContext,
  key: PermissionKey,
): Promise<void> {
  const departmentId = context.activeDepartmentId;
  if (!departmentId) {
    throw new Error("令牌绑定的任用没有有效部门上下文");
  }
  await withUserContext(context, (client) =>
    requireContextPermission(client, context, key, {
      kind: "department",
      id: departmentId,
      departmentId,
    }),
  );
}

function readString(args: Record<string, unknown>, key: string, max = 200): string {
  const value = args[key];
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, max);
}

const searchTool: McpToolDefinition = {
  name: "knowledge.search",
  title: "检索知识库",
  description: "在令牌任用可读范围内检索已确认的知识卡，返回标题、摘要与混合检索分数。",
  action: "read",
  skill: "knowledge",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "检索问题或关键词" },
      topK: { type: "integer", minimum: 1, maximum: 20, description: "返回条数，默认 5" },
    },
    required: ["query"],
  },
  async run(args, context) {
    const query = readString(args, "query", 500);
    if (query.length < 2) {
      throw new Error("query 至少 2 个字符");
    }
    const requested = Number(args.topK ?? 5);
    const topK = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 20) : 5;

    await assertDepartmentPermission(context, "knowledge:read");

    const env = loadEnv();
    const [embedding] = (await embedTexts([query])) ?? [];
    const rows = await withUserContext(context, async (client) => {
      const result = await client.query<{
        card_id: string;
        title: string;
        body: string;
        score: number;
      }>(
        `select card_id, title, body, score
           from app.hybrid_search_cards($1, $2::vector, $3, 60, $4::text[])`,
        [query, embedding ? `[${embedding.join(",")}]` : null, topK, [...FACT_FOLDERS]],
      );
      return result.rows;
    });

    return {
      query,
      count: rows.length,
      results: rows.map((row) => ({
        cardId: row.card_id,
        title: row.title,
        excerpt: row.body.slice(0, 400),
        score: Number(row.score),
      })),
    };
  },
};

const experienceSearchTool: McpToolDefinition = {
  name: "knowledge.experience.search",
  title: "检索经验",
  description:
    "检索已确认的经验卡（05-经验蒸馏，可选 08-复盘归档）。结果是历史经验，不是已核实事实，引用时需说明来源。",
  action: "read",
  skill: "knowledge",
  minScopeVersion: MCP_SCOPE_VERSION,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "检索问题或关键词" },
      topK: { type: "integer", minimum: 1, maximum: 20, description: "返回条数，默认 5" },
      includeRetro: { type: "boolean", description: "是否同时检索 08-复盘归档，默认 false" },
    },
    required: ["query"],
  },
  async run(args, context) {
    const query = readString(args, "query", 500);
    if (query.length < 2) {
      throw new Error("query 至少 2 个字符");
    }
    const requested = Number(args.topK ?? 5);
    const topK = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 20) : 5;
    const includeRetro = args.includeRetro === true;

    await assertDepartmentPermission(context, "knowledge:read");

    const env = loadEnv();
    const [embedding] = (await embedTexts([query])) ?? [];
    const folders = includeRetro ? ["05-distill", "08-retro"] : ["05-distill"];

    const results = await withUserContext(context, async (client) => {
      const hits = await client.query<{
        card_id: string;
        title: string;
        body: string;
        score: number;
      }>(
        `select card_id, title, body, score
           from app.hybrid_search_cards($1, $2::vector, $3, 60, $4::text[])`,
        [query, embedding ? `[${embedding.join(",")}]` : null, topK, folders],
      );
      if (hits.rows.length === 0) {
        return [];
      }

      const ids = hits.rows.map((row) => row.card_id);
      const meta = await client.query<{
        id: string;
        source_channel: string | null;
        source_ref: Record<string, unknown> | null;
        folder_key: string;
      }>(
        `select id, source_channel, source_ref, folder_key
           from knowledge_cards
          where id = any($1::uuid[])`,
        [ids],
      );
      const evidence = await client.query<{ card_id: string; quote: string }>(
        `select card_id, quote
           from card_evidence
          where card_id = any($1::uuid[])
            and verified
          order by page_no nulls last, char_start`,
        [ids],
      );

      const metaById = new Map(meta.rows.map((row) => [row.id, row]));
      const quotesByCard = new Map<string, string[]>();
      for (const row of evidence.rows) {
        const list = quotesByCard.get(row.card_id) ?? [];
        list.push(row.quote);
        quotesByCard.set(row.card_id, list);
      }

      return hits.rows.map((row) => {
        const info = metaById.get(row.card_id);
        return {
          cardId: row.card_id,
          title: row.title,
          body: row.body,
          score: Number(row.score),
          folder: info?.folder_key ?? null,
          source: {
            channel: info?.source_channel ?? null,
            ref: info?.source_ref ?? null,
          },
          evidence: (quotesByCard.get(row.card_id) ?? []).slice(0, 3),
        };
      });
    });

    return {
      query,
      count: results.length,
      notice: "以下是历史经验，不是已核实事实；引用时需说明来源。",
      results,
    };
  },
};

const workItemListTool: McpToolDefinition = {
  name: "workitem.list",
  title: "查看工作项",
  description: "列出令牌任用可读部门内的工作项（状态、优先级、交付物摘要）。",
  action: "read",
  skill: "workitem",
  inputSchema: {
    type: "object",
    properties: {
      aiEmployeeId: { type: "string", description: "可选：只看某个 AI 员工的工作项" },
      status: {
        type: "string",
        description: "可选：queued / running / waiting_review / done / returned / failed / cancelled",
      },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "返回条数，默认 20" },
    },
  },
  async run(args, context) {
    await assertDepartmentPermission(context, "skill:use");

    const employeeId = readString(args, "aiEmployeeId", 64) || null;
    const status = readString(args, "status", 32);
    const requested = Number(args.limit ?? 20);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 50) : 20;

    const items = await listWorkItems(context, employeeId);
    return {
      count: items.length,
      items: items
        .filter((item) => (status ? item.status === status : true))
        .slice(0, limit)
        .map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          priority: item.priority,
          aiEmployee: item.aiEmployeeName,
          assignedBy: item.assignedByName,
          deliverableExcerpt: item.deliverableText.slice(0, 300),
          reviewNote: item.reviewNote,
          dueAt: item.dueAt,
        })),
    };
  },
};

const employeeListTool: McpToolDefinition = {
  name: "employee.list",
  title: "查看 AI 员工",
  description: "列出令牌任用可见的 AI 员工（仅返回已授权的员工）。",
  action: "read",
  skill: "employee",
  inputSchema: { type: "object", properties: {} },
  async run(_args, context) {
    await assertDepartmentPermission(context, "skill:use");
    const employees = await listAiEmployees(context);
    return {
      count: employees.length,
      employees: employees.map((employee) => ({
        id: employee.id,
        name: employee.name,
        status: employee.status,
        description: employee.description,
      })),
    };
  },
};

const assignWorkTool: McpToolDefinition = {
  name: "workitem.assign",
  title: "派发工作",
  description: "给 AI 员工派发一项工作；仅 L1 与部门负责人可用，执行完成后进入验收。",
  action: "write",
  skill: "workitem",
  inputSchema: {
    type: "object",
    properties: {
      aiEmployeeId: { type: "string", description: "目标 AI 员工 id" },
      title: { type: "string", description: "工作标题，不超过 80 字" },
      brief: { type: "string", description: "工作说明：目标、背景、交付要求" },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      dueAt: { type: "string", description: "截止时间（ISO 8601），可选" },
    },
    required: ["aiEmployeeId", "title", "brief"],
  },
  async run(args, context) {
    const aiEmployeeId = readString(args, "aiEmployeeId", 64);
    const title = readString(args, "title", 80);
    const brief = readString(args, "brief", 4000);
    const priority = readString(args, "priority", 16);
    const dueAt = readString(args, "dueAt", 40);

    const result = await assignWork(context, {
      aiEmployeeId,
      title,
      brief,
      priority: (["low", "normal", "high", "urgent"] as const).find((item) => item === priority),
      dueAt: dueAt || null,
    });
    return { ...result, status: "queued" };
  },
};

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  searchTool,
  experienceSearchTool,
  workItemListTool,
  employeeListTool,
  assignWorkTool,
];

export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((tool) => tool.name);

export const MCP_WRITE_TOOLS: readonly McpToolDefinition[] = MCP_TOOLS.filter(
  (tool) => tool.action === "write",
);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,31}$/i;
const MAX_APPROVAL_TOOLS = 20;
const MAX_CHANNELS = 10;
const MAX_PIPELINES = 50;

function uniqueStrings(items: unknown[], accept: (item: string) => string | null, max: number): string[] {
  const result: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = accept(item.trim());
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
    if (result.length >= max) {
      break;
    }
  }
  return result;
}

export function normalizeScope(raw: unknown): McpToolScope {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const skills = uniqueStrings(
    Array.isArray(record.skills) ? record.skills : [],
    (item) => ((MCP_SKILLS as readonly string[]).includes(item) ? item : null),
    MCP_SKILLS.length,
  ) as McpSkill[];
  const pipelines = uniqueStrings(
    Array.isArray(record.pipelines) ? record.pipelines : [],
    (item) => (UUID_PATTERN.test(item) ? item.toLowerCase() : null),
    MAX_PIPELINES,
  );
  const tools = uniqueStrings(
    Array.isArray(record.tools) ? record.tools : [],
    (item) => (MCP_TOOL_NAMES.includes(item) ? item : null),
    MCP_TOOL_NAMES.length,
  );
  const approvalTools = uniqueStrings(
    Array.isArray(record.approvalTools) ? record.approvalTools : [],
    (item) => (item === "*" || MCP_TOOL_NAMES.includes(item) ? item : null),
    MAX_APPROVAL_TOOLS,
  );
  const channels = uniqueStrings(
    Array.isArray(record.channels) ? record.channels : [],
    (item) => (CHANNEL_PATTERN.test(item) ? item.toLowerCase() : null),
    MAX_CHANNELS,
  );
  return { skills, pipelines, tools, allowWrite: record.allowWrite === true, approvalTools, channels };
}

/** 动作 + 技能 + 直写 + 工具集版本：决定工具是否可见 / 可调用 */
export function isToolAllowed(
  tool: McpToolDefinition,
  scope: McpToolScope,
  tokenScopeVersion = 1,
): boolean {
  if ((tool.minScopeVersion ?? 1) > tokenScopeVersion) {
    return false;
  }
  if (scope.skills.length > 0 && !scope.skills.includes(tool.skill)) {
    return false;
  }
  if (scope.tools.length > 0 && !scope.tools.includes(tool.name)) {
    return false;
  }
  return tool.action === "read" || scope.allowWrite;
}

/**
 * 拒绝原因：区分「版本太旧」与「未授权」，供审计与工具列表提示。
 * 显式 tools 白名单优先于版本门槛。
 */
export function toolDenialReason(
  tool: McpToolDefinition,
  scope: McpToolScope,
  tokenScopeVersion: number,
): "scope_version_too_old" | "not_allowed" | null {
  if (scope.tools.includes(tool.name)) {
    return null;
  }
  if ((tool.minScopeVersion ?? 1) > tokenScopeVersion) {
    return "scope_version_too_old";
  }
  return isToolAllowed(tool, scope, tokenScopeVersion) ? null : "not_allowed";
}

/** 审批维：写类工具是否必须转人工审批 */
export function needsApproval(tool: McpToolDefinition, scope: McpToolScope): boolean {
  if (tool.action !== "write") {
    return false;
  }
  return scope.approvalTools.includes("*") || scope.approvalTools.includes(tool.name);
}

/** 产线维：派活目标必须在白名单内（空 = 不限） */
export function scopeViolation(
  tool: McpToolDefinition,
  args: Record<string, unknown>,
  scope: McpToolScope,
): string | null {
  if (tool.name === "workitem.assign" && scope.pipelines.length > 0) {
    const target = typeof args.aiEmployeeId === "string" ? args.aiEmployeeId.trim().toLowerCase() : "";
    if (!target || !scope.pipelines.includes(target)) {
      return "目标 AI 员工不在令牌产线白名单内";
    }
  }
  return null;
}

/** 客户端通道维：空 = 不限制；按 query client、x-mcp-client 或 User-Agent 首段识别 */
export function requestChannel(request: Request): string {
  const queryClient = new URL(request.url).searchParams.get("client")?.trim().toLowerCase() ?? "";
  if (queryClient) {
    return queryClient.slice(0, 32);
  }
  const explicit = request.headers.get("x-mcp-client")?.trim().toLowerCase() ?? "";
  if (explicit) {
    return explicit.slice(0, 32);
  }
  const userAgent = request.headers.get("user-agent") ?? "";
  const token = userAgent.split(/[\s/]/)[0]?.trim().toLowerCase() ?? "";
  return token.slice(0, 32);
}

export function channelAllowed(scope: McpToolScope, channel: string): boolean {
  return scope.channels.length === 0 || (channel.length > 0 && scope.channels.includes(channel));
}

export function visibleTools(scope: McpToolScope, tokenScopeVersion = 1): McpToolDefinition[] {
  return MCP_TOOLS.filter((tool) => isToolAllowed(tool, scope, tokenScopeVersion));
}

export function findTool(name: string): McpToolDefinition | null {
  return MCP_TOOLS.find((tool) => tool.name === name) ?? null;
}
