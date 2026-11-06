"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import {
  bulkDecideCards,
  CardConflictError,
  confirmCard,
  createManualCard,
  dropCard,
  isCardKind,
  patchCards,
  updateCard,
  type BulkResult,
  type CardConflictInfo,
  type CardMetaPatch,
} from "@/lib/knowledge/cards";
import { distillDocument } from "@/lib/knowledge/distill";
import { isUuid } from "@/lib/knowledge/workspace";
import { toPermissionMessage } from "@/lib/permissions/guard";

export interface ActionResult {
  ok: boolean;
  message: string;
  /** 乐观锁冲突：返回库中最新版本，供编辑器选择载入或确认覆盖 */
  conflict?: CardConflictInfo;
  /** 保存成功后的版本号 */
  rev?: number;
}

/** 把冲突错误转换成可展示结果；其余错误沿用权限提示 */
function failure(error: unknown): ActionResult {
  if (error instanceof CardConflictError) {
    return {
      ok: false,
      message: "保存被拦截：这张卡在你编辑期间已被他人修改",
      conflict: error.current,
    };
  }
  return { ok: false, message: toPermissionMessage(error) };
}

function isExpectedRev(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export interface BulkActionResult extends BulkResult {
  ok: boolean;
  message: string;
}

async function contextOf() {
  const session = await requireSession();
  return resolveUserContext(session.userId);
}

function revalidateKnowledge() {
  revalidatePath("/knowledge");
  revalidatePath("/knowledge/cards");
}

/** 批量改字段白名单：只接受这 7 个键，其余一律丢弃 */
function sanitizePatch(input: CardMetaPatch | undefined): CardMetaPatch {
  if (!input) {
    return {};
  }
  const patch: CardMetaPatch = {};
  if ("category" in input) patch.category = input.category;
  if ("product" in input) patch.product = input.product;
  if ("validUntil" in input) patch.validUntil = input.validUntil;
  if ("externalOk" in input) patch.externalOk = input.externalOk;
  if ("source" in input) patch.source = input.source;
  if ("version" in input) patch.version = input.version;
  if ("owner" in input) patch.owner = input.owner;
  return patch;
}

function sanitizeIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0))).slice(0, 500);
}

export async function confirmCardAction(cardId: string): Promise<ActionResult> {
  try {
    await confirmCard(await contextOf(), cardId);
    revalidateKnowledge();
    return { ok: true, message: "已确认" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function dropCardAction(cardId: string): Promise<ActionResult> {
  try {
    await dropCard(await contextOf(), cardId);
    revalidateKnowledge();
    return { ok: true, message: "已作废" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function updateCardAction(
  cardId: string,
  title: string,
  body: string,
  source?: string,
  expectedRev?: number,
): Promise<ActionResult> {
  try {
    const result = await updateCard(await contextOf(), cardId, { title, body, source }, {
      expectedRev: isExpectedRev(expectedRev) ? expectedRev : undefined,
    });
    revalidateKnowledge();
    return { ok: true, message: `已保存（v${result.rev}），可重新确认`, rev: result.rev };
  } catch (error) {
    return failure(error);
  }
}

export async function createCardAction(
  kind: string,
  title: string,
  body: string,
  meta?: CardMetaPatch,
  sourceDocumentId?: string,
  expectedRev?: number,
): Promise<ActionResult> {
  if (!isCardKind(kind)) {
    return { ok: false, message: "知识卡类型不合法" };
  }
  if (sourceDocumentId !== undefined && !isUuid(sourceDocumentId)) {
    return { ok: false, message: "来源文档标识不合法" };
  }

  const patch = sanitizePatch(meta);

  try {
    const result = await createManualCard(await contextOf(), {
      kind,
      title,
      body,
      category: patch.category,
      product: patch.product,
      validUntil: patch.validUntil,
      externalOk: patch.externalOk,
      source: patch.source,
      version: patch.version,
      owner: patch.owner,
      sourceDocumentId,
      expectedRev: isExpectedRev(expectedRev) ? expectedRev : undefined,
    });
    revalidateKnowledge();
    if (result.skipped === "confirmed") {
      return {
        ok: true,
        message: "该文档的卡片已确认，未重复创建；如需修改请在知识卡页直接编辑",
        rev: result.rev,
      };
    }
    return {
      ok: true,
      message: result.created ? "已创建，待确认（v1）" : `已更新该文档的待确认卡片（v${result.rev}）`,
      rev: result.rev,
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * 批量决策：patch = 只改字段；confirm / drop = 逐卡调用单卡服务（保留确认门槛）。
 */
export async function bulkDecideAction(
  ids: string[],
  action: "confirm" | "drop" | "patch",
  meta?: CardMetaPatch,
): Promise<BulkActionResult> {
  const list = sanitizeIds(ids);
  if (list.length === 0) {
    return { ok: false, message: "请先选择知识卡", passed: [], failed: [], patched: 0 };
  }

  const patch = sanitizePatch(meta);

  try {
    const context = await contextOf();
    const result =
      action === "patch"
        ? await patchCards(context, list, patch)
        : await bulkDecideCards(context, list, action, Object.keys(patch).length > 0 ? patch : undefined);

    revalidateKnowledge();

    const verb = action === "confirm" ? "确认" : action === "drop" ? "作废" : "修改";
    const failedText =
      result.failed.length > 0
        ? `；${result.failed.length} 张未通过：${result.failed
            .slice(0, 3)
            .map((item) => item.reason)
            .join("；")}`
        : "";

    return {
      ok: result.failed.length === 0,
      message: `${verb} ${result.passed.length} 张${result.patched > 0 ? `，改字段 ${result.patched} 张` : ""}${failedText}`,
      passed: result.passed,
      failed: result.failed,
      patched: result.patched,
    };
  } catch (error) {
    return {
      ok: false,
      message: toPermissionMessage(error),
      passed: [],
      failed: [],
      patched: 0,
    };
  }
}

export async function distillAction(documentId: string): Promise<ActionResult> {
  try {
    const result = await distillDocument(await contextOf(), documentId);
    revalidateKnowledge();
    if (result.reason) {
      return { ok: false, message: result.reason };
    }
    return {
      ok: true,
      message: `生成 ${result.created} 张待确认卡，丢弃 ${result.rejected} 条无证据结论${
        result.conflicts > 0 ? `，${result.conflicts} 张标记冲突` : ""
      }`,
    };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}
