/**
 * M4 切片 4：逐工具审批闸门。
 *
 * 边界：
 * - 令牌 scope 命中 approvalTools 的写类工具不直接执行，先落一条待审批单；
 * - 只有 L1（platform:settings）能批准 / 驳回；批准后按令牌绑定的任用身份执行；
 * - 审批、执行与审计都留痕；离职任用审批后也无法执行（resolve 失败即拒绝）。
 */

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { resolveUserContextForMembership, withUserContext } from "@/lib/db/user-context";
import { errorMessage, log } from "@/lib/logger";
import { findTool } from "@/lib/mcp/tools";
import type { ResolvedMcpToken } from "@/lib/mcp/tokens";
import { requireContextPermission } from "@/lib/permissions/server";

export type McpApprovalStatus = "pending" | "approved" | "rejected" | "failed";

export interface McpToolApprovalView {
  id: string;
  toolName: string;
  argumentsPreview: string;
  status: McpApprovalStatus;
  userName: string | null;
  departmentName: string | null;
  tokenName: string | null;
  resultPreview: string | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
}

interface ApprovalRow {
  id: string;
  tenant_id: string;
  token_id: string;
  membership_id: string;
  department_id: string;
  user_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  status: string;
  result_preview: string | null;
  error: string | null;
  created_at: Date;
  decided_at: Date | null;
}

const MAX_ARG_BYTES = 2_000;
const MAX_RESULT_CHARS = 2_000;

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args).slice(0, 20)) {
    result[key] = /token|key|secret|password|authorization/i.test(key) ? "***" : value;
  }
  return result;
}

function toPreview(value: Record<string, unknown>): string {
  const text = JSON.stringify(value);
  return text.length > MAX_ARG_BYTES ? `${text.slice(0, MAX_ARG_BYTES)}…` : text;
}

function toView(row: {
  id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  status: string;
  result_preview: string | null;
  error: string | null;
  created_at: Date;
  decided_at: Date | null;
  user_name: string | null;
  department_name: string | null;
  token_name: string | null;
}): McpToolApprovalView {
  const status: McpApprovalStatus = (["pending", "approved", "rejected", "failed"] as const).includes(
    row.status as McpApprovalStatus,
  )
    ? (row.status as McpApprovalStatus)
    : "pending";
  return {
    id: row.id,
    toolName: row.tool_name,
    argumentsPreview: toPreview(row.arguments ?? {}),
    status,
    userName: row.user_name,
    departmentName: row.department_name,
    tokenName: row.token_name,
    resultPreview: row.result_preview,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
  };
}

/** 外部调用命中审批维：落一张待审批单，返回审批单 id */
export async function submitToolApproval(
  token: ResolvedMcpToken,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const context = token.context;
  if (!context.activeMembershipId || !context.activeDepartmentId) {
    throw new Error("令牌绑定的任用没有有效部门上下文");
  }

  return withUserContext(context, async (client) => {
    const inserted = await client.query<{ id: string }>(
      `insert into mcp_tool_approvals
         (tenant_id, token_id, membership_id, department_id, user_id, tool_name, arguments)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       returning id`,
      [
        context.tenantId,
        token.tokenId,
        context.activeMembershipId,
        context.activeDepartmentId,
        context.userId,
        toolName,
        JSON.stringify(redactArgs(args)),
      ],
    );
    const id = inserted.rows[0].id;
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "mcp.tool_pending_approval",
      targetType: "mcp_tool_approval",
      targetId: id,
      departmentId: context.activeDepartmentId,
      payload: { token_id: token.tokenId, tool: toolName },
    });
    return id;
  });
}

