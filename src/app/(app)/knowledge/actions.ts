"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import { revokeIngestRun } from "@/lib/knowledge/ingest";
import { answerQuestion, type QaAnswer } from "@/lib/knowledge/qa";
import { runRegression, seedRegressionQuestions } from "@/lib/knowledge/regression";
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

/** 用已确认卡片标题生成回归基线题 */
export async function seedRegressionAction(): Promise<ActionResult> {
  const session = await requireSession();
  const context = await resolveUserContext(session.userId);

  try {
    const created = await seedRegressionQuestions(context);
    revalidatePath("/knowledge");
    return {
      ok: true,
      message: created > 0 ? `已生成 ${created} 道基线题` : "没有新的已确认卡可出题",
    };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 运行回归门禁：retained < 0.9 或任一道未通过即判失败 */
export async function runRegressionAction(buildTag: string): Promise<ActionResult> {
  const session = await requireSession();
  const context = await resolveUserContext(session.userId);

  try {
    const summary = await runRegression(context, buildTag.trim() || "local");
    revalidatePath("/knowledge");
    const gate = summary.passed === summary.total && summary.retained >= 0.9;
    return {
      ok: gate,
      message: `${gate ? "门禁通过" : "门禁未通过"}：${summary.passed}/${summary.total} 通过，保留率 ${(
        summary.retained * 100
      ).toFixed(2)}%`,
    };
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
