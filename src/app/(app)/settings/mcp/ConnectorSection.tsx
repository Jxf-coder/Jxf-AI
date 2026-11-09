"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

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
import { toast } from "@/components/ui/toast";
import type {
  McpDirection,
  McpServerCallView,
  McpServerView,
  McpToolSummary,
  McpTransport,
} from "@/lib/mcp/connectors";

import {
  callMcpServerToolAction,
  createMcpServerAction,
  refreshMcpServerToolsAction,
  runMcpHealthCheckAction,
  toggleMcpServerAction,
  type McpActionResult,
} from "./actions";

const HEALTH_LABEL: Record<McpServerView["healthStatus"], string> = {
  unknown: "未体检",
  healthy: "健康",
  degraded: "降级",
  down: "熔断",
};

function healthTone(status: McpServerView["healthStatus"]) {
  if (status === "healthy") {
    return "ok" as const;
  }
  if (status === "down") {
    return "error" as const;
  }
  return status === "degraded" ? "warn" as const : "muted" as const;
}

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
  direction: McpDirection;
  /** 顶部「新增」信号：每次递增时展开创建表单 */
  createSignal?: number;
}

export function ConnectorSection({
  servers,
  calls,
  toolsByServer,
  stdioCommands,
  direction,
  createSignal = 0,
}: ConnectorSectionProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [creating, setCreating] = useState(false);
  const [nodeKey, setNodeKey] = useState("");
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [command, setCommand] = useState("npx");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [rolesText, setRolesText] = useState("");

  const [openId, setOpenId] = useState<string | null>(null);
  const [callTool, setCallTool] = useState("");
  const [callArgs, setCallArgs] = useState("{}");

  const lastSignal = useRef(createSignal);
  useEffect(() => {
    if (createSignal !== lastSignal.current) {
      lastSignal.current = createSignal;
      if (createSignal > 0) {
        setCreating(true);
      }
    }
  }, [createSignal]);

  const unhealthy = servers.filter(
    (server) => server.enabled && (server.healthStatus === "degraded" || server.healthStatus === "down"),
  );

  function run(action: () => Promise<McpActionResult>, done?: () => void) {
    startTransition(async () => {
      const result = await action();
      toast(result.message, result.ok ? "success" : "error");
      if (result.ok) {
        done?.();
        router.refresh();
      }
    });
  }

  function submitCreate() {
    const args = argsText
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);

    // 环境变量只登记名称；KEY=VALUE 形式也兼容，但值不落库（真实值走容器 env）
    const env: Record<string, string> = {};
    for (const token of envText.split(/[,，\s]+/)) {
      const item = token.trim();
      if (!item) {
        continue;
      }
      const index = item.indexOf("=");
      if (index > 0) {
        env[item.slice(0, index)] = item.slice(index + 1);
      } else {
        env[item] = "";
      }
    }

    run(
      () =>
        createMcpServerAction({
          nodeKey: nodeKey.trim() || name.trim(),
          name: name.trim(),
          direction,
          roles: rolesText
            .split(/[,，\n]/)
            .map((item) => item.trim())
            .filter(Boolean),
          transport,
          command: command.trim() || undefined,
          args,
          env,
        }),
      () => {
        setCreating(false);
        setNodeKey("");
        setName("");
        setCommand("npx");
        setArgsText("");
        setEnvText("");
        setRolesText("");
      },
    );
  }

  return (
    <>
      <div className={card}>
        <div className={cardHead}>
          <div>
            <h2 className={cardTitle}>
              {direction === "inbound" ? "接入节点" : "接出节点"}
            </h2>
            <p className={`${meta} mt-1`}>
              {direction === "inbound"
                ? "本系统连接的外部 MCP 服务。http 需通过 SSRF 校验，stdio 仅允许白名单命令。"
                : "本系统对外提供的 MCP 连接节点；细粒度令牌与审批请用右上角「签发令牌」。"
              }
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              className={`${linkBtn} text-[11px]`}
              onClick={() => run(() => runMcpHealthCheckAction())}
              disabled={pending}
            >
              批量体检
            </button>
          </div>
        </div>

        {unhealthy.length > 0 ? (
          <div className="mb-3 rounded-2xl border border-rose-100 bg-rose-50 px-4 py-3 text-[13px] leading-relaxed text-rose-600">
            异常连接器（{unhealthy.length}）：{unhealthy.map((server) => server.name).join("、")}。
            连续失败 ≥3 次会熔断，AI 员工运行时自动跳过；恢复后下次体检自动解除。
          </div>
        ) : null}

        {creating ? (
          <div className="fixed inset-0 z-50 flex justify-end">
            <button
              type="button"
              aria-label="关闭"
              className="absolute inset-0 bg-black/25"
              onClick={() => setCreating(false)}
            />
            <aside
              role="dialog"
              aria-modal="true"
              aria-label={direction === "inbound" ? "新增接入节点" : "新增接出节点"}
              className="relative h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-2xl"
            >
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold tracking-tight text-zinc-900">
                  {direction === "inbound" ? "新增接入节点" : "新增接出节点"}
                </h2>
                <button
                  type="button"
                  className={`${linkBtn} text-[12px]`}
                  onClick={() => setCreating(false)}
                >
                  关闭
                </button>
              </div>
              <div className="grid gap-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className={fieldLabel}>id（标识，小写）</span>
                    <input
                      className={input}
                      value={nodeKey}
                      maxLength={64}
                      placeholder="descript"
                      onChange={(event) => setNodeKey(event.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className={fieldLabel}>显示名</span>
                    <input
                      className={input}
                      value={name}
                      maxLength={60}
                      placeholder="Descript"
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                </div>

                <label className="block">
                  <span className={fieldLabel}>传输协议</span>
                  <select
                    className={input}
                    value={transport}
                    onChange={(event) => setTransport(event.target.value as McpTransport)}
                  >
                    <option value="stdio">stdio（本地进程）</option>
                    <option value="http">http（Streamable HTTP）</option>
                    <option value="sse">sse（Server-Sent Events）</option>
                  </select>
                </label>

                <label className="block">
                  <span className={fieldLabel}>command（启动命令）</span>
                  <input
                    className={input}
                    value={command}
                    list="mcp-stdio-commands"
                    placeholder="如 npx 或 node"
                    onChange={(event) => setCommand(event.target.value)}
                  />
                  <datalist id="mcp-stdio-commands">
                    {stdioCommands.map((item) => (
                      <option key={item} value={item} />
                    ))}
                  </datalist>
                  {transport === "stdio" && stdioCommands.length === 0 ? (
                    <span className="mt-1 block text-[12px] leading-relaxed text-amber-600">
                      stdio 已禁用：请先在 MCP_STDIO_ALLOWED_COMMANDS 配置允许的可执行文件（逗号分隔）。
                    </span>
                  ) : null}
                </label>

                <label className="block">
                  <span className={fieldLabel}>args（启动参数）</span>
                  <input
                    className={input}
                    value={argsText}
                    placeholder="空格分隔"
                    onChange={(event) => setArgsText(event.target.value)}
                  />
                  {transport !== "stdio" ? (
                    <span className="mt-1 block text-[12px] leading-relaxed text-zinc-400">
                      http / sse：第一个参数填端点地址，例如 https://mcp.example.com/mcp
                    </span>
                  ) : null}
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className={fieldLabel}>角色限制</span>
                    <input
                      className={input}
                      value={rolesText}
                      placeholder="逗号分隔；空=全角色"
                      onChange={(event) => setRolesText(event.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className={fieldLabel}>环境变量名</span>
                    <input
                      className={input}
                      value={envText}
                      placeholder="如 DESCRIPT_API_KEY"
                      onChange={(event) => setEnvText(event.target.value)}
                    />
                  </label>
                </div>
                <p className="-mt-1 text-[12px] leading-relaxed text-zinc-400">
                  环境变量多个用逗号分隔；只登记变量名，真实值从运行容器的环境变量读取，不落库。
                </p>

                <div>
                  <button
                    type="button"
                    className={btnBlue}
                    disabled={pending || name.trim().length === 0}
                    onClick={submitCreate}
                  >
                    {pending ? "保存中…" : "保存"}
                  </button>
                </div>
              </div>
            </aside>
          </div>
        ) : null}

        <div className={divider} />

        {servers.length === 0 ? (
          <p className={emptyState}>
            {direction === "inbound"
              ? "还没有接入节点。点底部「+ 新增接入」创建。"
              : "还没有接出节点。点底部「+ 新增接出」创建。"}
          </p>
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
                        <span className={badge(healthTone(server.healthStatus))}>
                          {HEALTH_LABEL[server.healthStatus]}
                        </span>
                        <span className={badge("blue")}>{server.transport}</span>
                        <span className={`${meta} font-mono`}>{server.target}</span>
                      </span>
                      <span className={`${meta} mt-0.5 block`}>
                        {server.toolCount} 个工具 · 最近探测 {formatTime(server.lastCheckedAt)} ·
                        限流 {server.rateLimitPerMin}/分 · 配额{" "}
                        {server.dailyQuota > 0 ? `${server.dailyQuota}/日` : "不限"}
                      </span>
                      <span className={`${meta} mt-0.5 block`}>
                        角色限制 {server.roles.length > 0 ? server.roles.join(" / ") : "全角色"}
                      </span>
                      <span className={`${meta} mt-0.5 block`}>
                        体检 {HEALTH_LABEL[server.healthStatus]} · 最近 {formatTime(server.healthCheckedAt)}
                        {server.healthLatencyMs !== null ? ` · ${server.healthLatencyMs}ms` : ""}
                        {server.healthConsecutiveFailures > 0
                          ? ` · 连续失败 ${server.healthConsecutiveFailures} 次`
                          : ""}
                      </span>
                      {server.healthLastError ? (
                        <span className={`${meta} mt-0.5 block text-rose-600`}>
                          {server.healthLastError}
                        </span>
                      ) : null}
                      {server.lastError ? (
                        <span className={`${meta} mt-0.5 block text-rose-600`}>{server.lastError}</span>
                      ) : null}
                    </span>
                  </button>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={`${linkBtn} text-[12px]`}
                      disabled={pending}
                      onClick={() => run(() => runMcpHealthCheckAction())}
                    >
                      刷新状态
                    </button>
                    <button
                      type="button"
                      className={`${linkBtn} text-[12px]`}
                      disabled={pending}
                      onClick={() => run(() => refreshMcpServerToolsAction(server.id))}
                    >
                      探测工具
                    </button>
                    <button
                      type="button"
                      className={btnGhost}
                      disabled={pending}
                      onClick={() => run(() => toggleMcpServerAction(server.id, !server.enabled))}
                    >
                      {server.enabled ? "关闭" : "启用"}
                    </button>
                  </div>

                  {open ? (
                    <div className="mt-2 border-t border-hairline pt-2">
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
