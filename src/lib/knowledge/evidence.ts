/**
 * 证据核对：知识卡里的原文短引必须能在切片原文里逐字找到。
 *
 * 比较前只抹掉空白、全半角与标点写法差异，不做模糊匹配——对不上就是对不上。
 * 命中后把引文映射回切片原文的绝对字符区间，供卡片证据链落库与前端高亮。
 */

export function normalizeForMatch(value: string): string {
  return value
    .replace(/[\u2E80-\u2FDF\uF900-\uFAFF]/g, (character) => character.normalize("NFKC"))
    .normalize("NFKC")
    .replace(/[\s\u00a0\u3000]+/g, "")
    .replace(/[，,]/g, ",")
    .replace(/[。．]/g, ".")
    .replace(/[：:]/g, ":")
    .replace(/[；;]/g, ";")
    .replace(/[（(]/g, "(")
    .replace(/[）)]/g, ")")
    .replace(/[【\[]/g, "[")
    .replace(/[】\]]/g, "]")
    .replace(/[“”"「」『』〝〞]/g, '"')
    .replace(/[‘’'`]/g, "'")
    .replace(/[—–‐‑‒−-]+/g, "-")
    .replace(/[～~〜]/g, "~")
    .replace(/[·•・]/g, "·")
    .toLowerCase();
}

/**
 * 归一化同时保留「归一化字符 → 原文字符下标」的映射。
 * 空白字符归一化后为空串，会直接从映射中消失。
 */
function normalizeWithMap(value: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const normalized = normalizeForMatch(value[index]);
    for (let offset = 0; offset < normalized.length; offset += 1) {
      map.push(index);
    }
    norm += normalized;
  }

  return { norm, map };
}

const ELLIPSIS = /(?:…+|\.{3,}|。{3,})/;

export interface QuoteMatch {
  verified: boolean;
  /** 原文逐字片段（不是模型给的引文），保证证据可回放 */
  quote?: string;
  charStart?: number;
  charEnd?: number;
}

/**
 * 校验引文是否落在切片原文中，并返回原文区间。
 *
 * @param chunkText      切片原文（doc_chunks.text）
 * @param chunkCharStart 切片在全文中的起始偏移（doc_chunks.char_start）
 * @param rawQuote       模型 / 人工给出的引文；允许用省略号跳过一段
 */
export function verifyQuoteInChunk(chunkText: string, chunkCharStart: number, rawQuote: string): QuoteMatch {
  const raw = String(rawQuote ?? "").trim();
  if (!raw) {
    return { verified: false };
  }

  const parts = raw
    .split(ELLIPSIS)
    .map((part) => normalizeForMatch(part))
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    return { verified: false };
  }

  // 过短的引文不算证据（不足 4 字且不含数字）
  const joined = parts.join("");
  if (joined.length < 4 && !/\d/.test(joined)) {
    return { verified: false };
  }

  const { norm, map } = normalizeWithMap(chunkText);

  let cursor = 0;
  let startNorm = -1;
  let endNorm = -1;
  for (const part of parts) {
    const at = norm.indexOf(part, cursor);
    if (at < 0) {
      return { verified: false };
    }
    if (startNorm < 0) {
      startNorm = at;
    }
    endNorm = at + part.length;
    cursor = endNorm;
  }

  const start = map[startNorm];
  const end = map[endNorm - 1];
  if (start === undefined || end === undefined) {
    return { verified: false };
  }

  return {
    verified: true,
    quote: chunkText.slice(start, end + 1),
    charStart: chunkCharStart + start,
    charEnd: chunkCharStart + end + 1,
  };
}

/** 抽出带单位的数字串（价格 / 参数 / 年份），用于冲突判定与答案数字校验 */
const NUMBER_RE =
  /\d+(?:[.,]\d+)*(?:\s*[-~～至到]\s*\d+(?:[.,]\d+)*)?\s*(?:l\/min|万元|mm²|mesh|ppm|ppb|rpm|cfu|kpa|mpa|bar|min|kg|mg|μg|ug|ml|mm|cm|km|m²|m2|m³|m3|kw|kv|ma|hz|db|μm|um|nm|iu|°c|pa|小时|分钟|%|％|‰|℃|°|元|万|亿|千|百|天|日|周|月|年|秒|岁|度|倍|次|台|套|件|个|家|人|款|种|批|目|㎡|㎜|㎝|㎏|m|g|t|l|w|v|a|h|s)?/gi;

export function extractNumbers(text: string): string[] {
  const found = new Set<string>();
  for (const match of String(text ?? "").matchAll(NUMBER_RE)) {
    const value = match[0].replace(/\s+/g, "").replace(/，/g, ",").toLowerCase();
    if (/^\d$/.test(value)) {
      continue;
    }
    found.add(value);
  }
  return [...found];
}

/** 去掉数字、单位和标点的标题骨架，用来判断「同一件事」 */
export function titleKey(title: string): string {
  const base = normalizeForMatch(title ?? "")
    .replace(/\d+(?:[.,]\d+)*/g, "#")
    .replace(/[^\p{L}#|]+/gu, "");
  return base.replace(/#+/g, "#");
}

/** 两段正文的数字集合是否不同（同一件事数字不同 = 冲突） */
export function numbersDiffer(left: string, right: string): boolean {
  const leftNumbers = extractNumbers(left);
  const rightNumbers = extractNumbers(right);
  if (leftNumbers.length === 0 || rightNumbers.length === 0) {
    return false;
  }
  const leftSet = new Set(leftNumbers);
  return rightNumbers.some((value) => !leftSet.has(value)) || leftNumbers.some((value) => !rightNumbers.includes(value));
}
