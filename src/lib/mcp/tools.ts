/**
 * M4 MCP 工具注册表。
 *
 * 红线：
 * - 工具可见性与可调用性都由令牌 scope 决定（tools 白名单 + allowWrite）；
 * - 工具内部仍以令牌绑定的任用身份执行，权限点与 RLS 一律照常校验；
 * - 工具不读取客户端传来的部门 / 用户参数，上下文只来自令牌。
 */

import { listAiEmployees } from "@/lib/ai-employees";
import { embedTexts } from "@/lib/ai/openai";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { loadEnv } from "@/lib/env";
import type { PermissionKey } from "@/lib/permissions/catalog";
import { requireContextPermission } from "@/lib/permissions/server";
import { assignWork, listWorkItems } from "@/lib/work-items";

export type McpToolAction = "read" | "write";

/** 令牌 scope：tools 为空表示全部可见；allowWrite 控制写类工具 */
export interface McpToolScope {
  tools: string[];
  allowWrite: boolean;
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  action: McpToolAction;
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
           from app.hybrid_search_cards($1, $2::vector, $3, 60)`,
        [query, embedding ? `[${embedding.join(",")}]` : null, topK],
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

const workItemListTool: McpToolDefinition = {
  name: "workitem.list",
  title: "查看工作项",
  description: "列出令牌任用可读部门内的工作项（状态、优先级、交付物摘要）。",
  action: "read",
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
  workItemListTool,
  employeeListTool,
  assignWorkTool,
];

export const MCP_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((tool) => tool.name);

export function normalizeScope(raw: unknown): McpToolScope {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const tools = Array.isArray(record.tools)
    ? Array.from(
        new Set(
          record.tools.filter(
            (item): item is string => typeof item === "string" && MCP_TOOL_NAMES.includes(item),
          ),
        ),
      )
    : [];
  return { tools, allowWrite: record.allowWrite === true };
}

export function isToolAllowed(tool: McpToolDefinition, scope: McpToolScope): boolean {
  if (scope.tools.length > 0 && !scope.tools.includes(tool.name)) {
    return false;
  }
  return tool.action === "read" || scope.allowWrite;
}

export function visibleTools(scope: McpToolScope): McpToolDefinition[] {
  return MCP_TOOLS.filter((tool) => isToolAllowed(tool, scope));
}

export function findTool(name: string): McpToolDefinition | null {
  return MCP_TOOLS.find((tool) => tool.name === name) ?? null;
}
