"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import {
  confirmCard,
  createManualCard,
  dropCard,
  isCardKind,
  updateCard,
} from "@/lib/knowledge/cards";
import { distillDocument } from "@/lib/knowledge/distill";
import { toPermissionMessage } from "@/lib/permissions/guard";

export interface ActionResult {
  ok: boolean;
  message: string;
}

async function contextOf() {
  const session = await requireSession();
  return resolveUserContext(session.userId);
}

export async function confirmCardAction(cardId: string): Promise<ActionResult> {
  try {
    await confirmCard(await contextOf(), cardId);
    revalidatePath("/knowledge/cards");
    return { ok: true, message: "已确认" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function dropCardAction(cardId: string): Promise<ActionResult> {
  try {
    await dropCard(await contextOf(), cardId);
    revalidatePath("/knowledge/cards");
    return { ok: true, message: "已作废" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function updateCardAction(
  cardId: string,
  title: string,
  body: string,
): Promise<ActionResult> {
  try {
    await updateCard(await contextOf(), cardId, { title, body });
    revalidatePath("/knowledge/cards");
    return { ok: true, message: "已保存，可重新确认" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function createCardAction(
  kind: string,
  title: string,
  body: string,
): Promise<ActionResult> {
  if (!isCardKind(kind)) {
    return { ok: false, message: "知识卡类型不合法" };
  }

  try {
    await createManualCard(await contextOf(), { kind, title, body });
    revalidatePath("/knowledge/cards");
    return { ok: true, message: "已创建，待确认" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function distillAction(documentId: string): Promise<ActionResult> {
  try {
    const result = await distillDocument(await contextOf(), documentId);
    revalidatePath("/knowledge/cards");
    revalidatePath("/knowledge");
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
