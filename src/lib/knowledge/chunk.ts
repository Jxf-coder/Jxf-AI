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

  const fullText = normalized.join("\n\n");
  const chunks: TextChunk[] = [];
  let pageStart = 0;

  normalized.forEach((page, pageIndex) => {
    // 页内切块：不跨页，重叠窗口也只在当前页内回退
    let start = 0;
    while (start < page.length) {
      let end = Math.min(start + MAX_SIZE, page.length);

      if (end < page.length) {
        const windowStart = Math.min(start + MIN_SIZE, end - 1);
        for (let index = end - 1; index >= windowStart; index -= 1) {
          if (BOUNDARY.test(page[index])) {
            end = index + 1;
            break;
          }
        }
      }

      const raw = page.slice(start, end);
      const leading = raw.length - raw.trimStart().length;
      const text = raw.trim();
      const charStart = pageStart + start + leading;

      if (text.length > 0) {
        chunks.push({
          ord: chunks.length,
          pageNo: pageIndex + 1,
          charStart,
          charEnd: charStart + text.length,
          text,
        });
      }

      if (end >= page.length) {
        break;
      }

      // 重叠窗口，避免句末切断导致的语义断裂
      const next = end - OVERLAP;
      start = next > start ? next : end;
    }

    pageStart += page.length + 2; // 页间以 "\n\n" 连接
  });

  return { fullText, charCount: fullText.length, chunks };
}
