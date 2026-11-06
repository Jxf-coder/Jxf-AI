/**
 * 扫描件 OCR：Gemini 视觉（原生 generateContent + inline_data）。
 *
 * 红线：
 * - 任何失败（未启用 / 超时 / HTTP 错误 / 输出被截断 / 空结果）一律返回 null，
 *   由调用方标记 needs_ocr 并回落人工补录——不把残缺识别结果写入知识库；
 * - 只接受 PDF 与常见图片，超限文件不发送；
 * - 不打印文档内容与 Key，日志只记模型、字节数与错误摘要。
 */

import { loadEnv } from "@/lib/env";
import { errorMessage, log } from "@/lib/logger";

export interface OcrResult {
  text: string;
  model: string;
}

const SUPPORTED_MIMES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);

const OCR_PROMPT = [
  "你是 OCR 引擎，只做文字识别，不回答问题。",
  "请逐页提取文档中的全部文字：保持原有顺序与换行；每页第一行单独输出「【第 N 页】」；",
  "不要总结、不要补全、不要解释；无法识别的字用 ▢ 代替；只输出正文，不要代码块围栏。",
].join("");

/** 以扩展名兜底：部分浏览器上传 PDF 时 mime 为空 */
export function normalizeOcrMime(mime: string, fileName: string): string {
  const lower = (mime ?? "").trim().toLowerCase();
  if (SUPPORTED_MIMES.has(lower)) {
    return lower;
  }
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "pdf") return "application/pdf";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return lower;
}

/**
 * 识别一份扫描件。返回 null 表示「没有可用结果」，调用方应保留 needs_ocr。
 */
export async function ocrDocument(
  bytes: Uint8Array,
  mime: string,
  fileName: string,
): Promise<OcrResult | null> {
  const ocr = loadEnv().ocr;
  if (!ocr.enabled) {
    return null;
  }

  const normalizedMime = normalizeOcrMime(mime, fileName);
  if (!SUPPORTED_MIMES.has(normalizedMime)) {
    log("warn", "ai_ocr_unsupported", { mime: normalizedMime || "unknown" });
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > ocr.maxBytes) {
    log("warn", "ai_ocr_too_large", { bytes: bytes.byteLength, max: ocr.maxBytes });
    return null;
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(
      `${ocr.baseUrl}/models/${encodeURIComponent(ocr.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": ocr.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: OCR_PROMPT },
                {
                  inline_data: {
                    mime_type: normalizedMime,
                    data: Buffer.from(bytes).toString("base64"),
                  },
                },
              ],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 16384 },
        }),
        signal: AbortSignal.timeout(ocr.timeoutMs),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      log("warn", "ai_ocr_failed", {
        model: ocr.model,
        mime: normalizedMime,
        status: response.status,
        error: detail.slice(0, 300),
        ms: Date.now() - startedAt,
      });
      return null;
    }

    const payload = (await response.json()) as {
      candidates?: Array<{
        finishReason?: string;
        content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      }>;
    };
    const candidate = payload.candidates?.[0];
    if (candidate?.finishReason === "MAX_TOKENS") {
      // 输出被截断：宁可回落人工，也不写入半份正文
      log("warn", "ai_ocr_truncated", {
        model: ocr.model,
        mime: normalizedMime,
        ms: Date.now() - startedAt,
      });
      return null;
    }

    const text = (candidate?.content?.parts ?? [])
      // 思考型模型会把推理片段混在 parts 里（thought=true），只取正文
      .filter((part) => part.thought !== true)
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    if (text.length === 0) {
      log("warn", "ai_ocr_empty", {
        model: ocr.model,
        mime: normalizedMime,
        finish: candidate?.finishReason ?? "unknown",
        ms: Date.now() - startedAt,
      });
      return null;
    }

    log("info", "ai_ocr_completed", {
      model: ocr.model,
      mime: normalizedMime,
      bytes: bytes.byteLength,
      chars: text.length,
      ms: Date.now() - startedAt,
    });
    return { text, model: ocr.model };
  } catch (error) {
    log("warn", "ai_ocr_error", {
      model: ocr.model,
      mime: normalizedMime,
      error: errorMessage(error),
      ms: Date.now() - startedAt,
    });
    return null;
  }
}
