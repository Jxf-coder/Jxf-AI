/**
 * 学习提炼知识库：脱敏来源全文（只读）。
 *
 * 文件随镜像发布在 content/skills/learning-knowledge/，
 * 索引来自 INDEX.md 的「编号 | 标题 | 技能」表格。
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface LearningSourceSummary {
  code: string;
  title: string;
  skill: string;
}

export interface LearningSource extends LearningSourceSummary {
  content: string;
}

const SOURCE_DIR = path.join(process.cwd(), "content", "skills", "learning-knowledge");
const CODE_PATTERN = /^SRC-[A-Z0-9-]+$/;

async function readIndex(): Promise<Map<string, { title: string; skill: string }>> {
  const map = new Map<string, { title: string; skill: string }>();
  try {
    const text = await readFile(path.join(SOURCE_DIR, "INDEX.md"), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^\|\s*(SRC-[A-Z0-9-]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
      if (match) {
        map.set(match[1], { title: match[2].trim(), skill: match[3].trim() });
      }
    }
  } catch {
    // INDEX 缺失时用文件标题兜底
  }
  return map;
}

async function firstHeading(text: string): Promise<string> {
  const line = text.split("\n").find((item) => item.trim().startsWith("#"));
  return line ? line.replace(/^#+\s*/, "").trim() : "";
}

export async function listLearningSources(): Promise<LearningSourceSummary[]> {
  const index = await readIndex();
  let files: string[] = [];
  try {
    files = await readdir(SOURCE_DIR);
  } catch {
    return [];
  }
  const sources: LearningSourceSummary[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const code = file.slice(0, -3);
    if (!CODE_PATTERN.test(code)) continue;
    const meta = index.get(code);
    let title = meta?.title ?? "";
    if (!title) {
      const content = await readFile(path.join(SOURCE_DIR, file), "utf8");
      title = (await firstHeading(content)) || code;
    }
    sources.push({ code, title, skill: meta?.skill ?? "" });
  }
  return sources.sort((a, b) => a.code.localeCompare(b.code));
}

export async function getLearningSource(code: string): Promise<LearningSource | null> {
  const normalized = code.trim().toUpperCase();
  if (!CODE_PATTERN.test(normalized)) {
    return null;
  }
  try {
    const content = await readFile(path.join(SOURCE_DIR, `${normalized}.md`), "utf8");
    const index = await readIndex();
    const meta = index.get(normalized);
    const title = meta?.title || (await firstHeading(content)) || normalized;
    return { code: normalized, title, skill: meta?.skill ?? "", content };
  } catch {
    return null;
  }
}
