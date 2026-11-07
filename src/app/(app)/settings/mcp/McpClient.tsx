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
import type { McpToolApprovalView } from "@/lib/mcp/approvals";
import type { McpMembershipCandidate, McpTokenView } from "@/lib/mcp/tokens";
import type { McpSkill, McpToolAction } from "@/lib/mcp/tools";

import {
  decideMcpToolApprovalAction,
  issueMcpTokenAction,
  revokeMcpTokenAction,
  type McpActionResult,
} from "./actions";
import { ConnectorSection } from "./ConnectorSection";

const SKILL_LABEL: Record<McpSkill, string> = {
  knowledge: "知识库",
  workitem: "工作项",
  employee: "AI 员工",
};

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
  skill: McpSkill;
}

export interface McpEmployeeOption {
  id: string;
  name: string;
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
  employees: McpEmployeeOption[];
  endpoint: string;
}

export function McpClient({
  tokens,
  candidates,
  servers,
  calls,
  approvals,
  toolsByServer,
  stdioCommands,
  tools,
  employees,
  endpoint,
}: McpClientProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [issuedToken, setIssuedToken] = useState("");

  const [name, setName] = useState("");
  const [membershipId, setMembershipId] = useState(candidates[0]?.membershipId ?? "");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedPipelines, setSelectedPipelines] = useState<string[]>([]);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [allowWrite, setAllowWrite] = useState(false);
  const [approvalTools, setApprovalTools] = useState<string[]>([]);
  const [channelsText, setChannelsText] = useState("");
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

  function toggleValue(
    value: string,
    setter: (updater: (previous: string[]) => string[]) => void,
  ) {
    setter((previous) =>
      previous.includes(value)
        ? previous.filter((item) => item !== value)
        : [...previous, value],
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
            <h2 className={cardTitle}>逐工具审批</h2>
            <p className={`${meta} mt-1`}>
              命中令牌审批维的写类工具不会直接执行；批准后按令牌绑定的任用身份执行，执行结果留档。
            </p>
          </div>
          <span className={meta}>
            {approvals.filter((item) => item.status === "pending").length} 张待审批
          </span>
        </div>

        {approvals.length === 0 ? (
          <p className={emptyState}>还没有审批单。写类工具被审批维拦截时会自动出现在这里。</p>
        ) : (
          <ul className="grid list-none gap-2 p-0">
            {approvals.map((approval) => (
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
                  <>
                    <div className={divider} />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={`${btnBlue} !px-3 !py-1 text-[12px]`}
                        disabled={pending}
                        onClick={() => run(() => decideMcpToolApprovalAction(approval.id, "approve"))}
                      >
                        批准并执行
                      </button>
                      <button
                        type="button"
                        className={`${btnGhost} !px-3 !py-1 text-[12px]`}
                        disabled={pending}
                        onClick={() => run(() => decideMcpToolApprovalAction(approval.id, "reject"))}
                      >
                        驳回
                      </button>
                    </div>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

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
                    skills: selectedSkills,
                    pipelines: selectedPipelines,
                    tools: selectedTools,
                    allowWrite,
                    approvalTools,
                    channels: channelsText
                      .split(/[,，\s]+/)
                      .map((item) => item.trim())
                      .filter(Boolean),
                    expiresAt: expiresAt ? `${expiresAt}T23:59:59+08:00` : null,
                  }),
                (result) => {
                  setIssuedToken(result.token ?? "");
                  setName("");
                  setSelectedSkills([]);
                  setSelectedPipelines([]);
                  setSelectedTools([]);
                  setAllowWrite(false);
                  setApprovalTools([]);
                  setChannelsText("");
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
              <span className={fieldLabel}>技能维（不选 = 全部能力域）</span>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(SKILL_LABEL) as McpSkill[]).map((skill) => {
                  const active = selectedSkills.includes(skill);
                  return (
                    <button
                      key={skill}
                      type="button"
                      className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
                        active
                          ? "border-apple-blue/20 bg-apple-blue-soft text-apple-blue"
                          : "border-black/[0.06] bg-white text-zinc-600 hover:bg-apple-canvas"
                      }`}
                      onClick={() => toggleValue(skill, setSelectedSkills)}
                    >
                      {SKILL_LABEL[skill]}
                    </button>
                  );
                })}
              </div>
            </div>

            {employees.length > 0 ? (
              <div>
                <span className={fieldLabel}>产线维（不选 = 可给全部 AI 员工派活）</span>
                <div className="flex flex-wrap gap-2">
                  {employees.map((employee) => {
                    const active = selectedPipelines.includes(employee.id);
                    return (
                      <button
                        key={employee.id}
                        type="button"
                        className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
                          active
                            ? "border-apple-blue/20 bg-apple-blue-soft text-apple-blue"
                            : "border-black/[0.06] bg-white text-zinc-600 hover:bg-apple-canvas"
                        }`}
                        onClick={() => toggleValue(employee.id, setSelectedPipelines)}
                      >
                        {employee.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div>
              <span className={fieldLabel}>动作维（不选 = 全部只读工具）</span>
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
                      onClick={() => toggleValue(tool.name, setSelectedTools)}
                    >
                      {tool.title}
                      <span className="ml-1 font-mono text-[10px] text-zinc-400">{tool.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <span className={fieldLabel}>审批维（不选 = 写类工具直接执行）</span>
              <div className="flex flex-wrap gap-2">
                {tools
                  .filter((tool) => tool.action === "write")
                  .map((tool) => {
                    const active = approvalTools.includes(tool.name);
                    return (
                      <button
                        key={tool.name}
                        type="button"
                        className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
                          active
                            ? "border-amber-300 bg-amber-50 text-amber-700"
                            : "border-black/[0.06] bg-white text-zinc-600 hover:bg-apple-canvas"
                        }`}
                        onClick={() => toggleValue(tool.name, setApprovalTools)}
                      >
                        {tool.title}
                      </button>
                    );
                  })}
                <button
                  type="button"
                  className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
                    approvalTools.includes("*")
                      ? "border-amber-300 bg-amber-50 text-amber-700"
                      : "border-black/[0.06] bg-white text-zinc-600 hover:bg-apple-canvas"
                  }`}
                  onClick={() => toggleValue("*", setApprovalTools)}
                >
                  全部写类
                </button>
              </div>
            </div>

            <label className="block">
              <span className={fieldLabel}>客户端通道维（逗号分隔，留空 = 不限）</span>
              <input
                className={input}
                value={channelsText}
                placeholder="cursor, claude-code, feishu-bot"
                onChange={(event) => setChannelsText(event.target.value)}
              />
            </label>

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
                  {token.userName ?? "已移除"} · {token.departmentName ?? "—"}
                </p>
                <p className={`${meta} mt-0.5`}>
                  技能 {token.scope.skills.length === 0 ? "全部" : token.scope.skills.join("/")} · 产线{" "}
                  {token.scope.pipelines.length === 0
                    ? "全部"
                    : `${token.scope.pipelines.length} 个员工`}{" "}
                  · 动作{" "}
                  {token.scope.tools.length === 0 ? "全部只读" : token.scope.tools.join("/")} ·{" "}
                  {token.scope.allowWrite ? "含写类" : "只读"}
                </p>
                <p className={`${meta} mt-0.5`}>
                  审批{" "}
                  {token.scope.approvalTools.length === 0
                    ? "无"
                    : token.scope.approvalTools.join("/")}{" "}
                  · 通道 {token.scope.channels.length === 0 ? "不限" : token.scope.channels.join("/")}
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
