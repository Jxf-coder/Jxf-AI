"use server";

import { revalidatePath } from "next/cache";

import {
  createAiEmployee,
  grantAiEmployeeToDepartment,
  grantAiEmployeeToUser,
  revokeAiEmployeeGrant,
  setAiEmployeeStatus,
  updateAiEmployee,
} from "@/lib/ai-employees";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import { toPermissionMessage } from "@/lib/permissions/guard";
import { assignWork, rerunWorkItem, reviewWorkItem, type WorkPriority } from "@/lib/work-items";

export interface ActionResult {
  ok: boolean;
  message: string;
  /** 新建成功时返回 id，供页面跳转到详情 */
  id?: string;
}

async function contextOf() {
  const session = await requireSession();
  return resolveUserContext(session.userId);
}

function revalidateAiEmployees() {
  revalidatePath("/ai-employees");
}

export async function createAiEmployeeAction(input: {
  slug: string;
  name: string;
  description?: string;
  skillKeys?: string[];
}): Promise<ActionResult> {
  try {
    const result = await createAiEmployee(await contextOf(), input);
    revalidateAiEmployees();
    return { ok: true, message: "已创建草稿，接下来给部门或成员授权", id: result.id };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function updateAiEmployeeAction(
  aiEmployeeId: string,
  input: {
    name: string;
    description?: string;
    persona?: string;
    systemPrompt?: string;
    skillKeys?: string[];
    allowedTools?: string[];
    modelTier?: "deep" | "fast";
    reviewMode?: "manual" | "auto";
    autoMinChars?: number;
  },
): Promise<ActionResult> {
  try {
    await updateAiEmployee(await contextOf(), aiEmployeeId, input);
    revalidateAiEmployees();
    return { ok: true, message: "已保存" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function setAiEmployeeStatusAction(
  aiEmployeeId: string,
  status: "draft" | "active" | "disabled",
): Promise<ActionResult> {
  try {
    await setAiEmployeeStatus(await contextOf(), aiEmployeeId, status);
    revalidateAiEmployees();
    const label = status === "active" ? "已上线" : status === "disabled" ? "已停用" : "已回到草稿";
    return { ok: true, message: label };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function grantDepartmentAction(
  aiEmployeeId: string,
  departmentId: string,
): Promise<ActionResult> {
  try {
    await grantAiEmployeeToDepartment(await contextOf(), aiEmployeeId, departmentId);
    revalidateAiEmployees();
    return { ok: true, message: "已授权该部门（含其子部门）" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function grantUserAction(
  aiEmployeeId: string,
  userId: string,
): Promise<ActionResult> {
  try {
    await grantAiEmployeeToUser(await contextOf(), aiEmployeeId, userId);
    revalidateAiEmployees();
    return { ok: true, message: "已授权该成员" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function revokeGrantAction(grantId: string): Promise<ActionResult> {
  try {
    await revokeAiEmployeeGrant(await contextOf(), grantId);
    revalidateAiEmployees();
    return { ok: true, message: "已撤回授权" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export interface AssignWorkActionResult extends ActionResult {
  workItemId?: string;
  runId?: string;
}

/** 派活：仅 L1 / 部门负责人；成功后会生成一个 kind='task' 的执行 */
export async function assignWorkAction(input: {
  aiEmployeeId: string;
  title: string;
  brief: string;
  priority?: WorkPriority;
  dueAt?: string | null;
}): Promise<AssignWorkActionResult> {
  try {
    const result = await assignWork(await contextOf(), input);
    revalidateAiEmployees();
    return {
      ok: true,
      message: "已派发，AI 员工开始执行",
      workItemId: result.workItemId,
      runId: result.runId,
    };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 人工验收：通过 → 已完成；退回 → 保留交付物待重做 */
export async function reviewWorkAction(
  workItemId: string,
  decision: "approve" | "return",
  note?: string,
): Promise<ActionResult> {
  try {
    await reviewWorkItem(await contextOf(), workItemId, decision, note);
    revalidateAiEmployees();
    return { ok: true, message: decision === "approve" ? "已验收通过" : "已退回" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 重跑：退回 / 失败 / 取消的工作项重新排队 */
export async function rerunWorkAction(workItemId: string): Promise<ActionResult> {
  try {
    await rerunWorkItem(await contextOf(), workItemId);
    revalidateAiEmployees();
    return { ok: true, message: "已重新排队，等待执行" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}
