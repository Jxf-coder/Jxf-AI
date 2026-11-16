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

import type { Queryable } from "./capture";
import {
  DEFAULT_EXPERIENCE_POLICY,
  normalizePolicy,
  type ExperiencePolicy,
} from "./policy-shared";

export {
  DEFAULT_EXPERIENCE_POLICY,
  EXPERIENCE_POLICY_LIMITS,
  normalizePolicy,
  PolicyInputError,
  type ExperiencePolicy,
} from "./policy-shared";

/** 读取当前租户策略；无配置行时返回默认值 */
export async function readExperiencePolicy(client: Queryable): Promise<ExperiencePolicy> {
  const { rows } = await client.query(
    `select min_source_chars, max_source_chars, hourly_job_limit, daily_card_limit, max_candidates
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
  };
}

/** 保存策略（仅 L1）；返回落库后的生效值 */
export async function saveExperiencePolicy(
  context: UserContext,
  input: ExperiencePolicy,
): Promise<ExperiencePolicy> {
  const policy = normalizePolicy(input);

  return withUserContext(context, async (client) => {
    await client.query("select app.save_experience_policy($1, $2, $3, $4, $5)", [
      policy.minSourceChars,
      policy.maxSourceChars,
      policy.hourlyJobLimit,
      policy.dailyCardLimit,
      policy.maxCandidates,
    ]);
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

function toInt(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}
