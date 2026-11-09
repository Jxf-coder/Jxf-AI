/**
 * 去敏：按「键的语义 + 值的类型」替换敏感值，不做关键词模糊替换。
 *
 * 保留：字段名、URL 的 host/path、状态码、错误类型、端口、重试次数等技术信息；
 * 替换：密钥/密码/Cookie 的值、Bearer/JWT/sk- 与 jxf_mcp_ 令牌、手机号/邮箱/证件/银行卡、
 *       长 hex/base64。
 *
 * 只去敏一次、三处复用（LLM 输入 / 证据校验 / 人工工作台展示）。
 */

const MASK = "***";

const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const MCP_TOKEN_RE = /\bjxf_mcp_[A-Za-z0-9_-]{8,}/g;
const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;

const SECRET_PAIR_RE =
  /([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|cookie|authorization|session[_-]?id|client[_-]?secret)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)([^\s"',;&]+)\3/gi;

const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ID_CARD_RE = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const BANK_CARD_RE = /(?<!\d)\d{16,19}(?!\d)/g;
const LONG_HEX_RE = /\b[A-Fa-f0-9]{32,}\b/g;
const LONG_B64_RE = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

export function redactText(value: string): string {
  let text = String(value ?? "");

  text = text.replace(BEARER_RE, `Bearer ${MASK}`);
  text = text.replace(MCP_TOKEN_RE, `jxf_mcp_${MASK}`);
  text = text.replace(SK_KEY_RE, `sk-${MASK}`);
  text = text.replace(JWT_RE, MASK);

  text = text.replace(SECRET_PAIR_RE, (_match, key: string, separator: string, quote: string) => {
    return `${key}${separator}${quote}${MASK}${quote}`;
  });

  text = text.replace(ID_CARD_RE, MASK);
  text = text.replace(PHONE_RE, MASK);
  text = text.replace(EMAIL_RE, MASK);
  text = text.replace(BANK_CARD_RE, MASK);

  text = text.replace(LONG_HEX_RE, MASK);
  text = text.replace(LONG_B64_RE, MASK);

  return text;
}

/** 递归去敏：source_meta 等结构化摘要里的字符串同样处理，禁止直接存原始错误对象 */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") {
    return redactText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item)) as T;
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactValue(item);
    }
    return result as T;
  }
  return value;
}
