/**
 * MCP 客户端标识：前后端共用，禁止引入任何 server-only 依赖。
 */
export type McpClientKey = "workbuddy" | "cursor" | "doubao" | "qwen" | "codex" | "grok";

export const MCP_CLIENT_KEYS: readonly McpClientKey[] = [
  "workbuddy",
  "cursor",
  "doubao",
  "qwen",
  "codex",
  "grok",
];

export const MCP_CLIENT_LABELS: Record<McpClientKey, string> = {
  workbuddy: "WorkBuddy",
  cursor: "Cursor",
  doubao: "豆包工作",
  qwen: "千问办公",
  codex: "Codex",
  grok: "Grok Bot",
};

export function normalizeMcpClient(value: unknown): McpClientKey | null {
  return typeof value === "string" && (MCP_CLIENT_KEYS as readonly string[]).includes(value)
    ? (value as McpClientKey)
    : null;
}
