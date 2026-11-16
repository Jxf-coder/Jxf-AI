/**
 * 飞书群机器人（自定义机器人）。
 *
 * 只需要 Webhook 地址；配置签名密钥时按官方规则追加 timestamp + sign。
 * 返回体 code 非 0（例如签名错误）按失败处理，不做静默降级。
 */

import { createHmac } from "node:crypto";

import { renderFeishuCard, type NotificationContent } from "./content";
import { postJson, type ChannelSendResult, type FetchLike } from "./http";

export interface FeishuTarget {
  webhook: string;
  secret: string | null;
}

/** 官方签名：key = `${timestamp}\n${secret}`，对空串做 HmacSHA256 再 base64 */
export function feishuSign(timestamp: string, secret: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

export function buildFeishuPayload(
  content: NotificationContent,
  secret: string | null,
  nowMs = Date.now(),
): Record<string, unknown> {
  const payload = renderFeishuCard(content);
  if (secret) {
    const timestamp = Math.floor(nowMs / 1000).toString();
    return { ...payload, timestamp, sign: feishuSign(timestamp, secret) };
  }
  return payload;
}

export async function sendFeishuMessage(
  target: FeishuTarget,
  content: NotificationContent,
  deps: { fetchImpl?: FetchLike } = {},
): Promise<ChannelSendResult> {
  const result = await postJson(target.webhook, buildFeishuPayload(content, target.secret), deps);
  if (!result.ok) {
    return { sent: false, skipped: false, error: result.error ?? "飞书发送失败" };
  }
  const body = result.body as { code?: unknown; msg?: unknown } | null;
  const code = typeof body?.code === "number" ? body.code : null;
  if (code !== null && code !== 0) {
    return { sent: false, skipped: false, error: `飞书返回 ${code}：${String(body?.msg ?? "")}` };
  }
  return { sent: true, skipped: false, error: null };
}