export async function listToolApprovals(
  context: UserContext,
  limit = 20,
): Promise<McpToolApprovalView[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings");
    const { rows } = await client.query<
      Parameters<typeof toView>[0]
    >(
      `select a.id, a.tool_name, a.arguments, a.status, a.result_preview, a.error,
              a.created_at, a.decided_at,
              u.name as user_name, d.name as department_name, t.name as token_name
         from mcp_tool_approvals a
         left join users u on u.id = a.user_id
         left join departments d on d.id = a.department_id
         left join mcp_tokens t on t.id = a.token_id
        where a.tenant_id = $1
        order by (a.status = 'pending') desc, a.created_at desc
        limit $2`,
      [context.tenantId, safeLimit],
    );
    return rows.map(toView);
  });
}

export interface ApprovalDecisionResult {
  status: "approved" | "rejected" | "failed";
  message: string;
}

/**
 * 批准 / 驳回。
 * 批准的执行身份是令牌绑定的任用，不是审批人，避免借审批扩大数据范围。
 */
export async function decideToolApproval(
  context: UserContext,
  approvalId: string,
  decision: "approve" | "reject",
): Promise<ApprovalDecisionResult> {
  const claimed = await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings");
    const { rows } = await client.query<ApprovalRow>(
      `update mcp_tool_approvals
          set decided_by = $2, decided_at = now()
        where id = $1 and tenant_id = $3 and status = 'pending' and decided_at is null
        returning id, tenant_id, token_id, membership_id, department_id, user_id,
                  tool_name, arguments, status, result_preview, error, created_at, decided_at`,
      [approvalId, context.userId, context.tenantId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error("审批单不存在或已处理");
    }
    return row;
  });

  if (decision === "reject") {
    await withUserContext(context, async (client) => {
      await client.query(
        `update mcp_tool_approvals set status = 'rejected' where id = $1 and tenant_id = $2`,
        [claimed.id, context.tenantId],
      );
      await auditInTx(client, context, {
        actorUserId: context.userId,
        action: "mcp.tool_rejected",
        targetType: "mcp_tool_approval",
        targetId: claimed.id,
        departmentId: claimed.department_id,
        payload: { tool: claimed.tool_name },
      });
    });
    return { status: "rejected", message: "已驳回，工具未执行" };
  }

  const tool = findTool(claimed.tool_name);
  if (!tool || tool.action !== "write") {
    await finishApproval(context, claimed, "failed", null, "工具不存在或不是写类工具");
    return { status: "failed", message: "工具不存在或不是写类工具，已标记失败" };
  }

  const requester = await resolveUserContextForMembership(claimed.user_id, claimed.membership_id);
  if (!requester.activeMembershipId) {
    await finishApproval(context, claimed, "failed", null, "令牌绑定的任用已失效");
    return { status: "failed", message: "令牌绑定的任用已失效，未执行" };
  }

  try {
    const result = await tool.run(claimed.arguments ?? {}, requester);
    const text = JSON.stringify(result, null, 2).slice(0, MAX_RESULT_CHARS);
    await finishApproval(context, claimed, "approved", text, null);
    return { status: "approved", message: "已批准并执行，结果已记录" };
  } catch (error) {
    const message = errorMessage(error);
    log("warn", "mcp_approval_execute_failed", { approval_id: claimed.id, error: message });
    await finishApproval(context, claimed, "failed", null, message.slice(0, 500));
    return { status: "failed", message: `审批通过但执行失败：${message}` };
  }
}

async function finishApproval(
  context: UserContext,
  approval: ApprovalRow,
  status: "approved" | "failed",
  resultPreview: string | null,
  error: string | null,
): Promise<void> {
  await withUserContext(context, async (client) => {
    await client.query(
      `update mcp_tool_approvals
          set status = $2, result_preview = $3, error = $4
        where id = $1 and tenant_id = $5`,
      [approval.id, status, resultPreview, error, context.tenantId],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: status === "approved" ? "mcp.tool_approved" : "mcp.tool_approval_failed",
      targetType: "mcp_tool_approval",
      targetId: approval.id,
      departmentId: approval.department_id,
      payload: { tool: approval.tool_name, status, error },
    });
  });
}
