/**
 * 模型价格：微元（1e-6 元）/ 百万 token。
 *
 * 红线：
 * - 不用浮点存钱；价格未配置时如实记 0，不编造成本；
 * - 价格不写死在调用处：统一由这里解析（后续可迁到 model_prices 表）。
 */

function microsPerMillion(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export interface ModelPrice {
  promptMicrosPerMTok: number;
  completionMicrosPerMTok: number;
}

export function priceForModel(): ModelPrice {
  // 当前部署按单一价格配置；多模型差异价格后续迁到 model_prices 表
  return {
    promptMicrosPerMTok: microsPerMillion("JXF_AI_PRICE_PROMPT_MICROS_PER_MTOK", 0),
    completionMicrosPerMTok: microsPerMillion("JXF_AI_PRICE_COMPLETION_MICROS_PER_MTOK", 0),
  };
}

export function estimateCostMicros(promptTokens: number, completionTokens: number): number {
  const price = priceForModel();
  const prompt = Math.max(0, Math.trunc(promptTokens));
  const completion = Math.max(0, Math.trunc(completionTokens));
  return Math.round((prompt * price.promptMicrosPerMTok + completion * price.completionMicrosPerMTok) / 1_000_000);
}
