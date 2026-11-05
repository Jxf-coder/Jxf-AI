/**
 * AI 出口：OpenAI 标准兼容格式（官方 / 硅基流动 / DeepSeek / 自建网关均可）。
 *
 * 红线：无 Key 或调用失败一律返回 null，由调用方降级（检索退化为 pg_bigm 纯关键词，
 * 问答直接拒绝生成）。禁止在这里抛错打断入库。
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
  chatModel: string;
  embeddingModel: string;
}

export function aiStatus(): AiStatus {
  const ai = loadEnv().ai;
  return {
    chatEnabled: ai.enabled,
    embeddingEnabled: ai.embedding.apiKey !== "",
    chatModel: ai.chatModel,
    embeddingModel: ai.embedding.model,
  };
}

const EMBEDDING_BATCH = 32;

async function postJson(url: string, apiKey: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`AI HTTP ${response.status}: ${detail.slice(0, 300)}`);
  }

  return response.json();
}

/**
 * 批量向量化。返回 null 表示未配置或调用失败，调用方应把 embedding 留空。
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
      const payload = (await postJson(
        `${ai.embedding.baseUrl}/embeddings`,
        ai.embedding.apiKey,
        { model: ai.embedding.model, input: batch, dimensions: ai.embedding.dimensions },
        ai.timeoutMs,
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
 * 单轮问答生成。返回 null 表示未启用或调用失败。
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options: { temperature?: number; maxTokens?: number } = {},
): Promise<string | null> {
  const ai = loadEnv().ai;
  if (!ai.enabled) {
    return null;
  }

  try {
    const payload = (await postJson(
      `${ai.baseUrl}/chat/completions`,
      ai.apiKey,
      {
        model: ai.chatModel,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? ai.maxTokens,
      },
      ai.timeoutMs,
    )) as { choices?: Array<{ message?: { content?: string } }> };

    const content = payload.choices?.[0]?.message?.content?.trim();
    return content ? content : null;
  } catch (error) {
    log("warn", "ai_chat_failed", { error: errorMessage(error), model: ai.chatModel });
    return null;
  }
}
