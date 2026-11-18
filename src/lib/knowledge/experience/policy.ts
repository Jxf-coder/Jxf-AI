/**
 * 经验沉淀策略：按租户读写采集与提炼阈值。
 *
 * 设计边界：
 * - 读取统一走 app.experience_policy()，采集（web）与提炼（worker）拿到同一份值；
 * - 缺行或没有租户上下文时返回代码默认值，调用方不必判空；
 * - 写入只允许 L1，范围校验在函数与表约束里各兜一次；
 * - 纯数据定义（默认值 / 范围 / 校验）在 policy-shared.ts，客户端可直接引用。
 */

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";

import type { Queryable } from "./capture";
import {
  DEFAULT_EXPERIENCE_POLICY,
  EXPERIENCE_CHANNELS,
  normalizePolicy,
  PolicyInputError,
  type DepartmentChannelMatrix,
  type ExperienceChannelKey,
  type ExperiencePolicy,
} from "./policy-shared";

export {
  DEFAULT_EXPERIENCE_POLICY,
  EXPERIENCE_CHANNELS,
  EXPERIENCE_MODEL_TIERS,
  EXPERIENCE_POLICY_LIMITS,
  EXPERIENCE_SIGNAL_LEVELS,
  normalizePolicy,
  PolicyInputError,
  type DepartmentChannelMatrix,
  type ExperienceChannelKey,
  type ExperiencePolicy,
} from "./policy-shared";

/** 读取当前租户策略；无配置行时返回默认值 */
export async function readExperiencePolicy(client: Queryable): Promise<ExperiencePolicy> {
  const { rows } = await client.query(
    `select min_source_chars, max_source_chars, hourly_job_limit, daily_card_limit, max_candidates,
            cooldown_minutes, dedupe_window_hours, min_signal_level,
            auto_capture_success, model_tier
       from app.experience_policy()`,
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return { ...DEFAULT_EXPERIENCE_POLICY };
  }
  return {
    minSourceChars: toInt(row.min_source_chars, DEFAULT_EXPERIENCE_POLICY.minSourceChars),
    maxSourceChars: toInt(row.max_source_chars, DEFAULT_EXPERIENCE_POLICY.maxSourceChars),
    hourlyJobLimit: toInt(row.hourly_job_limit, DEFAULT_EXPERIENCE_POLICY.hourlyJobLimit),
    dailyCardLimit: toInt(row.daily_card_limit, DEFAULT_EXPERIENCE_POLICY.dailyCardLimit),
    maxCandidates: toInt(row.max_candidates, DEFAULT_EXPERIENCE_POLICY.maxCandidates),
    cooldownMinutes: toInt(row.cooldown_minutes, DEFAULT_EXPERIENCE_POLICY.cooldownMinutes),
    dedupeWindowHours: toInt(
      row.dedupe_window_hours,
      DEFAULT_EXPERIENCE_POLICY.dedupeWindowHours,
    ),
    minSignalLevel: toInt(row.min_signal_level, DEFAULT_EXPERIENCE_POLICY.minSignalLevel),
    autoCaptureSuccess: row.auto_capture_success === true,
    modelTier:
      row.model_tier === "pro" || row.model_tier === "fast"
        ? row.model_tier
        : DEFAULT_EXPERIENCE_POLICY.modelTier,
  };
}

/** 保存策略（仅 L1）；返回落库后的生效值 */
export async function saveExperiencePolicy(
  context: UserContext,
  input: ExperiencePolicy,
): Promise<ExperiencePolicy> {
  const policy = normalizePolicy(input);

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings");
    await client.query(
      "select app.save_experience_policy($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [
        policy.minSourceChars,
        policy.maxSourceChars,
        policy.hourlyJobLimit,
        policy.dailyCardLimit,
        policy.maxCandidates,
        policy.cooldownMinutes,
        policy.dedupeWindowHours,
        policy.minSignalLevel,
        policy.autoCaptureSuccess,
        policy.modelTier,
      ],
    );
    const saved = await readExperiencePolicy(client);
    await auditInTx(client, context, {
      actorUserId: context.userId,
      departmentId: context.activeDepartmentId,
      action: "knowledge.experience_policy_saved",
      targetType: "experience_policy",
      targetId: context.tenantId,
      payload: { ...saved },
    });
    return saved;
  });
}

export interface ChannelPolicyInput {
  departmentId: string;
  channel: ExperienceChannelKey;
  enabled: boolean;
}

/** 读取部门 × 通道开关矩阵（设置面用，仅 L1 能拿到全量部门） */
export async function readChannelPolicyMatrix(
  context: UserContext,
): Promise<DepartmentChannelMatrix[]> {
  return withUserContext(context, async (client) => {
    const departments = await client.query<{ id: string; name: string }>(
      `select id, name from departments order by name`,
    );
    const rows = await client.query<{
      department_id: string;
      channel: string;
      enabled: boolean;
    }>(`select department_id, channel, enabled from experience_channel_policies`);

    const saved = new Map<string, Record<string, boolean>>();
    for (const row of rows.rows) {
      const channels = saved.get(row.department_id) ?? {};
      channels[row.channel] = row.enabled;
      saved.set(row.department_id, channels);
    }

    return departments.rows.map((department) => {
      const channels: Record<string, boolean> = {};
      for (const channel of EXPERIENCE_CHANNELS) {
        channels[channel.key] = saved.get(department.id)?.[channel.key] ?? true;
      }
      return {
        departmentId: department.id,
        departmentName: department.name,
        channels,
      };
    });
  });
}

/** 批量保存部门 × 通道开关（仅 L1）；同一部门/通道重复提交时以最后一条为准 */
export async function saveChannelPolicies(
  context: UserContext,
  inputs: ChannelPolicyInput[],
): Promise<number> {
  const allowed = new Set<string>(EXPERIENCE_CHANNELS.map((channel) => channel.key));
  const deduped = new Map<string, ChannelPolicyInput>();
  for (const input of inputs) {
    if (!allowed.has(input.channel)) {
      throw new PolicyInputError(`未知的经验通道：${input.channel}`);
    }
    deduped.set(`${input.departmentId}|${input.channel}`, input);
  }
  const list = [...deduped.values()];
  if (list.length === 0) {
    return 0;
  }

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "platform:settings");
    for (const input of list) {
      await client.query("select app.save_experience_channel_policy($1, $2, $3)", [
        input.departmentId,
        input.channel,
        input.enabled,
      ]);
    }
    await auditInTx(client, context, {
      actorUserId: context.userId,
      departmentId: context.activeDepartmentId,
      action: "knowledge.experience_channels_saved",
      targetType: "experience_channel_policy",
      targetId: context.tenantId,
      payload: { count: list.length, changes: list },
    });
    return list.length;
  });
}

function toInt(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}
