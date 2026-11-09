/**
 * 结构化指纹：把「同一故障」压成稳定 hash，用于冷却与去重。
 *
 * 口径：
 * - 只抹 UUID / 时间戳 / 请求 ID / 随机临时路径；
 * - 保留错误码、步骤名、状态码、异常类型——否则不同故障会被误判为重复；
 * - 指纹包含租户与部门、不含 channel：跨通道的同一故障可只建关联、不重复产卡。
 */

import { createHash } from "node:crypto";

import { normalizeForMatch } from "@/lib/knowledge/evidence";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIME_RE = /\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/gi;
const EPOCH_MS_RE = /\b1[6-9]\d{11}\b/g;
const REQUEST_ID_RE =
  /\b(?:req|request|trace|span|correlation)[-_]?id\s*[=:]\s*[A-Za-z0-9._-]{6,}/gi;
const TEMP_PATH_RE = /\/(?:tmp|var\/folders|private\/var)\/[^\s"']+/g;

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeForFingerprint(value: string): string {
  const replaced = String(value ?? "")
    .replace(UUID_RE, "<uuid>")
    .replace(ISO_TIME_RE, "<time>")
    .replace(EPOCH_MS_RE, "<time>")
    .replace(REQUEST_ID_RE, "reqid=<id>")
    .replace(TEMP_PATH_RE, "<path>");
  return normalizeForMatch(replaced).slice(0, 20_000);
}

export interface FingerprintInput {
  tenantId: string;
  departmentId: string;
  sourceType: string;
  step?: string | null;
  errorType?: string | null;
  statusCode?: string | number | null;
  text: string;
}

export function buildFingerprint(input: FingerprintInput): string {
  const parts = [
    input.tenantId,
    input.departmentId,
    input.sourceType,
    String(input.step ?? "").trim().toLowerCase(),
    String(input.errorType ?? "").trim().toLowerCase(),
    String(input.statusCode ?? "").trim(),
    hashText(normalizeForFingerprint(input.text)),
  ];
  return hashText(parts.join("|"));
}
