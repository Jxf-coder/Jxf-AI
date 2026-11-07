"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

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
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import type {
  McpServerCallView,
  McpServerView,
  McpToolSummary,
} from "@/lib/mcp/connectors";
import type { McpMembershipCandidate, McpTokenView } from "@/lib/mcp/tokens";
import type { McpToolAction } from "@/lib/mcp/tools";

import { issueMcpTokenAction, revokeMcpTokenAction, type McpActionResult } from "./actions";
import { ConnectorSection } from "./ConnectorSection";

const STATUS_LABEL: Record<McpTokenView["status"], string> = {
  active: "生效中",
  revoked: "已停用",
  expired: "已过期",
};

const STATUS_TONE: Record<McpTokenView["status"], "ok" | "muted" | "warn"> = {
  active: "ok",
  revoked: "muted",
  expired: "warn",
};

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatTime(value: string | null): string {
  return value ? TIME_FORMAT.format(new Date(value)) : "—";
}

export interface McpToolOption {
  name: string;
  title: string;
  action: McpToolAction;
}

interface McpClientProps {
  tokens: McpTokenView[];
  candidates: McpMembershipCandidate[];
  servers: McpServerView[];
  calls: McpServerCallView[];
  toolsByServer: Record<string, McpToolSummary[]>;
  stdioCommands: string[];
  tools: McpToolOption[];
  endpoint: string;
}

export function McpClient({
  tokens,
  candidates,
  servers,
  calls,
  toolsByServer,
  stdioCommands,
  tools,
  endpoint,
}: McpClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [issuedToken, setIssuedToken] = useState("");

  const [name, setName] = useState("");
  const [membershipId, setMembershipId] = useState(candidates[0]?.membershipId ?? "");
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [allowWrite, setAllowWrite] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");

  function run(action: () => Promise<McpActionResult>, done?: (result: McpActionResult) => void) {
    startTransition(async () => {
      const result = await action();
      setFailed(!result.ok);
      setMessage(result.message);
      if (result.ok) {
        done?.(result);
        router.refresh();
      }
    });
  }

  function toggleTool(toolName: string) {
    setSelectedTools((previous) =>
      previous.includes(toolName)
        ? previous.filter((item) => item !== toolName)
        : [...previous, toolName],
    );
  }

  return (
    <div className="mt-5 grid gap-4">
      {message ? (
        <InlineMessage tone={failed ? "error" : "info"} className="mb-0 mt-0">
          {message}
        </InlineMessage>
      ) : null}

      {issuedToken ? (
        <div className={card}>
          <div className={cardHead}>
            <h2 className={cardTitle}>新令牌（只显示一次）</h2>
            <button type="button" className={`${linkBtn} text-[11px]`} onClick={() => setIssuedToken("")}>
              我已保存
            </button>
          </div>
          <p className={cardDesc}>复制后请妥善保管；关闭后无法再次查看，只能吊销重签。</p>
          <input
            className={`${input} font-mono text-[12px]`}
            readOnly
            value={issuedToken}
            onFocus={(event) => event.currentTarget.select()}
          />
          <p className={`${meta} mt-2`}>
            用法：请求 <code className="font-mono">{endpoint}</code>，带上
            <code className="ml-1 font-mono">Authorization: Bearer &lt;token&gt;</code>。
          </p>
        </div>
      ) : null}

      <ConnectorSection
        servers={servers}
        calls={calls}
        toolsByServer={toolsByServer}
        stdioCommands={stdioCommands}
      />

      <div className={card}>
        <div className={cardHead}>
          <div>
            <h2 className={cardTitle}>签发 MCP 令牌</h2>
            <p className={`${meta} mt-1`}>
              令牌绑定成员任用：离岗、停用、过期或吊销后立即失效；数据范围按该任用计算。
            </p>
          </div>
        </div>

        {candidates.length === 0 ? (
          <p className={emptyState}>当前没有可用的在岗任用，无法签发令牌。</p>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              run(
                () =>
                  issueMcpTokenAction({
                    name: name.trim(),
                    membershipId,
                    tools: selectedTools,
                    allowWrite,
                    expiresAt: expiresAt ? `${expiresAt}T23:59:59+08:00` : null,
                  }),
                (result) => {
                  setIssuedToken(result.token ?? "");
                  setName("");
                  setSelectedTools([]);
                  setAllowWrite(false);
                  setExpiresAt("");
                },
              );
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
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

            <div>
              <span className={fieldLabel}>可见工具（不选 = 全部只读工具）</span>
              <div className="flex flex-wrap gap-2">
                {tools.map((tool) => {
                  const active = selectedTools.includes(tool.name);
                  return (
                    <button
                      key={tool.name}
                      type="button"
                      className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
                        active
                          ? "border-apple-blue/20 bg-apple-blue-soft text-apple-blue"
                          : "border-black/[0.06] bg-white text-zinc-600 hover:bg-apple-canvas"
                      }`}
                      onClick={() => toggleTool(tool.name)}
                    >
                      {tool.title}
                      <span className="ml-1 font-mono text-[10px] text-zinc-400">{tool.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-4">
              <label className="block w-[190px]">
                <span className={fieldLabel}>过期时间（可选）</span>
                <input
                  type="date"
                  className={input}
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
              </label>
              <label className="flex items-center gap-2 pb-2 text-[13px] text-zinc-700">
                <input
                  type="checkbox"
                  checked={allowWrite}
                  onChange={(event) => setAllowWrite(event.target.checked)}
                />
                允许写类工具（如派发工作）
              </label>
              <button
                type="submit"
                className={btnBlue}
                disabled={pending || name.trim().length === 0 || membershipId.length === 0}
              >
                {pending ? "签发中…" : "签发令牌"}
              </button>
            </div>
          </form>
        )}
      </div>

      <div className={card}>
        <div className={cardHead}>
          <h2 className={cardTitle}>已签发令牌</h2>
          <span className={meta}>{tokens.length} 个</span>
        </div>

        {tokens.length === 0 ? (
          <p className={emptyState}>还没有令牌。签发后外部客户端才能连接 MCP 端点。</p>
        ) : (
          <ul className="grid list-none gap-2 p-0">
            {tokens.map((token) => (
              <li key={token.id} className="rounded-xl border border-hairline bg-white px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-zinc-900">{token.name}</span>
                  <span className={badge(STATUS_TONE[token.status])}>{STATUS_LABEL[token.status]}</span>
                  <span className={`${meta} font-mono`}>{token.tokenPrefix}…</span>
                  <span className={`${meta} ml-auto`}>创建 {formatTime(token.createdAt)}</span>
                </div>
                <p className={`${meta} mt-1`}>
                  {token.userName ?? "已移除"} · {token.departmentName ?? "—"} ·{" "}
                  {token.scope.tools.length === 0
                    ? "全部只读工具"
                    : token.scope.tools.join(" / ")}
                  {token.scope.allowWrite ? " · 含写类工具" : " · 只读"}
                </p>
                <p className={`${meta} mt-0.5`}>
                  最近使用 {formatTime(token.lastUsedAt)} · 过期 {formatTime(token.expiresAt)}
                </p>

                {token.status === "active" ? (
                  <>
                    <div className={divider} />
                    <button
                      type="button"
                      className={`${btnGhost} !px-3 !py-1 text-[12px]`}
                      disabled={pending}
                      onClick={() => run(() => revokeMcpTokenAction(token.id))}
                    >
                      停用
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
