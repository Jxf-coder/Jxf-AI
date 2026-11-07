/**
 * 设置面密钥加密（AES-256-GCM）。
 *
 * 数据库只保存密文，解密材料来自进程环境变量 JXF_AUTH_SECRET，
 * 因此数据库备份 / 误导出不会泄露模型 Key 明文。
 * 轮换 JXF_AUTH_SECRET 后旧密文无法解密，运行时回退到环境变量配置。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const VERSION = "v1";
const SALT = "jxf-app-settings";
let cachedKey: Buffer | null = null;

function encryptionKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }
  const secret = process.env.JXF_AUTH_SECRET ?? "";
  cachedKey = scryptSync(secret, SALT, 32);
  return cachedKey;
}

/** 返回 `v1.<iv>.<tag>.<ciphertext>`（base64url 分段） */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

/** 解密失败（密钥轮换 / 数据损坏）返回 null，由调用方回退到环境变量 */
export function decryptSecret(payload: string): string | null {
  try {
    const [version, ivPart, tagPart, dataPart] = payload.split(".");
    if (version !== VERSION || !ivPart || !tagPart || !dataPart) {
      return null;
    }
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivPart, "base64url"));
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
