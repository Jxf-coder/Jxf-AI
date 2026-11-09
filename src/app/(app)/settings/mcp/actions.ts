"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import { decideToolApproval } from "@/lib/mcp/approvals";
import {
  callMcpServerTool,
  createMcpServer,
  refreshMcpServerTools,
  setMcpServerEnabled,
  type CreateMcpServerInput,
  type McpToolSummary,
} from "@/lib/mcp/connectors";
import { checkConnectorsAsL1 } from "@/lib/mcp/health";
import { notifyHealthAlert } from "@/lib/notifications/events";
import {
  cleanupInvalidMcpTokens,
  deleteMcpToken,
  issueMcpToken,
  renewMcpToken,
  revokeMcpToken,
  type McpClientKey,
} from "@/lib/mcp/tokens";
import { toPermissionMessage } from "@/lib/permissions/guard";

export interface McpActionResult {
  ok: boolean;
  message: string;
  /** 仅签发成功时返回一次明文令牌 */
  token?: string;
}

async function contextOf() {
  const session = await requireSession();
  return resolveUserContext(session.userId);
}

export async function issueMcpTokenAction(input: {
  name: string;
  membershipId: string;
  client?: McpClientKey | null;
  skills: string[];
  pipelines: string[];
  tools: string[];
  allowWrite: boolean;
  approvalTools: string[];
  channels: string[];
  expiresAt?: string | null;
}): Promise<McpActionResult> {
  try {
    const result = await issueMcpToken(await contextOf(), input);
    revalidatePath("/settings/mcp");
    return {
      ok: true,
      message: "令牌已签发，请立即复制：明文只显示这一次",
      token: result.token,
    };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function revokeMcpTokenAction(tokenId: string): Promise<McpActionResult> {
  try {
    await revokeMcpToken(await contextOf(), tokenId);
    revalidatePath("/settings/mcp");
    return { ok: true, message: "令牌已停用" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function renewMcpTokenAction(
  tokenId: string,
  input: { expiresAt?: string | null; reactivate?: boolean },
): Promise<McpActionResult> {
  try {
    await renewMcpToken(await contextOf(), tokenId, input);
    revalidatePath("/settings/mcp");
    return { ok: true, message: input.reactivate ? "令牌已重新激活" : "有效期已更新" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function deleteMcpTokenAction(tokenId: string): Promise<McpActionResult> {
  try {
    await deleteMcpToken(await contextOf(), tokenId);
    revalidatePath("/settings/mcp");
    return { ok: true, message: "令牌已删除" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function cleanupInvalidTokensAction(): Promise<McpActionResult> {
  try {
    const count = await cleanupInvalidMcpTokens(await contextOf());
    revalidatePath("/settings/mcp");
    return { ok: true, message: count > 0 ? `已清理 ${count} 个失效令牌` : "没有需要清理的失效令牌" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export interface McpToolsActionResult extends McpActionResult {
  tools?: McpToolSummary[];
}

export async function createMcpServerAction(
  input: CreateMcpServerInput,
): Promise<McpActionResult> {
  try {
    await createMcpServer(await contextOf(), input);
    revalidatePath("/settings/mcp");
    return { ok: true, message: "连接器已创建，可点「探测工具」拉取工具列表" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function toggleMcpServerAction(
  serverId: string,
  enabled: boolean,
): Promise<McpActionResult> {
  try {
    await setMcpServerEnabled(await contextOf(), serverId, enabled);
    revalidatePath("/settings/mcp");
    return { ok: true, message: enabled ? "连接器已启用" : "连接器已停用" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function refreshMcpServerToolsAction(
  serverId: string,
): Promise<McpToolsActionResult> {
  try {
    const tools = await refreshMcpServerTools(await contextOf(), serverId);
    revalidatePath("/settings/mcp");
    return { ok: true, message: `已探测到 ${tools.length} 个工具`, tools };
  } catch (error) {
    revalidatePath("/settings/mcp");
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function decideMcpToolApprovalAction(
  approvalId: string,
  decision: "approve" | "reject",
): Promise<McpActionResult> {
  try {
    const result = await decideToolApproval(await contextOf(), approvalId, decision);
    revalidatePath("/settings/mcp");
    return { ok: result.status !== "failed", message: result.message };
  } catch (error) {
    revalidatePath("/settings/mcp");
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function callMcpServerToolAction(
  serverId: string,
  toolName: string,
  argsJson: string,
): Promise<McpActionResult> {
  try {
    let args: Record<string, unknown> = {};
    if (argsJson.trim()) {
      try {
        const parsed = JSON.parse(argsJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { ok: false, message: "参数必须是 JSON 对象" };
        }
        args = parsed as Record<string, unknown>;
      } catch {
        return { ok: false, message: "参数不是合法 JSON" };
      }
    }
    const result = await callMcpServerTool(await contextOf(), serverId, toolName, args);
    revalidatePath("/settings/mcp");
    return { ok: true, message: result.text.slice(0, 2000) };
  } catch (error) {
    revalidatePath("/settings/mcp");
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 批量心跳体检：逐个 listTools 探测，连续失败 ≥3 次的连接器会被运行时跳过 */
export async function runMcpHealthCheckAction(): Promise<McpActionResult> {
  try {
    const results = await checkConnectorsAsL1(await contextOf(), undefined, notifyHealthAlert);
    revalidatePath("/settings/mcp");
    if (results.length === 0) {
      return { ok: true, message: "没有启用的连接器需要体检" };
    }
    const unhealthy = results.filter((result) => result.status !== "healthy");
    const down = results.filter((result) => result.status === "down");
    const summary = `已体检 ${results.length} 个连接器：健康 ${
      results.length - unhealthy.length
    } · 降级 ${unhealthy.length - down.length} · 熔断 ${down.length}`;
    return { ok: unhealthy.length === 0, message: summary };
  } catch (error) {
    revalidatePath("/settings/mcp");
    return { ok: false, message: toPermissionMessage(error) };
  }
}
