"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import { revokeIngestRun } from "@/lib/knowledge/ingest";
import { answerQuestion, type QaAnswer } from "@/lib/knowledge/qa";
import { toPermissionMessage } from "@/lib/permissions/guard";

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface AskResult {
  ok: boolean;
  message?: string;
  answer?: QaAnswer;
}

/** 单轮 RAG 问答：检索 → 生成 → 引用与数字校验 → 审计 */
export async function askAction(question: string): Promise<AskResult> {
  const session = await requireSession();
  const context = await resolveUserContext(session.userId);

  try {
    const answer = await answerQuestion(context, question);
    revalidatePath("/knowledge");
    return { ok: true, answer };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 撤回整个入库批次：文档置 revoked、未确认的卡片置 dropped */
export async function revokeRunAction(formData: FormData): Promise<ActionResult> {
  const runId = String(formData.get("runId") ?? "");
  if (!runId) {
    return { ok: false, message: "缺少批次标识" };
  }

  const session = await requireSession();
  const context = await resolveUserContext(session.userId);

  try {
    await revokeIngestRun(context, runId);
    revalidatePath("/knowledge");
    return { ok: true, message: "批次已撤回" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}
