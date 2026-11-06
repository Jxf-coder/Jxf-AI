/**
 * AI 出口：OpenAI 标准兼容格式（官方 / 硅基流动 / DeepSeek / 自建网关均可）。
 *
 * 红线：无 Key 或调用失败一律返回 null，由调用方降级（检索退化为 pg_bigm 纯关键词，
 * 问答直接拒绝生成）。禁止在这里抛错打断入库。
 *
 * 容灾：瞬时故障（503 / 429 / 5xx / 超时 / 连接重置）按指数避让重试；
 * 主节点重试耗尽后自动切备用节点（JXF_AI_FALLBACK_*），仍失败才安静降级。
 */

import { loadEnv } from "@/lib/env";
import { errorMessage, log } from "@/lib/logger";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiStatus {
  chatEnabled: boolean;
  embeddingEnabled: boolean;
  /** 深度推理模型（问答） */
  chatModel: string;
  /** 高频轻量模型（巡读抽取 / 蒸馏） */
  fastModel: string;
  embeddingModel: string;
}

export function aiStatus(): AiStatus {
  const ai = loadEnv().ai;
  return {
    chatEnabled: ai.enabled,
    embeddingEnabled: ai.embedding.apiKey !== "",
    chatModel: ai.chatModel,
    fastModel: ai.fastModel,
    embeddingModel: ai.embedding.model,
  };
}

const EMBEDDING_BATCH = 32;

/** 可重试的 HTTP 状态：服务繁忙 / 限流 / 网关抖动 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 统一的调用错误：status = null 表示网络层失败（超时 / 连接重置） */
class AiRequestError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "AiRequestError";
    this.status = status;
    this.retryable = status === null || RETRYABLE_STATUS.has(status);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, apiKey: string, body: unknown, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // AbortSignal.timeout 抛 TimeoutError，断连抛 TypeError（ECONNRESET / ENOTFOUND）
    throw new AiRequestError(errorMessage(error), null);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new AiRequestError(`AI HTTP ${response.status}: ${detail.slice(0, 300)}`, response.status);
  }

  return response.json();
}

/**
 * 带指数避让的 POST：仅对瞬时故障重试，4xx（Key 失效 / 参数错误）立即失败交给上层处理。
 * 退避序列 base、2×base、4×base…，避免同一时刻重试打穿上游。
 */
async function postJsonResilient(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  provider: string,
): Promise<unknown> {
  const { retryAttempts, retryBaseMs } = loadEnv().ai;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await postJson(url, apiKey, body, timeoutMs);
    } catch (error) {
      const failure =
        error instanceof AiRequestError ? error : new AiRequestError(errorMessage(error), null);
      if (!failure.retryable || attempt >= retryAttempts) {
        throw failure;
      }
      const delayMs = retryBaseMs * 2 ** attempt;
      log("warn", "ai_retry", {
        provider,
        attempt: attempt + 1,
        max_attempts: retryAttempts,
        status: failure.status,
        delay_ms: delayMs,
        error: failure.message,
      });
      await sleep(delayMs);
    }
  }
}

/**
 * 批量向量化。返回 null 表示未配置或调用失败，调用方应把 embedding 留空。
 * 只做重试不做跨节点切换：换模型会改变向量空间，历史切片会失配。
 */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  const ai = loadEnv().ai;
  if (!ai.embedding.apiKey) {
    return null;
  }

  const cleaned = texts.map((text) => text.trim()).filter((text) => text.length > 0);
  if (cleaned.length === 0) {
    return [];
  }

  try {
    const vectors: number[][] = [];
    for (let offset = 0; offset < cleaned.length; offset += EMBEDDING_BATCH) {
      const batch = cleaned.slice(offset, offset + EMBEDDING_BATCH);
      const payload = (await postJsonResilient(
        `${ai.embedding.baseUrl}/embeddings`,
        ai.embedding.apiKey,
        { model: ai.embedding.model, input: batch, dimensions: ai.embedding.dimensions },
        ai.timeoutMs,
        "embedding",
      )) as { data?: Array<{ index: number; embedding: number[] }> };

      const rows = payload.data ?? [];
      if (rows.length !== batch.length) {
        throw new Error(`embedding 返回条数不符：期望 ${batch.length}，实际 ${rows.length}`);
      }
      rows
        .slice()
        .sort((left, right) => left.index - right.index)
        .forEach((row) => vectors.push(row.embedding));
    }

    const wrongDimension = vectors.find((vector) => vector.length !== ai.embedding.dimensions);
    if (wrongDimension) {
      throw new Error(
        `embedding 维度不符：期望 ${ai.embedding.dimensions}，实际 ${wrongDimension.length}（请同步 JXF_EMBEDDING_DIM 与 doc_chunks.embedding）`,
      );
    }

    return vectors;
  } catch (error) {
    log("warn", "ai_embedding_failed", { error: errorMessage(error), count: cleaned.length });
    return null;
  }
}

