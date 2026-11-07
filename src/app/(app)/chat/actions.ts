"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import { isUuid } from "@/lib/knowledge/workspace";
import { toPermissionMessage } from "@/lib/permissions/guard";
import {
  addThreadToKnowledge,
  archiveThread,
  renameThread,
  setThreadPinned,
} from "@/lib/runtime/threads";

export interface ThreadActionResult {
  ok: boolean;
  message: string;
}

async function resolveCurrentContext() {
  const session = await requireSession();
  return resolveUserContext(session.userId);
}

export async function renameThreadAction(
  threadId: string,
  title: string,
): Promise<ThreadActionResult> {
  if (!isUuid(threadId)) {
    return { ok: false, message: "会话标识不合法" };
  }
  try {
    const updated = await renameThread(await resolveCurrentContext(), threadId, title);
    revalidatePath("/chat");
    return { ok: true, message: `已重命名为「${updated.title}」` };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function pinThreadAction(
  threadId: string,
  pinned: boolean,
): Promise<ThreadActionResult> {
  if (!isUuid(threadId)) {
    return { ok: false, message: "会话标识不合法" };
  }
  try {
    await setThreadPinned(await resolveCurrentContext(), threadId, pinned);
    revalidatePath("/chat");
    return { ok: true, message: pinned ? "已固定" : "已取消固定" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function deleteThreadAction(threadId: string): Promise<ThreadActionResult> {
  if (!isUuid(threadId)) {
    return { ok: false, message: "会话标识不合法" };
  }
  try {
    await archiveThread(await resolveCurrentContext(), threadId);
    revalidatePath("/chat");
    return { ok: true, message: "会话已删除" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function addThreadToKnowledgeAction(threadId: string): Promise<ThreadActionResult> {
  if (!isUuid(threadId)) {
    return { ok: false, message: "会话标识不合法" };
  }
  try {
    const result = await addThreadToKnowledge(await resolveCurrentContext(), threadId);
    revalidatePath("/chat");
    revalidatePath("/knowledge");
    return {
      ok: true,
      message: result.created ? "已添加到知识库，状态为待确认" : "已更新知识库中的会话卡片",
    };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}
