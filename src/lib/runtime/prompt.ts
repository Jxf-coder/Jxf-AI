/**
 * 系统提示装配（纯函数，无数据库依赖）。
 *
 * 顺序固定：身份/显式 systemPrompt → 技能块 → 会话记忆。
 * 记忆放最后，沿用「记忆优先遵守」的既有语义。
 */

export interface PromptEmployee {
  name?: string | null;
  persona?: string | null;
  systemPrompt?: string | null;
  /** 受理时按预算拼好的技能块 */
  skillsPrompt?: string | null;
}

export interface ComposeSystemPromptInput {
  kind: string;
  employee: PromptEmployee | null;
  memory: string;
}

export function composeSystemPrompt({ kind, employee, memory }: ComposeSystemPromptInput): string {
  const memoryBlock = memory.trim();
  const skillBlock = typeof employee?.skillsPrompt === "string" ? employee.skillsPrompt.trim() : "";

  if (employee?.systemPrompt && employee.systemPrompt.trim().length > 0) {
    return [employee.systemPrompt.trim(), skillBlock, memoryBlock]
      .filter((part) => part.length > 0)
      .join("\n\n");
  }

  const parts = ["你是企业内部的 AI 助手，回答必须基于已知信息，不确定就如实说明。"];
  if (kind === "task") {
    parts.push(
      "这是一项被派发的工作任务：请直接产出可验收的交付物，结构清晰、结论明确，不要反问用户；无法确定的信息要标注出来。",
    );
  }
  if (employee?.name) {
    parts.push(`你的身份是「${employee.name}」。`);
  }
  if (employee?.persona && employee.persona.trim().length > 0) {
    parts.push(`人格设定：${employee.persona.trim()}`);
  }
  if (skillBlock) {
    parts.push(skillBlock);
  }
  if (memoryBlock) {
    parts.push(memoryBlock);
  }
  return parts.join("\n");
}
