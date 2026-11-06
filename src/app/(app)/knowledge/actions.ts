"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { patchCards, type CardMetaPatch } from "@/lib/knowledge/cards";
import { addGap, closeGap, reopenGap } from "@/lib/knowledge/gaps";
import { revokeIngestRun } from "@/lib/knowledge/ingest";
import { submitOcrText } from "@/lib/knowledge/ocr";
import { answerQuestion, type QaAnswer } from "@/lib/knowledge/qa";
import {
  emptyTrash,
  purgeCard,
  purgeDocument,
  restoreCard,
  restoreDocument,
  trashDocument,
} from "@/lib/knowledge/trash";
import {
  isUuid,
  setCardVisibility,
  setDocumentVisibility,
} from "@/lib/knowledge/workspace";
import {
  addRegressionQuestion,
  removeRegressionQuestion,
  runRegression,
  seedRegressionQuestions,
} from "@/lib/knowledge/regression";
import { toPermissionMessage } from "@/lib/permissions/guard";

export interface ActionResult {
  ok: boolean;
  message: string;
}

async function resolveCurrentContext() {
  const session = await requireSession();
  return resolveUserContext(session.userId);
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

export interface RunDetailFileView {
  id: string;
  sourcePath: string;
  decision: string;
  reason: string | null;
  error: string | null;
  documentId: string | null;
  /** 非空表示正文由视觉模型自动识别（存模型名） */
  ocrModel: string | null;
}

export interface RunDetailView {
  id: string;
  status: string;
  goal: string | null;
  counts: Record<string, number>;
  createdAt: string;
  creatorName: string | null;
  files: RunDetailFileView[];
}

export interface RunDetailResult {
  ok: boolean;
  message?: string;
  detail?: RunDetailView;
}

/** 批次详情：单文件判定明细（RLS 内按可见范围返回） */
export async function loadRunDetailAction(runId: string): Promise<RunDetailResult> {
  const session = await requireSession();
  const context = await resolveUserContext(session.userId);

  try {
    const detail = await withUserContext(context, async (client) => {
      const run = await client.query<{
        id: string;
        status: string;
        goal: string | null;
        counts: Record<string, number> | null;
        created_at: Date;
        creator_name: string | null;
      }>(
        `select r.id, r.status, r.goal, r.counts, r.created_at, u.name as creator_name
           from ingest_runs r
           left join users u on u.id = r.created_by
          where r.id = $1`,
        [runId],
      );
      const row = run.rows[0];
      if (!row) {
        return null;
      }

      const files = await client.query<{
        id: string;
        source_path: string;
        decision: string;
        reason: string | null;
        error: string | null;
        document_id: string | null;
        ocr_model: string | null;
      }>(
        `select id, source_path, decision, reason, error, document_id, ocr_model
           from ingest_files
          where run_id = $1
          order by created_at, source_path`,
        [runId],
      );

      return {
        id: row.id,
        status: row.status,
        goal: row.goal,
        counts: row.counts ?? {},
        createdAt: row.created_at.toISOString(),
        creatorName: row.creator_name,
        files: files.rows.map((file) => ({
          id: file.id,
          sourcePath: file.source_path,
          decision: file.decision,
          reason: file.reason,
          error: file.error,
          documentId: file.document_id,
          ocrModel: file.ocr_model,
        })),
      } satisfies RunDetailView;
    });

    if (!detail) {
      return { ok: false, message: "批次不存在或无权查看" };
    }
    return { ok: true, detail };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function addGapAction(question: string): Promise<ActionResult> {
  try {
    await addGap(await resolveCurrentContext(), question);
    revalidatePath("/knowledge");
    return { ok: true, message: "已记入知识缺口" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

async function setGapStatusAction(gapId: string, close: boolean): Promise<ActionResult> {
  try {
    const context = await resolveCurrentContext();
    if (close) {
      await closeGap(context, gapId);
    } else {
      await reopenGap(context, gapId);
    }
    revalidatePath("/knowledge");
    return { ok: true, message: close ? "已标记为已补" : "已重开" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function closeGapAction(gapId: string): Promise<ActionResult> {
  return setGapStatusAction(gapId, true);
}

export async function reopenGapAction(gapId: string): Promise<ActionResult> {
  return setGapStatusAction(gapId, false);
}

export async function addRegressionQuestionAction(question: string): Promise<ActionResult> {
  try {
    await addRegressionQuestion(await resolveCurrentContext(), question);
    revalidatePath("/knowledge");
    return { ok: true, message: "已加入题集" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function removeRegressionQuestionAction(questionId: string): Promise<ActionResult> {
  try {
    await removeRegressionQuestion(await resolveCurrentContext(), questionId);
    revalidatePath("/knowledge");
    return { ok: true, message: "已删除" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 条目四字段：来源 / 版本 / 负责人 / 有效期（写入 extra jsonb） */
export async function patchCardMetaAction(cardId: string, patch: CardMetaPatch): Promise<ActionResult> {
  try {
    const result = await patchCards(await resolveCurrentContext(), [cardId], patch);
    revalidatePath("/knowledge");
    if (result.failed.length > 0) {
      return { ok: false, message: result.failed[0].reason };
    }
    return { ok: true, message: "已保存" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 文档共享开关：只改 visibility，写仍限本部门 */
export async function setDocumentVisibilityAction(
  documentId: string,
  shared: boolean,
): Promise<ActionResult> {
  try {
    await setDocumentVisibility(await resolveCurrentContext(), documentId, shared);
    revalidatePath("/knowledge");
    return { ok: true, message: shared ? "已加入公司资料（共享）" : "已收回为部门内可见" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 文档移入 99-回收站（软删）：切片与原件保留，可随时恢复 */
export async function trashDocumentAction(documentId: string): Promise<ActionResult> {
  try {
    await trashDocument(await resolveCurrentContext(), documentId);
    revalidatePath("/knowledge");
    return { ok: true, message: "已移入 99-回收站，可随时恢复" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 从 99-回收站恢复：回到原岗位与原目录 */
export async function restoreDocumentAction(documentId: string): Promise<ActionResult> {
  try {
    await restoreDocument(await resolveCurrentContext(), documentId);
    revalidatePath("/knowledge");
    return { ok: true, message: "已恢复到原目录" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 作废卡恢复为待确认 */
export async function restoreCardAction(cardId: string): Promise<ActionResult> {
  try {
    await restoreCard(await resolveCurrentContext(), cardId);
    revalidatePath("/knowledge");
    return { ok: true, message: "已恢复为待确认" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 彻底删除回收站内的文档（连带原件） */
export async function purgeDocumentAction(documentId: string): Promise<ActionResult> {
  try {
    await purgeDocument(await resolveCurrentContext(), documentId);
    revalidatePath("/knowledge");
    return { ok: true, message: "已彻底删除" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 彻底删除已作废的知识卡 */
export async function purgeCardAction(cardId: string): Promise<ActionResult> {
  try {
    await purgeCard(await resolveCurrentContext(), cardId);
    revalidatePath("/knowledge");
    return { ok: true, message: "已彻底删除" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 清空某部门的回收站 */
export async function emptyTrashAction(departmentId: string): Promise<ActionResult> {
  try {
    const result = await emptyTrash(await resolveCurrentContext(), departmentId);
    revalidatePath("/knowledge");
    return {
      ok: true,
      message: `已清空：文档 ${result.documents} 份、知识卡 ${result.cards} 张`,
    };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 扫描件补录：重建切片与向量，文档转「已解析」 */
export async function submitOcrTextAction(
  documentId: string,
  text: string,
): Promise<ActionResult> {
  if (!isUuid(documentId)) {
    return { ok: false, message: "文档标识不合法" };
  }
  try {
    const result = await submitOcrText(await resolveCurrentContext(), documentId, { text });
    revalidatePath("/knowledge");
    return {
      ok: true,
      message: `已补录：${result.pages} 页 / ${result.chunks} 个切片${
        result.embedded ? "（已生成向量）" : "（向量未生成，检索走关键词）"
      }`,
    };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 知识卡共享开关：只改 visibility，写仍限本部门 */
export async function setCardVisibilityAction(
  cardId: string,
  shared: boolean,
): Promise<ActionResult> {
  try {
    await setCardVisibility(await resolveCurrentContext(), cardId, shared);
    revalidatePath("/knowledge");
    return { ok: true, message: shared ? "已加入公司资料（共享）" : "已收回为部门内可见" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}
