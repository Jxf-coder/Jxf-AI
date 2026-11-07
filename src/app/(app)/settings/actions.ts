"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import { errorMessage, log } from "@/lib/logger";
import { OpsTaskError, createOpsTask } from "@/lib/ops/tasks";
import type { OpsTaskKind, OpsTaskView } from "@/lib/ops/types";
import { PermissionDeniedError, toPermissionMessage } from "@/lib/permissions/guard";
import { testAiConnection, type AiTestResult } from "@/lib/settings/ai";
import { refreshRuntimeSettings } from "@/lib/settings/runtime-server";
import {
  saveAiSettings,
  saveAuditRetention,
  saveBranding,
  SettingsInputError,
  type BrandingSettings,
} from "@/lib/settings/store";

export interface SettingsActionResult {
  ok: boolean;
  message: string;
  keyConfigured?: boolean;
  keyHint?: string | null;
}

export interface SaveAiSettingsInput {
  enabled: "inherit" | "on" | "off";
  baseUrl: string;
  modelPro: string;
  modelFlash: string;
  /** 空字符串 = 保留已保存 Key；与 CLEAR_API_KEY 一致时清除 */
  apiKey: string;
}

async function contextOf() {
  const session = await requireSession();
  return resolveUserContext(session.userId);
}

function failure(action: string, error: unknown): SettingsActionResult {
  if (error instanceof SettingsInputError) {
    return { ok: false, message: error.message };
  }
  if (error instanceof PermissionDeniedError) {
    return { ok: false, message: toPermissionMessage(error) };
  }
  log("error", "settings_action_failed", { action, error: errorMessage(error) });
  return { ok: false, message: "保存失败，请稍后重试" };
}

export async function saveBrandingAction(input: BrandingSettings): Promise<SettingsActionResult> {
  try {
    await saveBranding(await contextOf(), input);
    revalidatePath("/", "layout");
    return { ok: true, message: "品牌已保存：全站主题与站点名称即时生效" };
  } catch (error) {
    return failure("save_branding", error);
  }
}

export async function saveAiSettingsAction(input: SaveAiSettingsInput): Promise<SettingsActionResult> {
  try {
    const saved = await saveAiSettings(await contextOf(), {
      enabled: input.enabled === "inherit" ? null : input.enabled === "on",
      baseUrl: input.baseUrl,
      modelPro: input.modelPro,
      modelFlash: input.modelFlash,
      apiKey: input.apiKey,
    });
    await refreshRuntimeSettings();
    revalidatePath("/settings");

    const keyState = saved.keyConfigured
      ? `已保存 Key ${saved.keyHint ?? ""}`.trim()
      : "未配置 Key";
    return {
      ok: true,
      message: `模型配置已保存并热生效（${keyState}）；Worker 需重启后加载新配置`,
      keyConfigured: saved.keyConfigured,
      keyHint: saved.keyHint,
    };
  } catch (error) {
    return failure("save_ai", error);
  }
}

export async function saveAuditRetentionAction(days: number | null): Promise<SettingsActionResult> {
  try {
    await saveAuditRetention(await contextOf(), days);
    revalidatePath("/settings");
    return {
      ok: true,
      message: days === null ? "已恢复默认留存（365 天）" : `审计留存已设为 ${days} 天`,
    };
  } catch (error) {
    return failure("save_audit_retention", error);
  }
}

export async function testAiConnectionAction(): Promise<AiTestResult> {
  try {
    return await testAiConnection(await contextOf());
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return { ok: false, message: toPermissionMessage(error) };
    }
    log("error", "settings_ai_test_failed", { error: errorMessage(error) });
    return { ok: false, message: "测试失败，请稍后重试" };
  }
}

export interface OpsTaskActionResult {
  ok: boolean;
  message: string;
  task?: OpsTaskView;
}

const OPS_TASK_MESSAGES: Record<OpsTaskKind, string> = {
  backup: "备份任务已排队：宿主机 runner 执行后状态会自动刷新",
  restore_verify: "恢复演练任务已排队：将使用最近一次备份，不会覆盖生产库",
};

export async function createOpsTaskAction(
  kind: OpsTaskKind,
  cold = false,
): Promise<OpsTaskActionResult> {
  try {
    const task = await createOpsTask(await contextOf(), { kind, cold });
    revalidatePath("/settings");
    return { ok: true, message: OPS_TASK_MESSAGES[task.kind], task };
  } catch (error) {
    if (error instanceof OpsTaskError) {
      return { ok: false, message: error.message };
    }
    if (error instanceof PermissionDeniedError) {
      return { ok: false, message: toPermissionMessage(error) };
    }
    log("error", "settings_ops_task_failed", { kind, error: errorMessage(error) });
    return { ok: false, message: "任务创建失败，请稍后重试" };
  }
}

