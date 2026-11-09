"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  actions,
  badge,
  btnBlue,
  btnGhost,
  emptyState,
  fieldLabel,
  formGrid,
  input,
  linkBtn,
  meta,
  tabActive,
  tabBar,
  tabIdle,
} from "@/components/knowledge/tokens";
import { toast } from "@/components/ui/toast";
import type { McpToolApprovalView } from "@/lib/mcp/approvals";
import type {
  McpServerCallView,
  McpServerView,
  McpToolSummary,
} from "@/lib/mcp/connectors";
import { MCP_CLIENT_LABELS, type McpClientKey } from "@/lib/mcp/clients";
import type { McpMembershipCandidate, McpTokenView } from "@/lib/mcp/tokens";
import type { McpSkill, McpToolAction } from "@/lib/mcp/tools";
import type { PipelineEventBridgeView } from "@/lib/pipeline-events";

import {
  decideMcpToolApprovalAction,
  issueMcpTokenAction,
  type McpActionResult,
} from "./actions";
import { ConnectorSection } from "./ConnectorSection";
import { Drawer } from "./McpDrawer";
import { OutboundPanel } from "./OutboundPanel";
import { TokenManager } from "./TokenManager";
import { TokenRevealModal } from "./TokenRevealModal";

const APPROVAL_STATUS_LABEL: Record<McpToolApprovalView["status"], string> = {
  pending: "待审批",
  approved: "已批准",
  rejected: "已驳回",
  failed: "执行失败",
};

const APPROVAL_STATUS_TONE: Record<McpToolApprovalView["status"], "ok" | "muted" | "warn" | "error"> = {
  pending: "warn",
  approved: "ok",
  rejected: "muted",
  failed: "error",
};

const TOKEN_STATUS_LABEL: Record<McpTokenView["status"], string> = {
  active: "已连接",
  revoked: "已关闭",
  expired: "已过期",
};

const TOKEN_STATUS_TONE: Record<McpTokenView["status"], "ok" | "muted" | "warn"> = {
  active: "ok",
  revoked: "muted",
  expired: "warn",
};

const BRIDGE_EVENT_LABEL: Record<string, string> = {
  "knowledge.ingest_done": "知识库入库完成",
  "mcp.connector_changed": "MCP 连接器状态变更",
  "work_item.finished": "AI 员工任务结束",
};

const BRIDGE_STATUS_TONE: Record<string, "ok" | "warn" | "error"> = {
  processed: "ok",
  pending: "warn",
  failed: "error",
};

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatTime(value: string | null, empty = "—"): string {
  return value ? TIME_FORMAT.format(new Date(value)) : empty;
}

export interface McpToolOption {
  name: string;
  title: string;
  action: McpToolAction;
  skill: McpSkill;
}

interface McpClientProps {
  tokens: McpTokenView[];
  candidates: McpMembershipCandidate[];
  servers: McpServerView[];
  calls: McpServerCallView[];
  approvals: McpToolApprovalView[];
  toolsByServer: Record<string, McpToolSummary[]>;
  stdioCommands: string[];
  tools: McpToolOption[];
  endpoint: string;
  projectId: string;
  bridge: PipelineEventBridgeView;
}

type Tab = "inbound" | "outbound" | "bridge" | "tokens";
type DrawerKind =
  | "token"
  | "approvals"
  | "events"
  | "webhooks"
  | "subscriptions"
  | "new-bridge"
  | null;

