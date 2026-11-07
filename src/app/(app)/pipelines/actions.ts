"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import { errorMessage, log } from "@/lib/logger";
import { PermissionDeniedError, toPermissionMessage } from "@/lib/permissions/guard";
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
    return { ok: true, message: "产线已创建，可点击「运行」批量派活" };
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
      return {
        ok: false,
        message: `已派出 ${result.workItemIds.length} 步；「${result.failedStep}」失败，后续步骤未执行`,
      };
    }
    return {
      ok: true,
      message: `已派出 ${result.workItemIds.length} 个任务，可在 AI 员工页跟踪与验收`,
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
