/**
 * 把数据库中的模型配置应用到当前进程（Web 热生效）。
 *
 * - 启动期由 instrumentation 调用一次；
 * - 保存设置后由 Server Action 再调用，刷新 env 缓存；
 * - Worker 是独立进程，需重启后才会重新加载。
 */

import { resetEnvCache } from "@/lib/env";
import { errorMessage, log } from "@/lib/logger";

import { decryptSecret } from "./crypto";
import { setAiRuntimeOverride, type AiRuntimeOverride } from "./runtime";
import { readRuntimeSettings } from "./store";

export async function refreshRuntimeSettings(): Promise<void> {
  const row = await readRuntimeSettings();

  const hasOverride =
    row.aiEnabled !== null ||
    Boolean(row.aiBaseUrl) ||
    Boolean(row.aiApiKeyEnc) ||
    Boolean(row.aiModelPro) ||
    Boolean(row.aiModelFlash);

  if (!hasOverride) {
    setAiRuntimeOverride(null);
    resetEnvCache();
    return;
  }

  let apiKey: string | undefined;
  if (row.aiApiKeyEnc) {
    const decrypted = decryptSecret(row.aiApiKeyEnc);
    if (decrypted === null) {
      // 密钥轮换或密文损坏：保留环境变量配置，避免整站 AI 不可用
      log("warn", "settings_api_key_decrypt_failed", { hint: row.aiApiKeyHint });
    } else {
      apiKey = decrypted;
    }
  }

  const override: AiRuntimeOverride = {
    enabled: row.aiEnabled ?? undefined,
    baseUrl: row.aiBaseUrl ?? undefined,
    apiKey,
    chatModel: row.aiModelPro ?? undefined,
    fastModel: row.aiModelFlash ?? undefined,
  };
  setAiRuntimeOverride(override);
  resetEnvCache();
}

/** 启动期 / 首个页面请求调用：数据库未就绪时只告警，不阻断服务 */
export async function tryRefreshRuntimeSettings(): Promise<boolean> {
  try {
    await refreshRuntimeSettings();
    return true;
  } catch (error) {
    log("warn", "settings_runtime_refresh_failed", { error: errorMessage(error) });
    return false;
  }
}

let ready = false;
let inflight: Promise<void> | null = null;

/**
 * 懒加载入口：首个页面（含登录页）渲染前应用一次数据库配置。
 * 失败时下次请求重试；成功后进程内不再重复查询。
 */
export function ensureRuntimeSettings(): Promise<void> {
  if (ready) {
    return Promise.resolve();
  }
  if (!inflight) {
    inflight = tryRefreshRuntimeSettings()
      .then((ok) => {
        ready = ok;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
