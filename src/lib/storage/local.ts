/**
 * 本地分级存储（当前阶段）。
 *
 * 物理路径：public/uploads/{部门}/{岗位}/{标准目录}/{文件名}
 * 数据库只存相对 key（`uploads/...`），与磁盘目录一一对应。
 *
 * 红线：
 * - 只允许写 `public/uploads/` 之下，`..` 与绝对路径一律拒绝，避免路径穿越；
 * - 目录段做规范化（去空白 / 保留中英文数字），空值落兜底段，保证每级目录都存在。
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const UPLOAD_ROOT = path.join(process.cwd(), "public", "uploads");
const KEY_PREFIX = "uploads/";

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  xml: "application/xml",
  log: "text/plain; charset=utf-8",
};

/** 目录段：只保留中英文、数字与 ._-，其余折成 - */
export function safeSegment(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

export function uploadKey(parts: {
  department: string;
  role: string;
  folder: string;
  filename: string;
}): string {
  return [
    KEY_PREFIX.replace(/\/$/, ""),
    safeSegment(parts.department, "dept"),
    safeSegment(parts.role, "unassigned"),
    safeSegment(parts.folder, "folder"),
    safeSegment(parts.filename, "file"),
  ].join("/");
}

function resolveKey(key: string): string {
  const normalized = path.posix.normalize(key).replace(/^\/+/, "");
  if (!normalized.startsWith(KEY_PREFIX) || normalized.includes("..")) {
    throw new Error(`非法存储路径：${key}`);
  }
  const absolute = path.join(process.cwd(), "public", normalized);
  if (absolute !== UPLOAD_ROOT && !absolute.startsWith(`${UPLOAD_ROOT}${path.sep}`)) {
    throw new Error(`非法存储路径：${key}`);
  }
  return absolute;
}

export async function putObject(key: string, body: Uint8Array): Promise<void> {
  const target = resolveKey(key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
}

export async function getObject(key: string): Promise<{ body: Uint8Array; contentType: string }> {
  const target = resolveKey(key);
  const body = new Uint8Array(await readFile(target));
  const extension = path.extname(target).replace(/^\./, "").toLowerCase();
  return { body, contentType: CONTENT_TYPES[extension] ?? "application/octet-stream" };
}

/** 删除对象：文件本就不存在时视为成功；非本地存储的旧 key（如对象存储路径）直接跳过 */
export async function deleteObject(key: string): Promise<void> {
  if (!key.startsWith(KEY_PREFIX)) {
    return;
  }
  const target = resolveKey(key);
  await unlink(target).catch(() => undefined);
}
