/**
 * 经验沉淀策略的纯数据定义（无数据库依赖）。
 *
 * 客户端设置面与 worker 都要用同一份默认值与范围，放在这里可避免把
 * audit / pg 等仅服务端模块带进浏览器 bundle。
 *
 * 信号等级（minSignalLevel）：3=失败，2=退回/验收备注，1=主动复盘或普通文档。
 * 采集侧按 `来源信号等级 >= minSignalLevel` 判断是否入队。
 */

export interface ExperiencePolicy {
  minSourceChars: number;
  maxSourceChars: number;
  hourlyJobLimit: number;
  dailyCardLimit: number;
  maxCandidates: number;
  cooldownMinutes: number;
  dedupeWindowHours: number;
  minSignalLevel: number;
  autoCaptureSuccess: boolean;
  /** fast | pro */
  modelTier: string;
}

export type ExperiencePolicyNumericKey = Exclude<
  keyof ExperiencePolicy,
  "autoCaptureSuccess" | "modelTier"
>;

export const EXPERIENCE_MODEL_TIERS = ["fast", "pro"] as const;

export const EXPERIENCE_CHANNELS = [
  { key: "document", label: "文档" },
  { key: "skill", label: "技能" },
  { key: "pipeline", label: "产线" },
  { key: "review", label: "验收" },
  { key: "retro", label: "复盘" },
  { key: "connector", label: "连接器" },
  { key: "manual", label: "手动" },
] as const;

export type ExperienceChannelKey = (typeof EXPERIENCE_CHANNELS)[number]["key"];

export interface DepartmentChannelMatrix {
  departmentId: string;
  departmentName: string;
  /** channel -> enabled；没有配置行的通道默认为 true */
  channels: Record<string, boolean>;
}

export const EXPERIENCE_SIGNAL_LEVELS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "1 · 主动复盘 / 普通文档" },
  { value: 2, label: "2 · 退回 / 验收备注" },
  { value: 3, label: "3 · 仅失败" },
];

/** 越界 / 非数字等输入错误：前端可直接展示消息 */
export class PolicyInputError extends Error {}

export const DEFAULT_EXPERIENCE_POLICY: ExperiencePolicy = {
  minSourceChars: 200,
  maxSourceChars: 12000,
  hourlyJobLimit: 20,
  dailyCardLimit: 50,
  maxCandidates: 3,
  cooldownMinutes: 60,
  dedupeWindowHours: 24,
  minSignalLevel: 1,
  autoCaptureSuccess: false,
  modelTier: "fast",
};

export const EXPERIENCE_POLICY_LIMITS: Record<
  ExperiencePolicyNumericKey,
  { min: number; max: number; label: string }
> = {
  minSourceChars: { min: 20, max: 2000, label: "来源文本最短字数" },
  maxSourceChars: { min: 1000, max: 60000, label: "来源文本截断上限" },
  hourlyJobLimit: { min: 1, max: 500, label: "每小时入队上限" },
  dailyCardLimit: { min: 1, max: 1000, label: "每日产卡上限" },
  maxCandidates: { min: 1, max: 10, label: "每次提炼候选数" },
  cooldownMinutes: { min: 1, max: 1440, label: "冷却窗（分钟）" },
  dedupeWindowHours: { min: 1, max: 168, label: "精确去重窗口（小时）" },
  minSignalLevel: { min: 1, max: 3, label: "最小信号等级" },
};

export const EXPERIENCE_POLICY_NUMERIC_KEYS = Object.keys(
  EXPERIENCE_POLICY_LIMITS,
) as ExperiencePolicyNumericKey[];

/** 收敛到合法区间；越界直接报错而不是静默截断，避免用户以为已生效 */
export function normalizePolicy(input: ExperiencePolicy): ExperiencePolicy {
  const result: ExperiencePolicy = { ...DEFAULT_EXPERIENCE_POLICY };

  for (const key of EXPERIENCE_POLICY_NUMERIC_KEYS) {
    const limit = EXPERIENCE_POLICY_LIMITS[key];
    const value = Math.trunc(Number(input[key]));
    if (!Number.isFinite(value) || value < limit.min || value > limit.max) {
      throw new PolicyInputError(`${limit.label}必须在 ${limit.min} 到 ${limit.max} 之间`);
    }
    result[key] = value;
  }

  result.autoCaptureSuccess = Boolean(input.autoCaptureSuccess);

  const tier = String(input.modelTier ?? "").trim();
  if (!EXPERIENCE_MODEL_TIERS.includes(tier as (typeof EXPERIENCE_MODEL_TIERS)[number])) {
    throw new PolicyInputError("模型档位只支持 fast 或 pro");
  }
  result.modelTier = tier;

  if (result.minSourceChars >= result.maxSourceChars) {
    throw new PolicyInputError("来源文本最短字数必须小于截断上限");
  }
  return result;
}
