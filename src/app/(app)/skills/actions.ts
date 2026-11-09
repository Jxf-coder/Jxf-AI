"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import { errorMessage, log } from "@/lib/logger";
import { PermissionDeniedError, toPermissionMessage } from "@/lib/permissions/guard";
import {
  SkillInputError,
  createSkill,
  deleteSkill,
  runPromptSkill,
  setSkillStatus,
  updateSkill,
  type SkillStatus,
} from "@/lib/skills";
import {
  confirmMetaDraft,
  disconnectMeta,
  dismissMetaDraft,
  revertMetaDraft,
  saveMetaConnection,
  syncMetaAds,
  type MetaSettings,
} from "@/lib/skills/meta-ads";
import {
  createDistributeAccount,
  createDistributeGroup,
  createDistributeJob,
  deleteDistributeGroup,
  retryDistributeJob,
  rotateRunnerToken,
} from "@/lib/skills/distribute";

export interface SkillActionResult {
  ok: boolean;
  message: string;
  output?: string;
  data?: Record<string, unknown>;
}

async function contextOf() {
  const session = await requireSession();
  return resolveUserContext(session.userId);
}

function failure(action: string, error: unknown): SkillActionResult {
  if (error instanceof SkillInputError) {
    return { ok: false, message: error.message };
  }
  if (error instanceof PermissionDeniedError) {
    return { ok: false, message: toPermissionMessage(error) };
  }
  log("error", "skill_action_failed", { action, error: errorMessage(error) });
  return { ok: false, message: "操作失败，请稍后重试" };
}

function refresh(key?: string) {
  revalidatePath("/skills");
  if (key) revalidatePath(`/skills/${key}`);
}

export async function createSkillAction(input: {
  key: string;
  name: string;
  icon?: string;
  category?: string;
  summary?: string;
  hint?: string;
  promptBody?: string;
}): Promise<SkillActionResult> {
  try {
    const skill = await createSkill(await contextOf(), input);
    refresh();
    return { ok: true, message: `技能「${skill.name}」已注册`, data: { key: skill.key } };
  } catch (error) {
    return failure("create_skill", error);
  }
}

export async function updateSkillAction(
  key: string,
  input: {
    name?: string;
    icon?: string;
    category?: string;
    summary?: string;
    hint?: string;
    promptBody?: string;
  },
): Promise<SkillActionResult> {
  try {
    await updateSkill(await contextOf(), key, input);
    refresh(key);
    return { ok: true, message: "技能已更新" };
  } catch (error) {
    return failure("update_skill", error);
  }
}

export async function setSkillStatusAction(
  key: string,
  status: SkillStatus,
): Promise<SkillActionResult> {
  try {
    await setSkillStatus(await contextOf(), key, status);
    refresh(key);
    return { ok: true, message: status === "retired" ? "技能已停用" : "技能状态已更新" };
  } catch (error) {
    return failure("set_skill_status", error);
  }
}

export async function runSkillAction(
  key: string,
  input: Record<string, string>,
): Promise<SkillActionResult> {
  try {
    const result = await runPromptSkill(await contextOf(), key, input);
    refresh(key);
    return { ok: true, message: "已生成结果并保存到执行记录", output: result.output };
  } catch (error) {
    return failure("run_skill", error);
  }
}

export async function deleteSkillAction(key: string): Promise<SkillActionResult> {
  try {
    await deleteSkill(await contextOf(), key);
    refresh();
    return { ok: true, message: "技能已删除" };
  } catch (error) {
    return failure("delete_skill", error);
  }
}

export async function saveMetaConnectionAction(input: {
  accountId: string;
  token: string;
  relayUrl?: string;
  relayToken?: string;
  settings?: Partial<MetaSettings>;
  verify?: boolean;
}): Promise<SkillActionResult> {
  try {
    const view = await saveMetaConnection(await contextOf(), input);
    refresh("meta-ads-operator");
    return {
      ok: true,
      message: view.connected ? "已连接广告帐户" : "连接已保存",
    };
  } catch (error) {
    return failure("save_meta_connection", error);
  }
}

