/**
 * 文档解析：把二进制转成分页文本。
 *
 * 原则：解析不出文字就如实标 needs_ocr / failed，不假装读过。
 * 扫描件（PDF 无文本层）→ needs_ocr；格式不支持 → 交给规则筛跳过。
 */

import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

export class UnsupportedDocumentError extends Error {
  constructor(public readonly extension: string) {
    super(`不支持的文件类型：${extension || "unknown"}`);
    this.name = "UnsupportedDocumentError";
  }
}

export interface ParsedDocument {
  /** 逐页文本；DOCX / TXT 等无分页概念的文件只有一页 */
  pages: string[];
  /** 是否解析出了正文（false 表示需要 OCR） */
  hasText: boolean;
}

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "json", "html", "htm", "log", "xml"]);

export function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

export async function parseDocument(
  buffer: Uint8Array,
  mime: string,
  fileName: string,
): Promise<ParsedDocument> {
  const extension = fileExtension(fileName);

  if (extension === "pdf" || mime === "application/pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = (await extractText(pdf, { mergePages: false })) as { text: string[] };
    const pages = (result.text ?? []).map((page) => normalizeText(page));
    const hasText = pages.some((page) => page.length > 0);
    return { pages: hasText ? pages : [], hasText };
  }

  if (extension === "docx") {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
    const text = normalizeText(result.value ?? "");
    return { pages: text ? [text] : [], hasText: text.length > 0 };
  }

  if (TEXT_EXTENSIONS.has(extension) || mime.startsWith("text/")) {
    const text = normalizeText(new TextDecoder("utf-8").decode(buffer));
    return { pages: text ? [text] : [], hasText: text.length > 0 };
  }

  throw new UnsupportedDocumentError(extension);
}

function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