export function McpClient({
  tokens,
  candidates,
  servers,
  calls,
  approvals,
  toolsByServer,
  stdioCommands,
  tools,
  endpoint,
  projectId,
  bridge,
}: McpClientProps) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("inbound");
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [connectorCreateSignal, setConnectorCreateSignal] = useState(0);

  const [pending, startTransition] = useTransition();
  const [issuedToken, setIssuedToken] = useState("");

  const [name, setName] = useState("");
  const [membershipId, setMembershipId] = useState(candidates[0]?.membershipId ?? "");
  const [client, setClient] = useState<McpClientKey | "">("");
  const [allowWrite, setAllowWrite] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");

  const readOnlyToolNames = tools.filter((tool) => tool.action === "read").map((tool) => tool.name);
  const writeToolNames = tools.filter((tool) => tool.action === "write").map((tool) => tool.name);
  const [selectedTools, setSelectedTools] = useState<string[]>(readOnlyToolNames);

  function toggleTool(tool: McpToolOption) {
    const next = selectedTools.includes(tool.name)
      ? selectedTools.filter((item) => item !== tool.name)
      : [...selectedTools, tool.name];
    setSelectedTools(next);
    // 写类工具勾选状态与「允许写类工具」联动
    if (tool.action === "write") {
      setAllowWrite(next.some((item) => writeToolNames.includes(item)));
    }
  }

  function toggleAllowWrite(checked: boolean) {
    setAllowWrite(checked);
    setSelectedTools((prev) =>
      checked
        ? Array.from(new Set([...prev, ...writeToolNames]))
        : prev.filter((item) => !writeToolNames.includes(item)),
    );
  }

  function run(action: () => Promise<McpActionResult>, done?: (result: McpActionResult) => void) {
    startTransition(async () => {
      const result = await action();
      toast(result.message, result.ok ? "success" : "error");
      if (result.ok) {
        done?.(result);
        router.refresh();
      }
    });
  }

  const needle = query.trim().toLowerCase();
  const matches = (...values: Array<string | null | undefined>) =>
    needle.length === 0 || values.some((value) => (value ?? "").toLowerCase().includes(needle));

  const visibleApprovals = approvals.filter((approval) =>
    matches(approval.toolName, approval.userName, approval.departmentName, approval.tokenName),
  );
  const inboundServers = servers.filter(
    (server) => server.direction === "inbound" && matches(server.name, server.nodeKey, server.target),
  );
  const visibleCalls = calls.filter((call) => matches(call.serverName, call.toolName));
  const visibleBridge = {
    events: bridge.events.filter((event) => matches(event.eventType, BRIDGE_EVENT_LABEL[event.eventType])),
    subscriptions: bridge.subscriptions.filter((item) => matches(item.pipelineName, item.eventType)),
    webhooks: bridge.webhooks.filter((item) => matches(item.name)),
  };

  const pendingApprovals = approvals.filter((item) => item.status === "pending").length;
  const inboundOnline = inboundServers.filter(
    (server) => server.enabled && server.healthStatus === "healthy",
  ).length;
  const activeTokens = tokens.filter((token) => token.status === "active");
  const pendingEvents = bridge.events.filter((event) => event.status === "pending").length;

  const statusLabel =
    tab === "inbound"
      ? `接入 ${inboundServers.length} · 在线 ${inboundOnline}`
      : tab === "outbound"
        ? activeTokens.length > 0
          ? `已签发 ${activeTokens.length} 个令牌`
          : "未连接"
        : tab === "tokens"
          ? `令牌 ${tokens.length} · 生效 ${activeTokens.length}`
          : pendingEvents > 0
            ? `待处理事件 ${pendingEvents}`
            : "事件总线正常";
  const statusTone =
    tab === "inbound"
      ? inboundServers.length - inboundOnline > 0
        ? "warn"
        : inboundOnline > 0
          ? "ok"
          : "muted"
      : tab === "outbound" || tab === "tokens"
        ? activeTokens.length > 0
          ? "ok"
          : "muted"
        : pendingEvents > 0
          ? "warn"
          : "ok";

  function openAdd() {
    if (tab === "bridge") {
      setDrawer("new-bridge");
    } else {
      setConnectorCreateSignal((value) => value + 1);
    }
  }

  function submitToken() {
    run(
      () =>
        issueMcpTokenAction({
          name: name.trim(),
          membershipId,
          client: client || null,
          skills: [],
          pipelines: [],
          tools: selectedTools,
          allowWrite,
          approvalTools: [],
          channels: client ? [client] : [],
          expiresAt: expiresAt ? `${expiresAt}T23:59:59+08:00` : null,
        }),
      (result) => {
        setIssuedToken(result.token ?? "");
        setDrawer(null);
        setName("");
        setClient("");
        setAllowWrite(false);
        setSelectedTools(readOnlyToolNames);
        setExpiresAt("");
      },
    );
  }

  return (
    <div className="mt-5 grid gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-hairline bg-white p-3 shadow-card">
        <div className={`${tabBar} !mt-0`}>
          {(
            [
              { id: "inbound" as const, label: "接入", count: inboundServers.length },
              { id: "outbound" as const, label: "接出", count: activeTokens.length },
              { id: "bridge" as const, label: "订阅桥", count: bridge.events.length },
              { id: "tokens" as const, label: "令牌管理", count: tokens.length },
            ]
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              className={tab === item.id ? tabActive : tabIdle}
              onClick={() => setTab(item.id)}
            >
              {item.label}
              <span className="ml-1 text-[10px] opacity-60">{item.count}</span>
            </button>
          ))}
        </div>

        <input
          className={`${input} max-w-xs`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            tab === "inbound"
              ? "搜索接入节点"
              : tab === "outbound"
                ? "搜索客户端 / 令牌"
                : tab === "tokens"
                  ? "搜索令牌名称 / 客户端"
                  : "搜索事件 / 产线"
          }
        />

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className={badge(statusTone)}>{statusLabel}</span>
          {tab === "inbound" ? (
            <button
              type="button"
              className={btnBlue}
              onClick={() => setConnectorCreateSignal((value) => value + 1)}
            >
              + 新增接入
            </button>
          ) : tab === "outbound" ? (
            <>
              <button
                type="button"
                className={btnGhost}
                onClick={() => setDrawer("approvals")}
              >
                写工具审批{pendingApprovals > 0 ? ` ${pendingApprovals}` : ""}
              </button>
              <button type="button" className={btnBlue} onClick={() => setDrawer("token")}>
                签发令牌
              </button>
            </>
          ) : tab === "tokens" ? (
            <button type="button" className={btnBlue} onClick={() => setDrawer("token")}>
              签发令牌
            </button>
          ) : (
            <Link href="/pipelines" className={btnBlue}>
              去产线配置
            </Link>
          )}
        </div>
      </div>

      {tab === "inbound" ? (
        <ConnectorSection
          servers={inboundServers}
          calls={visibleCalls}
          toolsByServer={toolsByServer}
          stdioCommands={stdioCommands}
          direction="inbound"
          createSignal={connectorCreateSignal}
        />
      ) : null}

      {tab === "outbound" ? (
        <OutboundPanel tokens={tokens} endpoint={endpoint} projectId={projectId} />
      ) : null}

      {tab === "tokens" ? <TokenManager tokens={tokens} query={query} /> : null}

      {tab === "bridge" ? (
        <div className="grid gap-3">
          <BridgeNodeCard
            title="内部事件总线"
            status={pendingEvents > 0 ? `待处理 ${pendingEvents}` : "正常"}
            tone={pendingEvents > 0 ? "warn" : "ok"}
            description="知识入库、MCP 状态变更、AI 员工任务结束写入事件流，runner 按订阅触发产线。"
            onRefresh={() => router.refresh()}
            onOpen={() => setDrawer("events")}
          />
          <BridgeNodeCard
            title="外部 Webhook"
            status={`${visibleBridge.webhooks.length} 条产线`}
            tone={visibleBridge.webhooks.length > 0 ? "ok" : "muted"}
            description="每条产线可生成独立令牌入口；外部系统 POST 后以产线发起人身份运行。"
            onRefresh={() => router.refresh()}
            onOpen={() => setDrawer("webhooks")}
          />
          <BridgeNodeCard
            title="订阅关系"
            status={`${visibleBridge.subscriptions.length} 条`}
            tone={visibleBridge.subscriptions.length > 0 ? "ok" : "muted"}
            description="产线按事件类型订阅；未订阅的事件不会触发产线。"
            onRefresh={() => router.refresh()}
            onOpen={() => setDrawer("subscriptions")}
          />
        </div>
      ) : null}

      {tab === "inbound" || tab === "bridge" ? (
        <div className="flex justify-center">
          <button type="button" className={btnGhost} onClick={openAdd}>
            {tab === "inbound" ? "+ 新增接入" : "+ 新增订阅桥"}
          </button>
        </div>
      ) : null}

      {drawer === "token" ? (
        <Drawer title="签发 MCP 令牌" onClose={() => setDrawer(null)}>
          <div className="rounded-xl bg-apple-canvas px-3.5 py-2.5">
            <p className={fieldLabel}>对外端点</p>
            <p className="break-all font-mono text-[12px] text-zinc-700">{endpoint}</p>
            <p className={`${meta} mt-1`}>
              请求头 <code className="font-mono">Authorization: Bearer &lt;token&gt;</code> ·
              Streamable HTTP（无会话）
            </p>
          </div>

          <div className="mt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className={fieldLabel}>可用工具</p>
              <span className={meta}>
                已选 {selectedTools.length} / {tools.length}
              </span>
            </div>
            <ul className="mt-1.5 grid list-none gap-1.5 p-0 sm:grid-cols-2">
              {tools.map((tool) => {
                const checked = selectedTools.includes(tool.name);
                return (
                  <li key={tool.name}>
                    <label
                      className={`flex cursor-pointer items-start gap-2 rounded-xl px-3 py-2 text-[12px] transition-colors ${
                        checked
                          ? "bg-apple-blue-soft text-apple-blue"
                          : "bg-apple-canvas text-zinc-600 hover:bg-[#eef0f4]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={checked}
                        onChange={() => toggleTool(tool)}
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">{tool.title}</span>
                        <span className={`${meta} block break-all font-mono`}>
                          {tool.name} · {tool.action === "write" ? "写类" : "只读"}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <p className={`${meta} mt-1.5`}>
              默认仅勾选只读工具；未勾选的工具不会出现在外部客户端的 tools/list
              中，也无法被调用，至少保留一个工具。
            </p>
          </div>

          {candidates.length === 0 ? (
            <p className={`${emptyState} mt-4`}>当前没有可用的在岗任用，无法签发令牌。</p>
          ) : (
            <form
              className="mt-4 grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                submitToken();
              }}
            >
              <div className={formGrid}>
                <label className="block">
                  <span className={fieldLabel}>令牌名称</span>
                  <input
                    className={input}
                    value={name}
                    maxLength={60}
                    required
                    placeholder="例如：飞书机器人 · 销售部"
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className="block">
                  <span className={fieldLabel}>绑定任用</span>
                  <select
                    className={input}
                    value={membershipId}
                    onChange={(event) => setMembershipId(event.target.value)}
                  >
                    {candidates.map((candidate) => (
                      <option key={candidate.membershipId} value={candidate.membershipId}>
                        {candidate.userName ?? candidate.userId} · {candidate.departmentName} ·{" "}
                        {candidate.title || candidate.level}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className={formGrid}>
                <label className="block">
                  <span className={fieldLabel}>客户端（用于连接状态）</span>
                  <select
                    className={input}
                    value={client}
                    onChange={(event) => setClient(event.target.value as McpClientKey | "")}
                  >
                    <option value="">不指定</option>
                    {(Object.keys(MCP_CLIENT_LABELS) as McpClientKey[]).map((key) => (
                      <option key={key} value={key}>
                        {MCP_CLIENT_LABELS[key]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className={fieldLabel}>过期时间（可选）</span>
                  <input
                    type="date"
                    className={input}
                    value={expiresAt}
                    onChange={(event) => setExpiresAt(event.target.value)}
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-end gap-4">
                <label className="flex items-center gap-2 pb-2 text-[13px] text-zinc-700">
                  <input
                    type="checkbox"
                    checked={allowWrite}
                    onChange={(event) => toggleAllowWrite(event.target.checked)}
                  />
                  允许写类工具
                </label>
                <button
                  type="submit"
                  className={btnBlue}
                  disabled={
                    pending ||
                    name.trim().length === 0 ||
                    membershipId.length === 0 ||
                    selectedTools.length === 0
                  }
                >
                  {pending ? "签发中…" : "签发令牌"}
                </button>
              </div>
            </form>
          )}

          <div className="mt-6 border-t border-hairline pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className={fieldLabel}>最新签发</p>
              <button
                type="button"
                className={`${linkBtn} text-[11px]`}
                onClick={() => {
                  setDrawer(null);
                  setTab("tokens");
                }}
              >
                进入令牌管理 &gt;&gt;
              </button>
            </div>
            {tokens.length === 0 ? (
              <p className={emptyState}>还没有令牌。</p>
            ) : (
              <ul className="grid list-none gap-1.5 p-0">
                {tokens.slice(0, 6).map((token) => (
                  <li key={token.id} className="rounded-lg bg-apple-canvas px-2.5 py-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[12px] font-medium text-zinc-900">{token.name}</span>
                      <span className={badge(TOKEN_STATUS_TONE[token.status])}>
                        {TOKEN_STATUS_LABEL[token.status]}
                      </span>
                      {token.client ? (
                        <span className={badge("muted")}>{MCP_CLIENT_LABELS[token.client]}</span>
                      ) : null}
                    </div>
                    <p className={`${meta} mt-0.5`}>
                      {token.userName ?? "已移除"} · {token.departmentName ?? "—"} ·{" "}
                      {token.scope.allowWrite ? "含写工具" : "只读"} ·{" "}
                      {formatTime(token.createdAt)} → {formatTime(token.expiresAt, "长期")}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Drawer>
      ) : null}

      {drawer === "approvals" ? (
        <Drawer title="写工具审批" onClose={() => setDrawer(null)} wide>
          <p className={`${meta} mb-3`}>
            带审批要求的写类工具不会直接执行；批准后按令牌绑定的任用身份执行，结果留档。
          </p>
          {visibleApprovals.length === 0 ? (
            <p className={emptyState}>还没有审批单。</p>
          ) : (
            <ul className="grid list-none gap-2 p-0">
              {visibleApprovals.map((approval) => (
                <li key={approval.id} className="rounded-xl border border-hairline bg-white px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13px] text-zinc-900">{approval.toolName}</span>
                    <span className={badge(APPROVAL_STATUS_TONE[approval.status])}>
                      {APPROVAL_STATUS_LABEL[approval.status]}
                    </span>
                    <span className={`${meta} ml-auto`}>提交 {formatTime(approval.createdAt)}</span>
                  </div>
                  <p className={`${meta} mt-1`}>
                    {approval.userName ?? "已移除"} · {approval.departmentName ?? "—"} · 令牌{" "}
                    {approval.tokenName ?? "已移除"}
                  </p>
                  <p className="mt-1 break-all rounded-lg bg-apple-canvas px-2 py-1 font-mono text-[11px] text-zinc-600">
                    {approval.argumentsPreview}
                  </p>
                  {approval.resultPreview ? (
                    <p className={`${meta} mt-1 line-clamp-3 break-all`}>{approval.resultPreview}</p>
                  ) : null}
                  {approval.error ? (
                    <p className={`${meta} mt-1 text-rose-600`}>{approval.error}</p>
                  ) : null}
                  {approval.status === "pending" ? (
                    <div className={actions}>
                      <button
                        type="button"
                        className={btnBlue}
                        disabled={pending}
                        onClick={() => run(() => decideMcpToolApprovalAction(approval.id, "approve"))}
                      >
                        批准并执行
                      </button>
                      <button
                        type="button"
                        className={btnGhost}
                        disabled={pending}
                        onClick={() => run(() => decideMcpToolApprovalAction(approval.id, "reject"))}
                      >
                        驳回
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Drawer>
      ) : null}

      {drawer === "events" ? (
        <Drawer title="最近事件" onClose={() => setDrawer(null)} wide>
          {visibleBridge.events.length === 0 ? (
            <p className={emptyState}>还没有事件。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>事件类型</th>
                    <th>状态</th>
                    <th>尝试</th>
                    <th>时间</th>
                    <th>错误</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleBridge.events.map((event) => (
                    <tr key={event.id}>
                      <td className="text-[12px]">
                        {BRIDGE_EVENT_LABEL[event.eventType] ?? event.eventType}
                      </td>
                      <td>
                        <span className={badge(BRIDGE_STATUS_TONE[event.status] ?? "muted")}>
                          {event.status}
                        </span>
                      </td>
                      <td className="text-[12px] text-zinc-500">{event.attempts}</td>
                      <td className="text-[12px] text-zinc-500">{formatTime(event.createdAt)}</td>
                      <td className="max-w-[20rem] truncate text-[12px] text-rose-600">
                        {event.lastError ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Drawer>
      ) : null}

      {drawer === "webhooks" ? (
        <Drawer title="外部 Webhook" onClose={() => setDrawer(null)}>
          <p className={`${meta} mb-3`}>
            外部系统向产线 Webhook 地址 POST 后，以产线发起人身份运行；令牌只存哈希与末 4 位。
          </p>
          {visibleBridge.webhooks.length === 0 ? (
            <p className={emptyState}>还没有启用 Webhook 的产线。</p>
          ) : (
            <ul className="grid list-none gap-2 p-0">
              {visibleBridge.webhooks.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-2 rounded-xl bg-apple-canvas px-3 py-2">
                  <span className="text-[13px] text-zinc-800">{item.name}</span>
                  <span className={badge(item.enabled ? "ok" : "muted")}>
                    {item.enabled ? "启用" : "停用"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/pipelines" className={`${linkBtn} mt-3 inline-block text-[12px]`}>
            去产线生成 / 重置令牌 →
          </Link>
        </Drawer>
      ) : null}

      {drawer === "subscriptions" ? (
        <Drawer title="订阅关系" onClose={() => setDrawer(null)}>
          <p className={`${meta} mb-3`}>每条产线按事件类型订阅；未订阅的事件不会触发产线。</p>
          {visibleBridge.subscriptions.length === 0 ? (
            <p className={emptyState}>还没有事件订阅。</p>
          ) : (
            <ul className="grid list-none gap-2 p-0">
              {visibleBridge.subscriptions.map((item) => (
                <li
                  key={`${item.pipelineId}:${item.eventType}`}
                  className="flex flex-wrap items-center gap-1.5 rounded-xl bg-apple-canvas px-3 py-2"
                >
                  <span className="text-[13px] text-zinc-800">{item.pipelineName}</span>
                  <span className={badge("muted")}>
                    {BRIDGE_EVENT_LABEL[item.eventType] ?? item.eventType}
                  </span>
                  <span className={badge(item.enabled ? "ok" : "muted")}>
                    {item.enabled ? "启用" : "停用"}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/pipelines" className={`${linkBtn} mt-3 inline-block text-[12px]`}>
            去产线新增订阅 →
          </Link>
        </Drawer>
      ) : null}

      {drawer === "new-bridge" ? (
        <Drawer title="新增订阅桥" onClose={() => setDrawer(null)}>
          <p className={`${meta} mb-3`}>
            订阅桥在「自动化」产线里按事件类型配置：选择产线 → 勾选事件订阅 → 保存后即可由事件触发。
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/pipelines" className={btnBlue}>
              去产线配置
            </Link>
            <button type="button" className={btnGhost} onClick={() => setDrawer(null)}>
              稍后处理
            </button>
          </div>
        </Drawer>
      ) : null}

      {issuedToken ? (
        <TokenRevealModal token={issuedToken} onClose={() => setIssuedToken("")} />
      ) : null}
    </div>
  );
}

function BridgeNodeCard({
  title,
  status,
  tone,
  description,
  onRefresh,
  onOpen,
}: {
  title: string;
  status: string;
  tone: "ok" | "warn" | "muted";
  description: string;
  onRefresh: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="rounded-2xl border border-hairline bg-white p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-medium text-zinc-900">{title}</span>
            <span className={badge(tone)}>{status}</span>
          </div>
          <p className={`${meta} mt-1`}>{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" className={`${linkBtn} text-[12px]`} onClick={onRefresh}>
            刷新状态
          </button>
          <button type="button" className={btnGhost} onClick={onOpen}>
            查看
          </button>
        </div>
      </div>
    </div>
  );
}

