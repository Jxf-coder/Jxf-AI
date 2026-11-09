"use client";

import { useState } from "react";

import { badge, card, cardHead, cardTitle, input, linkBtn, meta } from "@/components/knowledge/tokens";
import { toast } from "@/components/ui/toast";
import type { McpClientKey } from "@/lib/mcp/clients";
import type { McpTokenView } from "@/lib/mcp/tokens";

interface ClientDef {
  key: McpClientKey;
  label: string;
  button: string;
}

const CLIENTS: ClientDef[] = [
  { key: "workbuddy", label: "WorkBuddy", button: "复制 WorkBuddy mcp.json" },
  { key: "cursor", label: "Cursor", button: "复制 Cursor mcp.json" },
  { key: "doubao", label: "豆包工作", button: "复制豆包工作 MCP 配置" },
  { key: "qwen", label: "千问办公", button: "复制千问办公 MCP 配置" },
  { key: "codex", label: "Codex", button: "复制 Codex config.toml" },
  { key: "grok", label: "Grok Bot", button: "复制 Grok Bot 连接器" },
];

const SERVER_NAME = "jxf-workbench";
const TOKEN_PLACEHOLDER = "<粘贴「签发令牌」生成的令牌>";

function buildConfig(def: ClientDef, baseUrl: string): string {
  const url = `${baseUrl}&client=${def.key}`;
  if (def.key === "codex") {
    return [
      `[mcp_servers.${SERVER_NAME}]`,
      'type = "streamable-http"',
      `url = "${url}"`,
      `headers = { Authorization = "Bearer ${TOKEN_PLACEHOLDER}" }`,
    ].join("\n");
  }
  return JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: {
          type: "streamable-http",
          url,
          headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` },
        },
      },
    },
    null,
    2,
  );
}

interface OutboundPanelProps {
  tokens: McpTokenView[];
  /** 已含协议与端口的 MCP 入口，如 http://127.0.0.1:3000/api/mcp */
  endpoint: string;
  projectId: string;
}

export function OutboundPanel({ tokens, endpoint, projectId }: OutboundPanelProps) {
  const baseUrl = `${endpoint}?projectId=${encodeURIComponent(projectId)}`;
  const activeTokens = tokens.filter((token) => token.status === "active");
  const connected = new Set(
    activeTokens.map((token) => token.client).filter((client): client is McpClientKey => !!client),
  );

  const [selected, setSelected] = useState<McpClientKey>("workbuddy");
  const [preview, setPreview] = useState(() => buildConfig(CLIENTS[0], baseUrl));

  async function copyConfig(def: ClientDef) {
    const text = buildConfig(def, baseUrl);
    setSelected(def.key);
    setPreview(text);
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${def.label} 配置`);
    } catch {
      toast(`已生成 ${def.label} 配置，请手动选中下方文本复制`, "error");
    }
  }

  return (
    <div className={card}>
      <div className={cardHead}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={cardTitle}>JXF AI 工作台（接出）</h2>
            <span className={badge(activeTokens.length > 0 ? "ok" : "muted")}>
              {activeTokens.length > 0 ? "已连接" : "未连接"}
            </span>
            <span className={`${meta} font-mono`}>jxf-out · streamable-http</span>
          </div>
          <p className={`${meta} mt-1`}>
            {CLIENTS.map(
              (client) => `${client.label} ${connected.has(client.key) ? "已连接" : "未连接"}`,
            ).join(" · ")}
          </p>
        </div>
        <span className={badge("blue")}>已签发 {activeTokens.length} 个令牌</span>
      </div>

      <div className="mt-3 grid gap-1 text-[13px] leading-relaxed text-zinc-600">
        <p>
          <span className="font-medium text-zinc-800">本机 Cursor</span>
          ：设置 → Tools &amp; MCP → Add new MCP server → 粘贴下方 mcp.json。
        </p>
        <p>
          <span className="font-medium text-zinc-800">本机 WorkBuddy</span>
          ：连接器 → 添加自定义 MCP → 选择 Streamable HTTP → 粘贴下方 mcp.json。
        </p>
        <p>
          <span className="font-medium text-zinc-800">本机 Codex CLI / 桌面</span>
          ：写入 ~/.codex/config.toml（下方 TOML），远程用 HTTP + Bearer。
        </p>
        <p>
          <span className="font-medium text-zinc-800">飞书「豆包工作」</span>
          ：连接器 → 添加自定义 MCP → Streamable HTTP，URL 用 &amp;client=doubao。
        </p>
        <p>
          <span className="font-medium text-zinc-800">千问办公</span>
          ：扩展 → 连接器 → 右上角 + → 粘贴下方 JSON。
        </p>
        <p>
          <span className="font-medium text-zinc-800">Grok Bot</span>
          ：grok.com/connectors → New Connector → Custom，URL 用 &amp;client=grok，
          Header 加 Authorization: Bearer 令牌。
        </p>
        <p className={`${meta} mt-1`}>
          哪个 Agent 用哪个 client，URL 就带 &amp;client=xxx；令牌在右上角「签发令牌」生成，
          密钥不要发到聊天里。
        </p>
      </div>

      <div className={`${meta} mt-3 break-all rounded-xl bg-apple-canvas px-3 py-2`}>
        HTTP 基础（再加 &amp;client=doubao&amp;qwen&amp;workbuddy&amp;codex&amp;grok）：
        <span className="font-mono text-zinc-700">{baseUrl}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        {CLIENTS.map((client) => (
          <button
            key={client.key}
            type="button"
            className={`${linkBtn} text-[12px] ${
              selected === client.key ? "text-apple-blue" : ""
            }`}
            onClick={() => copyConfig(client)}
          >
            {client.button}
          </button>
        ))}
      </div>

      <textarea
        className={`${input} mt-3 min-h-[220px] w-full resize-y font-mono text-[12px] leading-relaxed`}
        readOnly
        value={preview}
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
      />

      <p className={`${meta} mt-2`}>
        HTTP 页面可能限制剪贴板；若一键复制失败，请手动选中上面文本框内容复制。
      </p>
    </div>
  );
}
