/**
 * 渠道 HTTP 发送的公共部分：超时、单次重试、JSON 解析。
 *
 * 失败不抛出，统一返回结构化结果，调用方只负责日志与审计。
 */

export interface JsonPostResult {
  ok: boolean;
  status: number;
  body: unknown;
  error: string | null;
  durationMs: number;
}

/** 单个渠道的发送结果；skipped 只用于「未启用/未配置」 */
export interface ChannelSendResult {
  sent: boolean;
  skipped: boolean;
  error: string | null;
}

export type FetchLike = typeof fetch;

const DEFAULT_TIMEOUT_MS = 5_000;
/** 尝试次数：1 次首投 + 1 次重试；只对网络错误与 5xx 重试 */
const DEFAULT_ATTEMPTS = 2;

function parseBody(raw: string): unknown {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function postJson(
  url: string,
  payload: unknown,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; attempts?: number } = {},
): Promise<JsonPostResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const startedAt = Date.now();
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await response.text().catch(() => "");
      const body = parseBody(raw);
      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          body,
          error: null,
          durationMs: Date.now() - startedAt,
        };
      }
      lastError = `HTTP ${response.status}${raw ? `：${raw.slice(0, 200)}` : ""}`;
      if (response.status < 500 || attempt === attempts) {
        break;
      }
    } catch (caught) {
      lastError = caught instanceof Error ? caught.message : String(caught);
      if (attempt === attempts) {
        break;
      }
    }
  }

  return {
    ok: false,
    status: 0,
    body: null,
    error: lastError ?? "发送失败",
    durationMs: Date.now() - startedAt,
  };
}
