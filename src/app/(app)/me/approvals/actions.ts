"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { auditInTx } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { getAdapter } from "@/lib/handover/registry";
import { requireContextPermission } from "@/lib/permissions/server";

type ActionResult = { ok: true; message: string } | { ok: false; message: string };

type Decision = "approve" | "reject" | "cancel";

function toActionMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    if (code === "42501") {
      return "无权限处理该审批单";
    }
    if (code === "P0002") {
      return "审批单不存在或已处理";
    }
    if (code === "23505") {
      return "该成员已有待审批的移出申请";
    }
    if (code === "23514") {
      return "不能移出最后一位 L1 老板账号";
    }
    if (code === "22023") {
      return "交接数据不完整，请刷新后重试";
    }
    return error.message;
  }
  return "操作失败，请稍后重试";
}

interface ApprovalInfo {
  status: string;
  subject_id: string;
  requester_id: string;
  user_id: string;
  department_id: string;
  department_name: string;
  member_name: string | null;
}

interface HandoverRow {
  asset_type: string;
  asset_id: string;
  from_user_id: string;
  to_user_id: string;
}

/**
 * 离职交接审批的唯一入口。
 * 通过：先调用资产适配器转移，再由数据库函数完成状态机；
 * 驳回 / 撤回：数据库函数直接还原任用与账号状态。
 */
async function runDecision(
  approvalId: string,
  decision: Decision,
  reason = "",
): Promise<ActionResult> {
  if (!approvalId) {
    return { ok: false, message: "审批单 ID 缺失" };
  }

  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "member:manage", {
        kind: "department",
        id: context.activeDepartmentId ?? undefined,
        departmentId: context.activeDepartmentId,
      });

      const infoResult = await client.query<ApprovalInfo>(
        `select ar.status, ar.subject_id, ar.requester_id,
                m.user_id, m.department_id,
                d.name as department_name, u.name as member_name
           from approval_requests ar
           join memberships m on m.id = ar.subject_id
           join departments d on d.id = m.department_id
           join users u on u.id = m.user_id
          where ar.id = $1
            and ar.type = 'membership_removal'
          for update of ar`,
        [approvalId],
      );
      const info = infoResult.rows[0];
      if (!info) {
        throw new Error("审批单不存在或已处理");
      }
      if (info.status !== "pending") {
        throw new Error("审批单不存在或已处理");
      }

      if (decision === "approve") {
        const items = await client.query<HandoverRow>(
          `select asset_type, asset_id, from_user_id, to_user_id
             from handover_items
            where approval_id = $1
              and transferred_at is null`,
          [approvalId],
        );
        for (const item of items.rows) {
          const adapter = getAdapter(item.asset_type);
          if (!adapter) {
            throw new Error(`未注册的资产类型：${item.asset_type}`);
          }
          await adapter.transfer(client, item.asset_id, item.from_user_id, item.to_user_id);
        }
        await client.query("select app.approve_membership_removal($1)", [approvalId]);
      } else if (decision === "reject") {
        await client.query("select app.reject_membership_removal($1, $2)", [approvalId, reason]);
      } else {
        await client.query("select app.cancel_membership_removal($1)", [approvalId]);
      }

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: info.department_id,
        action: `approval.${decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "cancelled"}`,
        targetType: "approval",
        targetId: approvalId,
        payload: {
          approvalId,
          membershipId: info.subject_id,
          memberName: info.member_name,
          departmentName: info.department_name,
          reason: decision === "reject" ? reason : null,
        },
      });
    });

    revalidatePath("/me/approvals");
    revalidatePath("/org/positions");
    revalidatePath("/", "layout");

    const message =
      decision === "approve"
        ? "已通过，成员已正式停用"
        : decision === "reject"
          ? "已驳回，成员恢复为在职"
          : "已撤回，成员恢复为在职";
    return { ok: true, message };
  } catch (error) {
    return { ok: false, message: toActionMessage(error) };
  }
}

export async function approveRemoval(approvalId: string): Promise<ActionResult> {
  return runDecision(approvalId, "approve");
}

export async function rejectRemoval(approvalId: string, reason: string): Promise<ActionResult> {
  return runDecision(approvalId, "reject", reason.trim().slice(0, 200));
}

export async function cancelRemoval(approvalId: string): Promise<ActionResult> {
  return runDecision(approvalId, "cancel");
}
