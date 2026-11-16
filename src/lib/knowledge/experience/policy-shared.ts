/**
 * 经验沉淀策略的纯数据定义（无数据库依赖）。
 *
 * 客户端设置面与 worker 都要用同一份默认值与范围，放在这里可避免把
 * audit / pg 等仅服务端模块带进浏览器 bundle。
 */

export interface ExperiencePolicy {
  minSourceChars: number;
  maxSourceChars: number;
  hourlyJobLimit: number;
  dailyCardLimit: number;
  maxCandidates: number;
}

/** 越界 / 非数字等输入错误：前端可直接展示消息 */
export class PolicyInputError extends Error {}

export const DEFAULT_EXPERIENCE_POLICY: ExperiencePolicy = {
  minSourceChars: 200,
  maxSourceChars: 12000,
  hourlyJobLimit: 20,
  dailyCardLimit: 50,
  maxCandidates: 3,
};

export const EXPERIENCE_POLICY_LIMITS: Record<
  keyof ExperiencePolicy,
  { min: number; max: number; label: string }
> = {
  minSourceChars: { min: 20, max: 2000, label: "来源文本最短字数" },
  maxSourceChars: { min: 1000, max: 60000, label: "来源文本截断上限" },
  hourlyJobLimit: { min: 1, max: 500, label: "每小时入队上限" },
  dailyCardLimit: { min: 1, max: 1000, label: "每日产卡上限" },
  maxCandidates: { min: 1, max: 10, label: "每次提炼候选数" },
};

/** 收敛到合法区间；越界直接报错而不是静默截断，避免用户以为已生效 */
export function normalizePolicy(input: ExperiencePolicy): ExperiencePolicy {
  const keys = Object.keys(EXPERIENCE_POLICY_LIMITS) as Array<keyof ExperiencePolicy>;
  const result = { ...DEFAULT_EXPERIENCE_POLICY };
  for (const key of keys) {
    const limit = EXPERIENCE_POLICY_LIMITS[key];
    const value = Math.trunc(Number(input[key]));
    if (!Number.isFinite(value) || value < limit.min || value > limit.max) {
      throw new PolicyInputError(`${limit.label}必须在 ${limit.min} 到 ${limit.max} 之间`);
    }
    result[key] = value;
  }
  if (result.minSourceChars >= result.maxSourceChars) {
    throw new PolicyInputError("来源文本最短字数必须小于截断上限");
  }
  return result;
}
