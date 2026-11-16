/**
 * 企业微信群机器人。
 *
 * 只需要 Webhook 地址（URL 上自带 key），无签名；返回体 errcode 非 0 按失败处理。
 */

import { renderWecomMarkdown, type NotificationContent } from "./content";
import { postJson, type ChannelSendResult, type FetchLike } from "./http";

export interface WecomTarget {
  webhook: string;
}

export function buildWecomPayload(content: NotificationContent): Record<string, unknown> {
  return {
    msgtype: "markdown",
    markdown: { content: renderWecomMarkdown(content) },
  };
}

export async function sendWecomMessage(
  target: WecomTarget,
  content: NotificationContent,
  deps: { fetchImpl?: FetchLike } = {},
): Promise<ChannelSendResult> {
  const result = await postJson(target.webhook, buildWecomPayload(content), deps);
  if (!result.ok) {
    return { sent: false, skipped: false, error: result.error ?? "企微发送失败" };
  }
  const body = result.body as { errcode?: unknown; errmsg?: unknown } | null;
  const errcode = typeof body?.errcode === "number" ? body.errcode : null;
  if (errcode !== null && errcode !== 0) {
    return { sent: false, skipped: false, error: `企微返回 ${errcode}：${String(body?.errmsg ?? "")}` };
  }
  return { sent: true, skipped: false, error: null };
}
