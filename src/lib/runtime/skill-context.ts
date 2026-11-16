/**
 * 技能上下文装配（纯函数，无数据库依赖）。
 *
 * 受理 run 时把 AI 员工勾选的技能正文按固定预算拼成一段提示词，
 * 随 `runs.input.employee` 快照给 worker；worker 不直接读 skills 表。
 */

export interface SkillContextRow {
  key: string;
  name: string;
  version: number;
  status: string;
  prompt_body: string;
}

export type SkillSkipReason = "missing" | "inactive" | "empty" | "budget";

export interface SkillContextEntry {
  key: string;
  name: string;
  version: number;
  /** 实际注入的字符数（未注入为 0） */
  chars: number;
  injected: boolean;
  truncated: boolean;
  skippedReason: SkillSkipReason | null;
}

export interface SkillContext {
  /** 拼好的「可用技能」块；没有可注入技能时为空字符串 */
  prompt: string;
  entries: SkillContextEntry[];
  chars: number;
  truncated: boolean;
}

/** 单技能与总量上限：按字符计（中文近似 1 字符 ≈ 1 token） */
export const SKILL_CHAR_LIMITS = { perSkill: 3_000, total: 6_000 } as const;

export function buildSkillContext(
  keys: string[],
  rows: SkillContextRow[],
  limits: { perSkill: number; total: number } = SKILL_CHAR_LIMITS,
): SkillContext {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const seen = new Set<string>();
  const entries: SkillContextEntry[] = [];
  const blocks: string[] = [];
  let used = 0;
  let truncated = false;

  for (const key of keys) {
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const row = byKey.get(key);
    if (!row) {
      entries.push({
        key,
        name: key,
        version: 0,
        chars: 0,
        injected: false,
        truncated: false,
        skippedReason: "missing",
      });
      continue;
    }
    if (row.status !== "active") {
      entries.push({
        key,
        name: row.name,
        version: row.version,
        chars: 0,
        injected: false,
        truncated: false,
        skippedReason: "inactive",
      });
      continue;
    }

    const body = row.prompt_body.trim();
    if (!body) {
      entries.push({
        key,
        name: row.name,
        version: row.version,
        chars: 0,
        injected: false,
        truncated: false,
        skippedReason: "empty",
      });
      continue;
    }

    const remaining = limits.total - used;
    if (remaining <= 0) {
      truncated = true;
      entries.push({
        key,
        name: row.name,
        version: row.version,
        chars: 0,
        injected: false,
        truncated: true,
        skippedReason: "budget",
      });
      continue;
    }

    const allowed = Math.min(body.length, limits.perSkill, remaining);
    const text = body.slice(0, allowed);
    const cut = text.length < body.length;
    if (cut) {
      truncated = true;
    }
    blocks.push(`## ${row.name}（${row.key} · v${row.version}）\n${text}`);
    used += text.length;
    entries.push({
      key,
      name: row.name,
      version: row.version,
      chars: text.length,
      injected: true,
      truncated: cut,
      skippedReason: null,
    });
  }

  return {
    prompt: blocks.length > 0 ? ["【可用技能】", ...blocks].join("\n\n") : "",
    entries,
    chars: used,
    truncated,
  };
}
