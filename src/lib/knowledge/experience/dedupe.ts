/**
 * 去重与冷却的纯函数：
 * - 近似相似度用字符 shingle 的 Jaccard，≥0.92 合并、0.85–0.92 只标疑似；
 * - 冷却桶统一 UTC YYYYMMDDHH24，避免跨时区错位；
 * - 手动触发用 manual:<uuid>，可绕过自动桶与滑动窗口；
 * - numSignature 补上 titleKey 抹掉的数字，避免「第 2 步失败」与「第 3 步失败」被合并。
 */

import { createHash } from "node:crypto";

import { normalizeForMatch, titleKey } from "@/lib/knowledge/evidence";

export const SIMILARITY_MERGE = 0.92;
export const SIMILARITY_SUSPECT = 0.85;

export type SimilarityVerdict = "merge" | "suspect" | "independent";

const DEFAULT_SHINGLE_SIZE = 3;

export function shingles(text: string, size = DEFAULT_SHINGLE_SIZE): Set<string> {
  const normalized = normalizeForMatch(text ?? "");
  const result = new Set<string>();
  if (normalized.length === 0) {
    return result;
  }
  if (normalized.length <= size) {
    result.add(normalized);
    return result;
  }
  for (let index = 0; index + size <= normalized.length; index += 1) {
    result.add(normalized.slice(index, index + size));
  }
  return result;
}

export function jaccardSimilarity(left: string, right: string, size = DEFAULT_SHINGLE_SIZE): number {
  const a = shingles(left, size);
  const b = shingles(right, size);
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

export function classifySimilarity(score: number): SimilarityVerdict {
  if (score >= SIMILARITY_MERGE) {
    return "merge";
  }
  if (score >= SIMILARITY_SUSPECT) {
    return "suspect";
  }
  return "independent";
}

/** UTC 小时桶，形如 2026110812 */
export function cooldownBucket(at: Date = new Date()): string {
  return at.toISOString().slice(0, 13).replace(/[-T]/g, "");
}

export function manualBucket(id: string): string {
  return `manual:${id}`;
}

/**
 * 标题骨架会抹掉数字，这里补一个数字签名（无数字时为 "0"）。
 *
 * 注意：不能用 evidence.extractNumbers——它会刻意跳过单个数字，
 * 而「第 2 步 / 第 3 步」恰恰是单数字，必须保留，否则两张不同经验卡会被合并。
 * 宁可多产生一条 pending 卡，也不能错误合并。
 */
const NUMBER_TOKEN_RE = /\d+(?:[.,]\d+)*/g;

export function numSignature(body: string): string {
  const numbers = (String(body ?? "").match(NUMBER_TOKEN_RE) ?? [])
    .map((item) => item.replace(/,/g, ""))
    .sort();
  if (numbers.length === 0) {
    return "0";
  }
  return createHash("sha1").update(numbers.join("|")).digest("hex").slice(0, 8);
}

/** 人工文档单卡：一篇文档一张草稿 */
export function documentDedupeKey(documentId: string): string {
  return `doc:${documentId}`;
}

/** 文档蒸馏多卡：标题骨架 + 数字签名，避免同文档不同故障被合并 */
export function distillDedupeKey(documentId: string, title: string, body: string): string {
  return `distill:${documentId}:${titleKey(title) || "untitled"}:${numSignature(body)}`;
}

/** 经验卡：按卡去重，不按 job */
export function experienceDedupeKey(
  sourceType: string,
  sourceId: string,
  title: string,
  body: string,
): string {
  return `run:${sourceType}:${sourceId}:${titleKey(title) || "untitled"}:${numSignature(body)}`;
}