export async function disconnectMetaAction(): Promise<SkillActionResult> {
  try {
    await disconnectMeta(await contextOf());
    refresh("meta-ads-operator");
    return { ok: true, message: "已断开广告帐户" };
  } catch (error) {
    return failure("disconnect_meta", error);
  }
}

export async function syncMetaAction(): Promise<SkillActionResult> {
  try {
    const result = await syncMetaAds(await contextOf());
    refresh("meta-ads-operator");
    return { ok: true, message: result.summary };
  } catch (error) {
    return failure("sync_meta", error);
  }
}

export async function confirmMetaDraftAction(draftId: string): Promise<SkillActionResult> {
  try {
    const message = await confirmMetaDraft(await contextOf(), draftId);
    refresh("meta-ads-operator");
    return { ok: true, message };
  } catch (error) {
    return failure("confirm_meta_draft", error);
  }
}

export async function dismissMetaDraftAction(draftId: string): Promise<SkillActionResult> {
  try {
    await dismissMetaDraft(await contextOf(), draftId);
    refresh("meta-ads-operator");
    return { ok: true, message: "已取消草稿" };
  } catch (error) {
    return failure("dismiss_meta_draft", error);
  }
}

export async function revertMetaDraftAction(draftId: string): Promise<SkillActionResult> {
  try {
    await revertMetaDraft(await contextOf(), draftId);
    refresh("meta-ads-operator");
    return { ok: true, message: "已生成反向草稿，确认后才会写入 Meta" };
  } catch (error) {
    return failure("revert_meta_draft", error);
  }
}

export async function createGroupAction(input: {
  name: string;
  laneCn?: string;
  laneOverseas?: string;
}): Promise<SkillActionResult> {
  try {
    await createDistributeGroup(await contextOf(), input);
    refresh("video-distribute");
    return { ok: true, message: "分组已创建" };
  } catch (error) {
    return failure("create_group", error);
  }
}

export async function deleteGroupAction(groupId: string): Promise<SkillActionResult> {
  try {
    await deleteDistributeGroup(await contextOf(), groupId);
    refresh("video-distribute");
    return { ok: true, message: "分组已删除" };
  } catch (error) {
    return failure("delete_group", error);
  }
}

export async function createAccountAction(input: {
  groupId: string;
  platform: string;
  displayName: string;
  hostname?: string;
}): Promise<SkillActionResult> {
  try {
    await createDistributeAccount(await contextOf(), input);
    refresh("video-distribute");
    return { ok: true, message: "账号已添加" };
  } catch (error) {
    return failure("create_account", error);
  }
}

export async function createJobAction(input: {
  title: string;
  body?: string;
  tags?: string[];
  platforms: string[];
  runAt?: string | null;
  aiGenerated?: boolean;
}): Promise<SkillActionResult> {
  try {
    const result = await createDistributeJob(await contextOf(), input);
    refresh("video-distribute");
    return { ok: true, message: "发布任务已入队", data: { jobId: result.jobId } };
  } catch (error) {
    return failure("create_job", error);
  }
}

export async function retryJobAction(jobId: string): Promise<SkillActionResult> {
  try {
    await retryDistributeJob(await contextOf(), jobId);
    refresh("video-distribute");
    return { ok: true, message: "任务已重新入队" };
  } catch (error) {
    return failure("retry_job", error);
  }
}

export async function rotateRunnerTokenAction(): Promise<SkillActionResult> {
  try {
    const result = await rotateRunnerToken(await contextOf());
    refresh("video-distribute");
    return {
      ok: true,
      message: "发布机令牌已生成，仅展示这一次",
      data: { token: result.token },
    };
  } catch (error) {
    return failure("rotate_runner_token", error);
  }
}
