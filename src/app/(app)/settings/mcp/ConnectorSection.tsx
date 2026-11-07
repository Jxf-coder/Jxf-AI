"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { InlineMessage } from "@/components/knowledge/InlineMessage";
import {
  badge,
  btnBlue,
  btnGhost,
  card,
  cardDesc,
  cardHead,
  cardTitle,
  divider,
  emptyState,
  fieldLabel,
  input,
  linkBtn,
  meta,
} from "@/components/knowledge/tokens";
import type {
  McpServerCallView,
  McpServerView,
  McpToolSummary,
  McpTransport,
} from "@/lib/mcp/connectors";

import {
  callMcpServerToolAction,
  createMcpServerAction,
  refreshMcpServerToolsAction,
  toggleMcpServerAction,
  type McpActionResult,
} from "./actions";

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatTime(value: string | null): string {
  return value ? TIME_FORMAT.format(new Date(value)) : "—";
}

interface ConnectorSectionProps {
  servers: McpServerView[];
  calls: McpServerCallView[];
  toolsByServer: Record<string, McpToolSummary[]>;
  stdioCommands: string[];
}

export function ConnectorSection({
  servers,
  calls,
  toolsByServer,
  stdioCommands,
}: ConnectorSectionProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState(stdioCommands[0] ?? "");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [allowedToolsText, setAllowedToolsText] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("20000");
  const [rateLimit, setRateLimit] = useState("60");
  const [dailyQuota, setDailyQuota] = useState("0");

  const [openId, setOpenId] = useState<string | null>(null);
  const [callTool, setCallTool] = useState("");
  const [callArgs, setCallArgs] = useState("{}");

  function run(action: () => Promise<McpActionResult>, done?: () => void) {
    startTransition(async () => {
      const result = await action();
      setFailed(!result.ok);
      setMessage(result.message);
      if (result.ok) {
        done?.();
        router.refresh();
      }
    });
  }

  function submitCreate() {
    let args: string[] = [];
    if (transport === "stdio" && argsText.trim()) {
      const parsed = argsText
        .split(/\s+/)
        .map((item) => item.trim())
        .filter(Boolean);
      args = parsed;
    }
    const env: Record<string, string> = {};
    if (transport === "stdio" && envText.trim()) {
      for (const line of envText.split(/\r?\n/)) {
        const index = line.indexOf("=");
        if (index > 0) {
          env[line.slice(0, index).trim()] = line.slice(index + 1).trim();
        }
      }
    }

    run(
      () =>
        createMcpServerAction({
          name: name.trim(),
          transport,
          url: transport === "http" ? url.trim() : undefined,
          command: transport === "stdio" ? command.trim() : undefined,
          args,
          env,
          allowedTools: allowedToolsText
            .split(/[,，\n]/)
            .map((item) => item.trim())
            .filter(Boolean),
          timeoutMs: Number(timeoutMs) || 20000,
          rateLimitPerMin: Number(rateLimit) || 60,
          dailyQuota: Number(dailyQuota) || 0,
        }),
      () => {
        setCreating(false);
        setName("");
        setUrl("");
        setArgsText("");
        setEnvText("");
        setAllowedToolsText("");
      },
    );
  }

  return (
    <>
      {message ? (
        <InlineMessage tone={failed ? "error" : "info"} className="mb-0 mt-0">
          {message}
        </InlineMessage>
      ) : null}

      <div className={card}>
        <div className={cardHead}>
          <div>
            <h2 className={cardTitle}>外部连接器</h2>
            <p className={`${meta} mt-1`}>
              JXF 作为 MCP 客户端消费外部工具。http 连接器需通过 SSRF 校验，内网主机须加入
              MCP_TRUSTED_HOSTS；stdio 仅允许白名单命令。
            </p>
          </div>
          <button
            type="button"
            className={`${linkBtn} shrink-0 text-[11px]`}
            onClick={() => setCreating((value) => !value)}
          >
            {creating ? "收起" : "新建连接器"}
          </button>
        </div>

        {creating ? (
          <div className="grid gap-3 rounded-2xl bg-apple-canvas p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={fieldLabel}>名称</span>
                <input
                  className={input}
                  value={name}
                  maxLength={60}
                  placeholder="例如：内部工单系统"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="block">
                <span className={fieldLabel}>传输方式</span>
                <select
                  className={input}
                  value={transport}
                  onChange={(event) => setTransport(event.target.value as McpTransport)}
                >
                  <option value="http">HTTP（Streamable HTTP）</option>
                  <option value="stdio">stdio（本地进程）</option>
                </select>
              </label>
            </div>

            {transport === "http" ? (
              <label className="block">
                <span className={fieldLabel}>端点地址</span>
                <input
                  className={input}
                  value={url}
                  placeholder="https://mcp.example.com/mcp"
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
            ) : stdioCommands.length === 0 ? (
              <p className="text-[12px] leading-relaxed text-amber-600">
                stdio 已禁用：请先在 MCP_STDIO_ALLOWED_COMMANDS 配置允许的可执行文件（逗号分隔）。
              </p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className={fieldLabel}>可执行文件（白名单）</span>
                    <select
                      className={input}
                      value={command}
                      onChange={(event) => setCommand(event.target.value)}
                    >
                      {stdioCommands.map((item) => (
                        <option key={item} value={item}>
                          {item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className={fieldLabel}>参数（空格分隔）</span>
                    <input
                      className={input}
                      value={argsText}
                      placeholder="-y @modelcontextprotocol/server-filesystem /data"
                      onChange={(event) => setArgsText(event.target.value)}
                    />
                  </label>
                </div>
                <label className="block">
                  <span className={fieldLabel}>环境变量（每行 KEY=VALUE，可选）</span>
                  <textarea
                    className={`${input} min-h-[70px] resize-y font-mono text-[12px]`}
                    value={envText}
                    placeholder={"SHOP_API_KEY=xxx"}
                    onChange={(event) => setEnvText(event.target.value)}
                  />
                </label>
              </>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={fieldLabel}>允许工具（留空=全部）</span>
                <input
                  className={input}
                  value={allowedToolsText}
                  placeholder="search_tickets, get_ticket"
                  onChange={(event) => setAllowedToolsText(event.target.value)}
                />
              </label>
              <label className="block">
                <span className={fieldLabel}>超时（毫秒）</span>
                <input
                  type="number"
                  min={1000}
                  max={120000}
                  className={input}
                  value={timeoutMs}
                  onChange={(event) => setTimeoutMs(event.target.value)}
                />
              </label>
              <label className="block">
                <span className={fieldLabel}>每分钟调用上限</span>
                <input
                  type="number"
                  min={1}
                  max={600}
                  className={input}
                  value={rateLimit}
                  onChange={(event) => setRateLimit(event.target.value)}
                />
              </label>
              <label className="block">
                <span className={fieldLabel}>每日调用配额（0=不限）</span>
                <input
                  type="number"
                  min={0}
                  max={1000000}
                  className={input}
                  value={dailyQuota}
                  onChange={(event) => setDailyQuota(event.target.value)}
                />
              </label>
            </div>

            <div>
              <button
                type="button"
                className={btnBlue}
                disabled={pending || name.trim().length === 0}
                onClick={submitCreate}
              >
                {pending ? "创建中…" : "创建连接器"}
              </button>
            </div>
          </div>
        ) : null}

        <div className={divider} />

        {servers.length === 0 ? (
          <p className={emptyState}>还没有外部连接器。创建后可「探测工具」并测试调用。</p>
        ) : (
          <ul className="grid list-none gap-2 p-0">
            {servers.map((server) => {
              const open = openId === server.id;
              const serverTools = toolsByServer[server.id] ?? [];
              return (
                <li key={server.id} className="rounded-xl border border-hairline bg-white px-3 py-2.5">
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 text-left"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : server.id)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-zinc-900">
                          {server.name}
                        </span>
                        <span className={badge(server.enabled ? "ok" : "muted")}>
                          {server.enabled ? "启用中" : "已停用"}
                        </span>
                        <span className={badge("blue")}>{server.transport}</span>
                        <span className={`${meta} font-mono`}>{server.target}</span>
                      </span>
                      <span className={`${meta} mt-0.5 block`}>
                        {server.toolCount} 个工具 · 最近探测 {formatTime(server.lastCheckedAt)} ·
                        限流 {server.rateLimitPerMin}/分 · 配额{" "}
                        {server.dailyQuota > 0 ? `${server.dailyQuota}/日` : "不限"}
                      </span>
                      {server.lastError ? (
                        <span className={`${meta} mt-0.5 block text-rose-600`}>{server.lastError}</span>
                      ) : null}
                    </span>
                  </button>

                  {open ? (
                    <div className="mt-2 border-t border-hairline pt-2">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={`${btnGhost} !px-3 !py-1 text-[12px]`}
                          disabled={pending}
                          onClick={() => run(() => refreshMcpServerToolsAction(server.id))}
                        >
                          探测工具
                        </button>
                        <button
                          type="button"
                          className={`${btnGhost} !px-3 !py-1 text-[12px]`}
                          disabled={pending}
                          onClick={() => run(() => toggleMcpServerAction(server.id, !server.enabled))}
                        >
                          {server.enabled ? "停用" : "启用"}
                        </button>
                      </div>

                      {serverTools.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {serverTools.map((tool) => (
                            <button
                              key={tool.name}
                              type="button"
                              className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                                callTool === tool.name
                                  ? "border-apple-blue/20 bg-apple-blue-soft text-apple-blue"
                                  : "border-black/[0.06] bg-white text-zinc-600 hover:bg-apple-canvas"
                              }`}
                              title={tool.description}
                              onClick={() => {
                                setCallTool(tool.name);
                                setCallArgs("{}");
                              }}
                            >
                              {tool.name}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className={`${meta} mt-2`}>还没有工具缓存，点「探测工具」拉取。</p>
                      )}

                      <div className="mt-2 grid gap-2">
                        <input
                          className={input}
                          value={callTool}
                          placeholder="要调用的工具名"
                          onChange={(event) => setCallTool(event.target.value)}
                        />
                        <textarea
                          className={`${input} min-h-[70px] resize-y font-mono text-[12px]`}
                          value={callArgs}
                          placeholder='{"query":"..."}'
                          onChange={(event) => setCallArgs(event.target.value)}
                        />
                        <div>
                          <button
                            type="button"
                            className={`${btnBlue} !px-3 !py-1 text-[12px]`}
                            disabled={pending || callTool.trim().length === 0}
                            onClick={() =>
                              run(() => callMcpServerToolAction(server.id, callTool.trim(), callArgs))
                            }
                          >
                            {pending ? "调用中…" : "测试调用"}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {servers.length > 0 ? (
          <>
            <div className={divider} />
            <p className={`${meta} mb-2`}>最近调用</p>
            {calls.length === 0 ? (
              <p className={meta}>暂无调用记录。</p>
            ) : (
              <ul className="grid list-none gap-1 p-0">
                {calls.map((call) => (
                  <li key={call.id} className={`${meta} flex flex-wrap items-center gap-2`}>
                    <span className="font-mono">{formatTime(call.createdAt)}</span>
                    <span>{call.serverName}</span>
                    <span className="font-mono">{call.toolName}</span>
                    <span
                      className={badge(
                        call.status === "ok" ? "ok" : call.status === "denied" ? "warn" : "error",
                      )}
                    >
                      {call.status}
                    </span>
                    {call.durationMs ? <span>{call.durationMs}ms</span> : null}
                    {call.error ? <span className="text-rose-600">{call.error}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}
