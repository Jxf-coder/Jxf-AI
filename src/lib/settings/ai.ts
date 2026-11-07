/**
 * 设置面 · 模型配置诊断。
 *
 * 展示的是「当前进程实际生效」的配置（环境变量 + 数据库覆盖合并后的结果），
 * 与数据库中保存的原始值区分开，避免排障时误判。
 */

import { withUserContext, type UserContext } from "@/lib/db/user-context";
import { loadEnv } from "@/lib/env";
import { requireContextPermission } from "@/lib/permissions/server";

import { secretHint } from "./crypto";
import type { EffectiveAiSummary } from "./types";

export function getEffectiveAiSummary(): EffectiveAiSummary {
  const env = loadEnv();
  return {
    enabled: env.ai.enabled,
    baseUrl: env.ai.baseUrl,
    chatModel: env.ai.chatModel,
    fastModel: env.ai.fastModel,
    apiKeyHint: env.ai.apiKey ? secretHint(env.ai.apiKey) : null,
    embeddingEnabled: Boolean(env.ai.embedding.apiKey),
    ocrEnabled: env.ocr.enabled,
  };
}

export interface AiTestResult {
  ok: boolean;
  message: string;
}

/** 用当前生效配置发一次最小对话请求，验证 Base URL / Key / 模型名是否可用 */
export async function testAiConnection(context: UserContext): Promise<AiTestResult> {
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings", {
      kind: "department",
      id: context.activeDepartmentId ?? undefined,
      departmentId: context.activeDepartmentId,
    });
  });

  const ai = loadEnv().ai;
  if (!ai.apiKey) {
    return { ok: false, message: "未配置 API Key：请先保存模型密钥，或在环境变量中提供 JXF_AI_API_KEY" };
  }
  if (!ai.enabled) {
    return { ok: false, message: "AI 生成当前处于关闭状态：打开「启用 AI 生成」后再测试" };
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.chatModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    const latency = Date.now() - startedAt;

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return { ok: false, message: `连接失败：HTTP ${response.status}${detail ? ` · ${detail}` : ""}` };
    }

    const payload = (await response.json().catch(() => null)) as { model?: string } | null;
    return {
      ok: true,
      message: `连接成功：${latency}ms${payload?.model ? ` · 模型 ${payload.model}` : ""}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `连接失败：${detail}` };
  }
}
