/**
 * 安装向导的纯函数部分（可单测，不写文件、不启动容器）。
 *
 * 目标：把 .env.example 变成可启动的 .env —— 生成随机密钥与口令，
 * 并检查是否还残留 CHANGE_ME 占位值。
 */

import { randomBytes } from "node:crypto";

/** 必须替换为随机值的口令字段（会拼进数据库连接串，只用字母数字） */
export const PASSWORD_KEYS = [
  "POSTGRES_PASSWORD",
  "JXF_OWNER_PASSWORD",
  "JXF_APP_PASSWORD",
  "JXF_AUTH_PASSWORD",
  "JXF_WORKER_PASSWORD",
  "MINIO_ROOT_PASSWORD",
];

/** 仅开发种子使用；随机生成，生产环境不要执行 seed */
export const SEED_KEYS = ["SEED_PASSWORD"];

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function randomHex(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

/** 连接串安全的随机口令（字母数字） */
export function randomAlnum(length = 32) {
  const buffer = randomBytes(length);
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += ALPHABET[buffer[index] % ALPHABET.length];
  }
  return out;
}

/**
 * 按 .env.example 生成 .env 内容。
 * 只替换已知的密钥字段，其余配置保持模板原样，便于用户按需修改。
 */
export function generateEnv(template) {
  const generated = [];
  const lines = template.split(/\r?\n/).map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match) {
      return line;
    }
    const key = match[1];
    if (key === "JXF_AUTH_SECRET") {
      generated.push(key);
      return `${key}=${randomHex(32)}`;
    }
    if (PASSWORD_KEYS.includes(key)) {
      generated.push(key);
      return `${key}=${randomAlnum(32)}`;
    }
    if (SEED_KEYS.includes(key)) {
      generated.push(key);
      return `${key}=${randomAlnum(24)}`;
    }
    return line;
  });

  return { content: `${lines.join("\n").replace(/\n+$/, "")}\n`, generated };
}

/** 返回仍带 CHANGE_ME 占位值的配置项（只看 `KEY=value` 行，不看注释） */
export function findPlaceholders(content) {
  const found = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match && /CHANGE_ME/i.test(match[2])) {
      found.push(`${match[1]}（第 ${index + 1} 行）`);
    }
  });
  return found;
}
