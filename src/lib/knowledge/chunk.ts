/**
 * 分块：把分页文本切成可检索、可回溯原文的片段。
 *
 * 约束：
 * - charStart / charEnd 是「规范化全文」里的绝对偏移，证据链按此区间逐字校验；
 * - 块不跨页（pageNo 用于前端定位），长页内按句末切分，带少量重叠避免语义断裂；
 * - 不使用中文分词，检索通道由 pg_bigm 负责。
 */

export interface TextChunk {
  ord: number;
  pageNo: number | null;
  charStart: number;
  charEnd: number;
  text: string;
}

export interface ChunkedDocument {
  fullText: string;
  charCount: number;
  chunks: TextChunk[];
}

/** 硬上限 / 下限 / 重叠（字符） */
const MAX_SIZE = 900;
const MIN_SIZE = 300;
const OVERLAP = 80;

const BOUNDARY = /[。！？；!?;\n]/;

export function chunkPages(pages: string[]): ChunkedDocument {
  const normalized = pages.map((page) => page.trim()).filter((page) => page.length > 0);

  if (normalized.length === 0) {
    return { fullText: "", charCount: 0, chunks: [] };
  }

  const pageStarts: number[] = [];
  let cursor = 0;
  for (const page of normalized) {
    pageStarts.push(cursor);
    cursor += page.length + 2; // 页间以 "\n\n" 连接
  }

  const fullText = normalized.join("\n\n");
  const chunks: TextChunk[] = [];

  let start = 0;
  while (start < fullText.length) {
    let end = Math.min(start + MAX_SIZE, fullText.length);

    if (end < fullText.length) {
      const windowStart = Math.min(start + MIN_SIZE, end - 1);
      for (let index = end - 1; index >= windowStart; index -= 1) {
        if (BOUNDARY.test(fullText[index])) {
          end = index + 1;
          break;
        }
      }
    }

    const raw = fullText.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();

    if (text.length > 0) {
      chunks.push({
        ord: chunks.length,
        pageNo: pageOf(pageStarts, start + leading),
        charStart: start + leading,
        charEnd: start + leading + text.length,
        text,
      });
    }

    if (end >= fullText.length) {
      break;
    }

    // 重叠窗口，避免句末切断导致的语义断裂
    const next = end - OVERLAP;
    start = next > start ? next : end;
  }

  return { fullText, charCount: fullText.length, chunks };
}

function pageOf(pageStarts: number[], position: number): number | null {
  if (pageStarts.length === 0) {
    return null;
  }
  let page = 0;
  for (let index = 0; index < pageStarts.length; index += 1) {
    if (pageStarts[index] <= position) {
      page = index;
    } else {
      break;
    }
  }
  return page + 1;
}
