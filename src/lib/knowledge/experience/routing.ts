/**
 * 目录语义路由（纯函数，可单测）。
 *
 * 优先级（从高到低）：
 *   1. 人工显式选择；
 *   2. 来源文档目录继承（03/04/05/06/07/08）；
 *   3. 来源通道（pipeline / review / skill / connector → 05；retro → 05 或 08）；
 *   4. 内容规则（关键词 + 类型打分）；
 *   5. 默认 02-cards（置信度刚好达阈值，不打扰）。
 *
 * 只有「多个目录同分」才标记 route_pending，要求人工裁决；
 * 无任何信号时按 02 落地，避免每张普通事实卡都被打回。
 */

import { DEFAULT_CARD_FOLDER, folderLabel, isFolderKey, type FolderKey } from "@/lib/knowledge/folders";

export const ROUTE_CONFIDENCE_THRESHOLD = 0.7;

export type RouteChannel =
  | "document"
  | "skill"
  | "pipeline"
  | "review"
  | "retro"
  | "connector"
  | "manual";

export interface RouteInput {
  channel: RouteChannel;
  kind: string;
  title: string;
  body: string;
  /** 人工显式选择：给了就直接采用，不再路由 */
  explicitFolder?: string | null;
  /** 来源文档目录，document 通道可继承 */
  sourceFolder?: string | null;
}

export interface RouteResult {
  folderKey: FolderKey;
  /** 系统建议目录；人工显式选择时为 null */
  suggestedFolder: FolderKey | null;
  confidence: number;
  reason: string;
  pending: boolean;
}

const INHERITABLE_FOLDERS: readonly FolderKey[] = [
  "03-standards",
  "04-cases",
  "05-distill",
  "06-templates",
  "07-training",
  "08-retro",
];

/** 关键词打分：高分优先，同分且目录不同才判冲突 */
const CONTENT_RULES: ReadonlyArray<{
  folder: FolderKey;
  weight: number;
  keywords: readonly string[];
}> = [
  {
    folder: "05-distill",
    weight: 2,
    keywords: ["失败", "教训", "踩坑", "根因", "经验", "改进", "最佳实践", "回滚"],
  },
  { folder: "05-distill", weight: 1, keywords: ["复盘", "原因", "超时"] },
  { folder: "04-cases", weight: 2, keywords: ["案例", "客户", "交付实例"] },
  { folder: "04-cases", weight: 1, keywords: ["项目复盘"] },
  { folder: "03-standards", weight: 2, keywords: ["规范", "标准", "制度", "红线", "合规", "sop"] },
  { folder: "03-standards", weight: 1, keywords: ["流程"] },
  { folder: "06-templates", weight: 2, keywords: ["模板", "话术", "清单", "脚本"] },
  { folder: "06-templates", weight: 1, keywords: ["工具"] },
  { folder: "07-training", weight: 2, keywords: ["培训", "新人", "教程", "课程", "手册", "考试"] },
  { folder: "08-retro", weight: 2, keywords: ["周报", "月报", "复盘会", "阶段总结"] },
];

function includesAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

export function contentTypeScores(input: Pick<RouteInput, "kind" | "title" | "body">): Map<FolderKey, number> {
  const text = `${input.title}\n${input.body}`.toLowerCase();
  const scores = new Map<FolderKey, number>();

  for (const rule of CONTENT_RULES) {
    if (!includesAny(text, rule.keywords)) {
      continue;
    }
    scores.set(rule.folder, (scores.get(rule.folder) ?? 0) + rule.weight);
  }

  if (input.kind === "case") {
    scores.set("04-cases", (scores.get("04-cases") ?? 0) + 2);
  }

  return scores;
}

function pickFolder(scores: Map<FolderKey, number>): {
  winners: FolderKey[];
  best: number;
} {
  let best = 0;
  const winners: FolderKey[] = [];
  for (const [folder, score] of scores) {
    if (score > best) {
      best = score;
      winners.length = 0;
      winners.push(folder);
    } else if (score === best) {
      winners.push(folder);
    }
  }
  return { winners, best };
}

export function routeFolder(input: RouteInput): RouteResult {
  if (isFolderKey(input.explicitFolder)) {
    return {
      folderKey: input.explicitFolder,
      suggestedFolder: null,
      confidence: 1,
      reason: "人工显式选择",
      pending: false,
    };
  }

  if (
    input.channel === "document" &&
    isFolderKey(input.sourceFolder) &&
    INHERITABLE_FOLDERS.includes(input.sourceFolder)
  ) {
    return {
      folderKey: input.sourceFolder,
      suggestedFolder: input.sourceFolder,
      confidence: 0.9,
      reason: `继承来源文档目录 ${folderLabel(input.sourceFolder)}`,
      pending: false,
    };
  }

  if (
    input.channel === "pipeline" ||
    input.channel === "skill" ||
    input.channel === "review" ||
    input.channel === "connector"
  ) {
    return {
      folderKey: "05-distill",
      suggestedFolder: "05-distill",
      confidence: 0.85,
      reason: `来源通道 ${input.channel}`,
      pending: false,
    };
  }

  if (input.channel === "retro") {
    const text = `${input.title}\n${input.body}`.toLowerCase();
    const isRetroReport = includesAny(text, ["周报", "月报", "复盘会", "阶段总结"]);
    const folder: FolderKey = isRetroReport ? "08-retro" : "05-distill";
    return {
      folderKey: folder,
      suggestedFolder: folder,
      confidence: 0.85,
      reason: "人工复盘",
      pending: false,
    };
  }

  const { winners, best } = pickFolder(contentTypeScores(input));
  if (best > 0 && winners.length === 1) {
    const folder = winners[0];
    return {
      folderKey: folder,
      suggestedFolder: folder,
      confidence: 0.8,
      reason: `内容规则命中 ${folderLabel(folder)}`,
      pending: false,
    };
  }
  if (winners.length > 1) {
    const labels = winners.map((folder) => folderLabel(folder)).join(" / ");
    return {
      folderKey: DEFAULT_CARD_FOLDER,
      suggestedFolder: null,
      confidence: 0.5,
      reason: `规则冲突：${labels}`,
      pending: true,
    };
  }

  return {
    folderKey: DEFAULT_CARD_FOLDER,
    suggestedFolder: DEFAULT_CARD_FOLDER,
    confidence: ROUTE_CONFIDENCE_THRESHOLD,
    reason: "默认知识卡片",
    pending: false,
  };
}
