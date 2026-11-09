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
import { listToolApprovals } from "@/lib/mcp/approvals";
import {
  getMcpServerTools,
  listMcpServerCalls,
  listMcpServers,
  stdioAllowedCommands,
  type McpToolSummary,
} from "@/lib/mcp/connectors";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import { listMcpTokenCandidates, listMcpTokens } from "@/lib/mcp/tokens";
import { listPipelineEventBridge } from "@/lib/pipeline-events";

import { McpClient } from "./McpClient";

export default async function McpSettingsPage() {
  const session = await requireSession();
  const requestHeaders = await headers();
  const requestId = requestHeaders.get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const proto = requestHeaders.get("x-forwarded-proto") ?? "http";
  // 本地开发固定走 3000，避免 Endpoint 随 Host 头或代理变化
  const base =
    process.env.NODE_ENV === "production"
      ? `${proto}://${host}`
      : `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
  const endpoint = `${base}/api/mcp`;

  const header = (
    <header className={headerRow}>
      <div>
        <h1 className={pageTitle}>MCP 连接器</h1>
        <p className={pageSubtitle}>
          Agent 与外部工具的通道。接入：本系统接入的外部 MCP 服务；接出：本系统对外提供的 MCP 节点；订阅桥：事件订阅与触发。
          密钥只走服务端或 .env，不写进页面。
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

  const [tokens, candidates, servers, calls, approvals, bridge] = await Promise.all([
    listMcpTokens(context),
    listMcpTokenCandidates(context),
    listMcpServers(context),
    listMcpServerCalls(context, 10),
    listToolApprovals(context, 20),
    listPipelineEventBridge(context),
  ]);

  const toolsByServer: Record<string, McpToolSummary[]> = {};
  for (const server of servers) {
    toolsByServer[server.id] = await getMcpServerTools(context, server.id);
  }

  return (
    <section className={pageWrap}>
      {header}
      <McpClient
        tokens={tokens}
        candidates={candidates}
        servers={servers}
        calls={calls}
        approvals={approvals}
        toolsByServer={toolsByServer}
        stdioCommands={stdioAllowedCommands()}
        tools={MCP_TOOLS.map((tool) => ({
          name: tool.name,
          title: tool.title,
          action: tool.action,
          skill: tool.skill,
        }))}
        endpoint={endpoint}
        projectId={context.tenantId}
        bridge={bridge}
      />
    </section>
  );
}
