/**
 * 设置面密钥加密（AES-256-GCM）。
 *
 * 数据库只保存密文，解密材料来自进程环境变量：
 * - `v2`：专用数据加密密钥 `JXF_DATA_ENCRYPTION_KEY`（推荐，轮换会话密钥不影响已存密文）
 * - `v1`：回退到 `JXF_AUTH_SECRET`（旧部署兼容，无需迁移）
 *
 * 读取按密文版本选密钥，因此配置专用密钥后旧 `v1` 密文仍可解密，下次保存自动升级为 `v2`。
 * 数据库备份 / 误导出不会泄露模型 Key 明文。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const VERSION_LEGACY = "v1";
const VERSION_DEDICATED = "v2";
const SALT = "jxf-app-settings";

const keyCache = new Map<string, Buffer>();

function deriveKey(secret: string): Buffer {
  const cached = keyCache.get(secret);
  if (cached) {
    return cached;
  }
  const key = scryptSync(secret, SALT, 32);
  keyCache.set(secret, key);
  return key;
}

function dedicatedSecret(): string {
  return process.env.JXF_DATA_ENCRYPTION_KEY?.trim() ?? "";
}

/** 新密文优先用专用密钥；未配置时保持旧口径，已有部署不需要迁移 */
function writeKey(): { version: string; key: Buffer } {
  const dedicated = dedicatedSecret();
  if (dedicated) {
    return { version: VERSION_DEDICATED, key: deriveKey(dedicated) };
  }
  return { version: VERSION_LEGACY, key: deriveKey(process.env.JXF_AUTH_SECRET ?? "") };
}

/** 按密文版本取密钥；专用密钥未配置时 `v2` 密文无法解密，返回 null */
function keyForVersion(version: string): Buffer | null {
  if (version === VERSION_LEGACY) {
    return deriveKey(process.env.JXF_AUTH_SECRET ?? "");
  }
  if (version === VERSION_DEDICATED) {
    const dedicated = dedicatedSecret();
    return dedicated ? deriveKey(dedicated) : null;
  }
  return null;
}

/** 返回 `v1|v2.<iv>.<tag>.<ciphertext>`（base64url 分段） */
export function encryptSecret(plain: string): string {
  const { version, key } = writeKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [version, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

/** 解密失败（密钥缺失 / 轮换 / 数据损坏）返回 null，由调用方回退到环境变量 */
export function decryptSecret(payload: string): string | null {
  try {
    const [version, ivPart, tagPart, dataPart] = payload.split(".");
    if (!version || !ivPart || !tagPart || !dataPart) {
      return null;
    }
    const key = keyForVersion(version);
    if (!key) {
      return null;
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

/** 面向前端的脱敏提示，只保留末 4 位 */
export function secretHint(plain: string): string {
  const trimmed = plain.trim();
  if (trimmed.length <= 4) {
    return "••••";
  }
  return `••••${trimmed.slice(-4)}`;
}
