"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import { errorMessage, log } from "@/lib/logger";
import { PermissionDeniedError, toPermissionMessage } from "@/lib/permissions/guard";
import { notifyPipelineFailure } from "@/lib/notifications/events";
import {
  isPipelineEventType,
  setPipelineEventSubscription,
  type PipelineEventType,
} from "@/lib/pipeline-events";
import { disableWebhook, rotateWebhookToken } from "@/lib/pipelines-webhook";
import {
  PipelineInputError,
  createPipeline,
  runPipeline,
  setPipelineEnabled,
  type CreatePipelineInput,
} from "@/lib/pipelines";

export interface PipelineActionResult {
  ok: boolean;
  message: string;
}

async function contextOf() {
  const session = await requireSession();
  return resolveUserContext(session.userId);
}

function failure(action: string, error: unknown): PipelineActionResult {
  if (error instanceof PipelineInputError) {
    return { ok: false, message: error.message };
  }
  if (error instanceof PermissionDeniedError) {
    return { ok: false, message: toPermissionMessage(error) };
  }
  log("error", "pipeline_action_failed", { action, error: errorMessage(error) });
  return { ok: false, message: "操作失败，请稍后重试" };
}

export async function createPipelineAction(
  input: CreatePipelineInput,
): Promise<PipelineActionResult> {
  try {
    await createPipeline(await contextOf(), input);
    revalidatePath("/pipelines");
    return { ok: true, message: "产线已创建，可点击「运行」派发第一步" };
  } catch (error) {
    return failure("create_pipeline", error);
  }
}

export async function runPipelineAction(pipelineId: string): Promise<PipelineActionResult> {
  try {
    const result = await runPipeline(await contextOf(), pipelineId);
    revalidatePath("/pipelines");
    revalidatePath("/ai-employees");
    if (result.failedStep) {
      await notifyPipelineFailure({
        pipelineName: result.pipelineName,
        step: result.failedStep,
        error: "首步派发失败（AI 员工未上线或授权已撤销）",
        runId: result.runId,
      });
      return {
        ok: false,
        message: `第一步「${result.failedStep}」派发失败，请检查 AI 员工是否在岗`,
      };
    }
    return {
      ok: true,
      message: "已派出第一步；后续步骤会在上一步完成后由 runner 自动推进",
    };
  } catch (error) {
    return failure("run_pipeline", error);
  }
}

export async function togglePipelineAction(
  pipelineId: string,
  enabled: boolean,
): Promise<PipelineActionResult> {
  try {
    await setPipelineEnabled(await contextOf(), pipelineId, enabled);
    revalidatePath("/pipelines");
    return { ok: true, message: enabled ? "产线已启用" : "产线已停用" };
  } catch (error) {
    return failure("toggle_pipeline", error);
  }
}

export interface WebhookActionResult extends PipelineActionResult {
  /** 仅在生成/重置成功时返回一次 */
  token?: string;
  webhookPath?: string;
}

export async function rotateWebhookAction(pipelineId: string): Promise<WebhookActionResult> {
  try {
    const result = await rotateWebhookToken(await contextOf(), pipelineId);
    revalidatePath("/pipelines");
    return {
      ok: true,
      message: `Webhook 已启用（令牌末 4 位 ${result.hint}），请立即保存：关闭后不再显示明文`,
      token: result.token,
      webhookPath: `/api/webhooks/pipelines/${pipelineId}`,
    };
  } catch (error) {
    return failure("rotate_webhook", error);
  }
}

export async function disableWebhookAction(pipelineId: string): Promise<PipelineActionResult> {
  try {
    await disableWebhook(await contextOf(), pipelineId);
    revalidatePath("/pipelines");
    return { ok: true, message: "Webhook 已停用，旧令牌立即失效" };
  } catch (error) {
    return failure("disable_webhook", error);
  }
}

export async function setEventSubscriptionAction(
  pipelineId: string,
  eventType: string,
  enabled: boolean,
): Promise<PipelineActionResult> {
  try {
    if (!isPipelineEventType(eventType)) {
      return { ok: false, message: "不支持的事件类型" };
    }
    await setPipelineEventSubscription(
      await contextOf(),
      pipelineId,
      eventType as PipelineEventType,
      enabled,
    );
    revalidatePath("/pipelines");
    return { ok: true, message: enabled ? "已订阅事件" : "已取消订阅" };
  } catch (error) {
    return failure("set_event_subscription", error);
  }
}