/**
 * 模型分工档位：
 * - deep：深度推理，顾问问答、复杂检索生成（pro）
 * - fast：高频轻量，巡读抽取、蒸馏建卡、摘要（flash）
 */
export type ChatTier = "deep" | "fast";

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface ChatCompletionResult {
  text: string;
  model: string;
  /** primary | fallback */
  provider: string;
  usage: ChatUsage | null;
}

/**
 * 单轮问答生成（含用量）。返回 null 表示未启用、重试与备用节点都失败。
 *
 * 节点顺序：主节点（重试 N 次）→ 备用节点（重试 N 次）→ 返回 null 交给调用方降级。
 */
export async function chatCompletionDetailed(
  messages: ChatMessage[],
  options: { temperature?: number; maxTokens?: number; tier?: ChatTier } = {},
): Promise<ChatCompletionResult | null> {
  const ai = loadEnv().ai;
  if (!ai.enabled) {
    return null;
  }

  const tier: ChatTier = options.tier ?? "deep";
  const model = tier === "fast" ? ai.fastModel : ai.chatModel;

  const providers = [
    { name: "primary", baseUrl: ai.baseUrl, apiKey: ai.apiKey, model },
    ...(ai.fallback
      ? [
          {
            name: "fallback",
            baseUrl: ai.fallback.baseUrl,
            apiKey: ai.fallback.apiKey,
            model: tier === "fast" ? ai.fallback.fastModel : ai.fallback.chatModel,
          },
        ]
      : []),
  ];

  for (const [index, provider] of providers.entries()) {
    try {
      const payload = (await postJsonResilient(
        `${provider.baseUrl}/chat/completions`,
        provider.apiKey,
        {
          model: provider.model,
          messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? ai.maxTokens,
        },
        ai.timeoutMs,
        provider.name,
      )) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };

      const choice = payload.choices?.[0];
      const content = choice?.message?.content?.trim();
      if (!content) {
        // 推理型模型的思考 token 会先消耗预算：max_tokens 过小时 content 为空、finish=length
        log("warn", "ai_chat_empty", {
          provider: provider.name,
          model: provider.model,
          tier,
          finish: choice?.finish_reason ?? "unknown",
        });
        return null;
      }

      if (index > 0) {
        // 主节点已失败，本次由备用节点接续完成
        log("info", "ai_chat_fallback_used", {
          provider: provider.name,
          model: provider.model,
          tier,
        });
      }

      const usage = payload.usage
        ? {
            promptTokens: Math.max(0, Math.trunc(payload.usage.prompt_tokens ?? 0)),
            completionTokens: Math.max(0, Math.trunc(payload.usage.completion_tokens ?? 0)),
            cachedTokens: Math.max(0, Math.trunc(payload.usage.prompt_tokens_details?.cached_tokens ?? 0)),
          }
        : null;

      return { text: content, model: provider.model, provider: provider.name, usage };
    } catch (error) {
      log("warn", index === 0 ? "ai_chat_provider_failed" : "ai_chat_fallback_failed", {
        provider: provider.name,
        model: provider.model,
        tier,
        status: error instanceof AiRequestError ? error.status : null,
        error: errorMessage(error),
      });
    }
  }

  log("warn", "ai_chat_failed", { model, tier, providers: providers.map((item) => item.name) });
  return null;
}

/** 兼容旧调用：只要文本 */
export async function chatCompletion(
  messages: ChatMessage[],
  options: { temperature?: number; maxTokens?: number; tier?: ChatTier } = {},
): Promise<string | null> {
  const result = await chatCompletionDetailed(messages, options);
  return result?.text ?? null;
}
