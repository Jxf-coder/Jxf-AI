import { headers } from "next/headers";

import {
  emptyState,
  headerRow,
  pageSubtitle,
  pageTitle,
  pageWrap,
} from "@/components/knowledge/tokens";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext } from "@/lib/db/user-context";
import {
  getMcpServerTools,
  listMcpServerCalls,
  listMcpServers,
  stdioAllowedCommands,
  type McpToolSummary,
} from "@/lib/mcp/connectors";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import { listMcpTokenCandidates, listMcpTokens } from "@/lib/mcp/tokens";

import { McpClient } from "./McpClient";

export default async function McpSettingsPage() {
  const session = await requireSession();
  const requestHeaders = await headers();
  const requestId = requestHeaders.get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const proto = requestHeaders.get("x-forwarded-proto") ?? "http";
  const endpoint = `${proto}://${host}/api/mcp`;

  const header = (
    <header className={headerRow}>
      <div>
        <h1 className={pageTitle}>MCP 连接</h1>
        <p className={pageSubtitle}>
          给外部客户端（IDE、机器人、自动化脚本）签发 MCP 令牌。令牌绑定成员任用，
          只能看到并使用 scope 内的工具，数据范围由该任用决定。
        </p>
      </div>
    </header>
  );

  if (context.accessLevel !== "L1") {
    return (
      <section className={pageWrap}>
        {header}
        <div className={`mt-5 ${emptyState}`}>只有 L1 可以管理 MCP 令牌。</div>
      </section>
    );
  }

  const [tokens, candidates, servers, calls] = await Promise.all([
    listMcpTokens(context),
    listMcpTokenCandidates(context),
    listMcpServers(context),
    listMcpServerCalls(context, 10),
  ]);

  const toolsByServer: Record<string, McpToolSummary[]> = {};
  for (const server of servers) {
    toolsByServer[server.id] = await getMcpServerTools(context, server.id);
  }

  return (
    <section className={pageWrap}>
      {header}
      <p className="mt-3 text-[11px] text-zinc-500">
        端点 <code className="font-mono">{endpoint}</code> · 传输：Streamable HTTP（JSON 响应，无会话）
      </p>
      <McpClient
        tokens={tokens}
        candidates={candidates}
        servers={servers}
        calls={calls}
        toolsByServer={toolsByServer}
        stdioCommands={stdioAllowedCommands()}
        tools={MCP_TOOLS.map((tool) => ({
          name: tool.name,
          title: tool.title,
          action: tool.action,
        }))}
        endpoint={endpoint}
      />
    </section>
  );
}
