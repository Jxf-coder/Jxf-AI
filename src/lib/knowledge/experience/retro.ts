/**
 * 人工复盘入口：把一条复盘写进经验队列，由 worker 异步提炼成待确认卡。
 *
 * 约束：
 * - 只走手动通道（manual），绕过冷却与滑动窗口，但仍计每小时配额；
 * - 正文至少 200 字，否则无法形成可核对的经验；
 * - 目录由路由决定：普通复盘落 05，周报/月报/阶段总结落 08。
 */

import { randomUUID } from "node:crypto";

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";

import { enqueueExperience, MIN_SOURCE_CHARS } from "./capture";

export const RETRO_TITLE_MAX = 120;
export const RETRO_BODY_MAX = 12000;

export interface RetroInput {
  title: string;
  body: string;
}

export interface RetroResult {
  ok: boolean;
  message: string;
}

export async function submitRetroExperience(
  context: UserContext,
  input: RetroInput,
): Promise<RetroResult> {
  const title = input.title.trim();
  const body = input.body.trim();
  const departmentId = context.activeDepartmentId;

  if (title.length === 0) {
    return { ok: false, message: "请填写复盘标题" };
  }
  if (title.length > RETRO_TITLE_MAX) {
    return { ok: false, message: `标题不能超过 ${RETRO_TITLE_MAX} 字` };
  }
  if (body.length < MIN_SOURCE_CHARS) {
    return { ok: false, message: `复盘正文至少 ${MIN_SOURCE_CHARS} 字，才能提炼出可核对的经验` };
  }
  if (body.length > RETRO_BODY_MAX) {
    return { ok: false, message: `复盘正文不能超过 ${RETRO_BODY_MAX} 字` };
  }
  if (!departmentId) {
    return { ok: false, message: "当前账号没有有效部门上下文" };
  }

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    const result = await enqueueExperience(client, {
      tenantId: context.tenantId,
      departmentId,
      channel: "retro",
      sourceType: "manual_retro",
      sourceId: randomUUID(),
      sourceVersion: new Date().toISOString(),
      title,
      text: `复盘：${title}\n\n${body}`,
      manual: true,
      meta: { title, source: "manual_retro" },
    });

    if (!result.jobId) {
      return { ok: false, message: result.reason ?? "复盘未进入经验队列" };
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.retro_submitted",
      targetType: "experience_job",
      targetId: result.jobId,
      departmentId,
      payload: { title, merged: result.merged },
    });

    return {
      ok: true,
      message: result.merged
        ? "同类复盘已在经验队列中，已累计出现次数"
        : "复盘已进入经验队列，AI 提炼后会在待确认卡中出现",
    };
  });
}
