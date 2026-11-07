/**
 * M4 MCP Hub 入口（Streamable HTTP · JSON 响应）。
 *
 * - 认证：Authorization: Bearer <mcp token>；令牌绑定任用，离岗即失效；
 * - 治理：tools/list 只返回令牌 scope 内的工具，tools/call 再校验一次；
 * - 审计：每次调用（含被拒）都写 audit_events；
 * - 无状态：不维护 Mcp-Session-Id，适合无状态负载均衡。
 */

import { headers } from "next/headers";

import { auditStandalone } from "@/lib/audit";
import { log } from "@/lib/logger";
import { submitToolApproval } from "@/lib/mcp/approvals";
import {
  channelAllowed,
  findTool,
  isToolAllowed,
  needsApproval,
  requestChannel,
  scopeViolation,
  visibleTools,
} from "@/lib/mcp/tools";
import { resolveMcpToken, type ResolvedMcpToken } from "@/lib/mcp/tokens";

export const dynamic = "force-dynamic";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "jxf-ai", title: "JXF AI 工作台", version: "0.1.0" };

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string) {
  const error: JsonRpcError = { code, message };
  return { jsonrpc: "2.0" as const, id: id ?? null, error };
}

function unauthorized(): Response {
  return Response.json(
    rpcError(null, -32001, "无效或已失效的 MCP 令牌"),
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

async function authenticate(request: Request): Promise<ResolvedMcpToken | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return null;
  }
  return resolveMcpToken(match[1].trim());
}

async function auditCall(
  token: ResolvedMcpToken,
  toolName: string,
  status: "ok" | "denied" | "error",
  detail: Record<string, unknown>,
): Promise<void> {
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  await auditStandalone({
    actorUserId: token.context.userId,
    action: status === "denied" ? "mcp.tool_denied" : "mcp.tool_called",
    targetType: "mcp_tool",
    // target_id 是 uuid 列，工具名放 payload
    targetId: null,
    departmentId: token.context.activeDepartmentId,
    requestId,
    payload: { token_id: token.tokenId, tool: toolName, status, ...detail },
  });
}

async function handleMessage(
  message: JsonRpcRequest,
  token: ResolvedMcpToken,
): Promise<Record<string, unknown> | null> {
  const { method, id } = message;
  const isNotification = id === undefined || id === null;

  if (!method) {
    return isNotification ? null : rpcError(id, -32600, "缺少 method");
  }

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        "JXF AI 工作台 MCP 端点：工具可见性由令牌 scope 决定，数据范围由令牌绑定的任用决定。",
    });
  }

  // 客户端初始化完成通知：不需要响应
  if (method.startsWith("notifications/")) {
    return null;
  }

  if (method === "ping") {
    return rpcResult(id, {});
  }

  if (method === "tools/list") {
    return rpcResult(id, {
      tools: visibleTools(token.scope).map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.action === "read" },
      })),
    });
  }

  if (method === "tools/call") {
    const params = message.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const args =
      params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};

    const tool = findTool(name);
    if (!tool || !isToolAllowed(tool, token.scope)) {
      await auditCall(token, name || "(unknown)", "denied", { reason: "tool_not_allowed" });
      return rpcResult(id, {
        content: [{ type: "text", text: `工具不可用或未授权：${name || "(空)"}` }],
        isError: true,
      });
    }

    const violation = scopeViolation(tool, args, token.scope);
    if (violation) {
      await auditCall(token, tool.name, "denied", { reason: "pipeline_not_allowed" });
      return rpcResult(id, { content: [{ type: "text", text: violation }], isError: true });
    }

    if (needsApproval(tool, token.scope)) {
      const approvalId = await submitToolApproval(token, tool.name, args);
      return rpcResult(id, {
        content: [
          {
            type: "text",
            text: `已提交人工审批（单号 ${approvalId}）。审批通过后由 L1 执行，本次未执行。`,
          },
        ],
        isError: true,
      });
    }

    const startedAt = Date.now();
    try {
      const result = await tool.run(args, token.context);
      const text = JSON.stringify(result, null, 2);
      await auditCall(token, tool.name, "ok", {
        duration_ms: Date.now() - startedAt,
        result_chars: text.length,
      });
      return rpcResult(id, { content: [{ type: "text", text }], isError: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : "工具执行失败";
      await auditCall(token, tool.name, "error", {
        duration_ms: Date.now() - startedAt,
        error: message.slice(0, 300),
      });
      log("warn", "mcp_tool_failed", {
        tool: tool.name,
        token_id: token.tokenId,
        error: message,
      });
      return rpcResult(id, { content: [{ type: "text", text: message }], isError: true });
    }
  }

  return isNotification ? null : rpcError(id, -32601, `不支持的方法：${method}`);
}

export async function POST(request: Request): Promise<Response> {
  const token = await authenticate(request);
  if (!token) {
    return unauthorized();
  }

  const channel = requestChannel(request.headers);
  if (!channelAllowed(token.scope, channel)) {
    await auditStandalone({
      actorUserId: token.context.userId,
      action: "mcp.channel_denied",
      targetType: "mcp_token",
      targetId: token.tokenId,
      departmentId: token.context.activeDepartmentId,
      payload: { channel: channel || "(empty)" },
    });
    return Response.json(rpcError(null, -32003, "当前客户端通道不在令牌允许范围内"), { status: 403 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "请求体不是合法 JSON"), { status: 400 });
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  if (messages.length === 0) {
    return Response.json(rpcError(null, -32600, "空请求"), { status: 400 });
  }

  const responses: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      responses.push(rpcError(null, -32600, "请求格式不正确"));
      continue;
    }
    const response = await handleMessage(message as JsonRpcRequest, token);
    if (response) {
      responses.push(response);
    }
  }

  // 纯通知：按 Streamable HTTP 约定返回 202 且无 body
  if (responses.length === 0) {
    return new Response(null, { status: 202 });
  }

  return Response.json(Array.isArray(payload) ? responses : responses[0], {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function GET(): Promise<Response> {
  return new Response("该 MCP 端点只接受 POST（无状态 JSON 响应模式）", {
    status: 405,
    headers: { Allow: "POST" },
  });
}

export async function DELETE(): Promise<Response> {
  return new Response("无状态端点，不维护 MCP 会话", {
    status: 405,
    headers: { Allow: "POST" },
  });
}
