/**
 * 智能截断：先抽关键段，再按「头 30% + 关键段 40% + 尾 30%」拼装。
 *
 * 约束：
 * - 禁止从中间粗暴切断，按行边界对齐；
 * - 相邻重复行折叠并标注次数，避免模板化日志灌满预算；
 * - 总上限按字符数（不是字节），中文不会因 UTF-8 膨胀而超限。
 */

export const DEFAULT_SOURCE_TEXT_LIMIT = 12_000;

const KEY_LINE_RE =
  /(error|exception|caused by|failed|failure|fatal|panic|traceback|stack|status\s*[=:]?\s*5\d\d|错误|失败|异常|超时|回滚|根因)/i;

const MARKER_RESERVE = 120;

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalChars: number;
  omittedChars: number;
}

/** 相邻完全相同的行折叠为「行  [xN]」；空行只保留一个 */
export function collapseRepeatedLines(lines: string[]): string[] {
  const result: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    let count = 1;
    while (index + count < lines.length && lines[index + count] === line) {
      count += 1;
    }
    if (count > 1 && line.trim().length > 0) {
      result.push(`${line}  [x${count}]`);
    } else {
      result.push(line);
    }
    index += count;
  }
  return result;
}

function lineSize(line: string): number {
  return line.length + 1;
}

function sumSize(lines: string[]): number {
  return lines.reduce((total, line) => total + lineSize(line), 0);
}

function countFromStart(lines: string[], budget: number): number {
  let used = 0;
  let count = 0;
  for (const line of lines) {
    const size = lineSize(line);
    if (used + size > budget) {
      break;
    }
    used += size;
    count += 1;
  }
  return count;
}

function countFromEnd(lines: string[], budget: number): number {
  let used = 0;
  let count = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const size = lineSize(lines[index]);
    if (used + size > budget) {
      break;
    }
    used += size;
    count += 1;
  }
  return count;
}

export function truncateSourceText(
  value: string,
  limit = DEFAULT_SOURCE_TEXT_LIMIT,
): TruncateResult {
  const text = String(value ?? "");
  if (text.length <= limit) {
    return { text, truncated: false, originalChars: text.length, omittedChars: 0 };
  }

  const lines = collapseRepeatedLines(text.split(/\r?\n/));
  const headBudget = Math.floor(limit * 0.3);
  const tailBudget = Math.floor(limit * 0.3);

  let headCount = countFromStart(lines, headBudget);
  let tailCount = countFromEnd(lines, tailBudget);
  if (headCount + tailCount > lines.length) {
    tailCount = Math.max(0, lines.length - headCount);
  }

  const head = lines.slice(0, headCount);
  const tail = tailCount > 0 ? lines.slice(lines.length - tailCount) : [];
  const middle = lines.slice(headCount, lines.length - tailCount);

  const keyBudget = Math.max(
    0,
    limit - sumSize(head) - sumSize(tail) - MARKER_RESERVE,
  );
  const key: string[] = [];
  let keyUsed = 0;
  for (const line of middle) {
    if (!KEY_LINE_RE.test(line)) {
      continue;
    }
    const size = lineSize(line);
    if (keyUsed + size > keyBudget) {
      break;
    }
    key.push(line);
    keyUsed += size;
  }

  const keptChars = sumSize(head) + sumSize(tail) + keyUsed;
  const omittedChars = Math.max(0, text.length - keptChars);

  const parts: string[] = [];
  parts.push(...head);
  if (key.length > 0) {
    parts.push(`[... omitted ${omittedChars} chars ...]`);
    parts.push(...key);
  }
  if (tail.length > 0) {
    parts.push(`[... omitted ${omittedChars} chars ...]`);
    parts.push(...tail);
  }

  let assembled = parts.join("\n");
  if (assembled.length > limit) {
    assembled = assembled.slice(0, limit);
  }

  return {
    text: assembled,
    truncated: true,
    originalChars: text.length,
    omittedChars,
  };
}
