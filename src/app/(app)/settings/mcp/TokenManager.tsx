"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  badge,
  btnBlue,
  btnGhost,
  divider,
  emptyState,
  fieldLabel,
  input,
  linkBtn,
  meta,
} from "@/components/knowledge/tokens";
import { toast } from "@/components/ui/toast";
import { MCP_CLIENT_LABELS } from "@/lib/mcp/clients";
import type { McpTokenView } from "@/lib/mcp/tokens";

import {
  cleanupInvalidTokensAction,
  deleteMcpTokenAction,
  renewMcpTokenAction,
  revokeMcpTokenAction,
  type McpActionResult,
} from "./actions";
import { Drawer } from "./McpDrawer";

const PAGE_SIZE = 10;

const STATUS_LABEL: Record<McpTokenView["status"], string> = {
  active: "生效中",
  revoked: "已关闭",
  expired: "已过期",
};

const STATUS_TONE: Record<McpTokenView["status"], "ok" | "muted" | "warn"> = {
  active: "ok",
  revoked: "muted",
  expired: "warn",
};

const FILTERS = [
  { id: "all" as const, label: "全部" },
  { id: "active" as const, label: "生效中" },
  { id: "invalid" as const, label: "已失效" },
];

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatTime(value: string | null, empty = "—"): string {
  return value ? TIME_FORMAT.format(new Date(value)) : empty;
}

function formatDate(value: string | null): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

interface TokenManagerProps {
  tokens: McpTokenView[];
  /** 顶部全局搜索框的关键词，直接复用 */
  query: string;
}

export function TokenManager({ tokens, query }: TokenManagerProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [page, setPage] = useState(1);

  const [renewId, setRenewId] = useState<string | null>(null);
  const [renewDate, setRenewDate] = useState("");
  const [reactivate, setReactivate] = useState(false);

  const renewing = renewId ? tokens.find((token) => token.id === renewId) ?? null : null;

  const needle = query.trim().toLowerCase();
  const matches = (token: McpTokenView) =>
    needle.length === 0 ||
    [
      token.name,
      token.client ? MCP_CLIENT_LABELS[token.client] : "",
      token.userName ?? "",
      token.departmentName ?? "",
      token.tokenPrefix,
    ].some((value) => value.toLowerCase().includes(needle));

  const filtered = tokens.filter((token) => {
    if (filter === "active" && token.status !== "active") {
      return false;
    }
    if (filter === "invalid" && token.status === "active") {
      return false;
    }
    return matches(token);
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const invalidCount = tokens.filter((token) => token.status !== "active").length;

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

  function openRenew(token: McpTokenView) {
    setRenewId(token.id);
    setRenewDate(formatDate(token.expiresAt));
    setReactivate(token.status !== "active");
  }

  function submitRenew() {
    if (!renewing) {
      return;
    }
    run(
      () =>
        renewMcpTokenAction(renewing.id, {
          expiresAt: renewDate ? `${renewDate}T23:59:59+08:00` : null,
          reactivate,
        }),
      () => setRenewId(null),
    );
  }

  return (
    <>
      <div className="rounded-2xl border border-hairline bg-white p-4 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((item) => {
              const count =
                item.id === "all"
                  ? tokens.length
                  : item.id === "active"
                    ? tokens.length - invalidCount
                    : invalidCount;
              const active = filter === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`rounded-full px-3 py-1 text-[12px] transition-colors ${
                    active
                      ? "bg-apple-blue text-white"
                      : "border border-black/[0.08] bg-white text-zinc-600 hover:bg-apple-canvas"
                  }`}
                  onClick={() => {
                    setFilter(item.id);
                    setPage(1);
                  }}
                >
                  {item.label}
                  <span className={`ml-1 text-[10px] ${active ? "opacity-80" : "opacity-60"}`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className={btnGhost}
            disabled={pending || invalidCount === 0}
            onClick={() => run(() => cleanupInvalidTokensAction())}
          >
            一键清理失效令牌
          </button>
        </div>

        <div className={divider} />

        {filtered.length === 0 ? (
          <p className={emptyState}>
            {tokens.length === 0 ? "还没有令牌。点右上角「签发令牌」创建。" : "没有匹配的令牌。"}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>令牌名称</th>
                  <th>客户端</th>
                  <th>绑定用户</th>
                  <th>签发时间</th>
                  <th>过期时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((token) => (
                  <tr key={token.id}>
                    <td>
                      <span className={badge(STATUS_TONE[token.status])}>
                        {STATUS_LABEL[token.status]}
                      </span>
                    </td>
                    <td className="text-[13px] text-zinc-900">{token.name}</td>
                    <td className="text-[12px] text-zinc-600">
                      {token.client ? MCP_CLIENT_LABELS[token.client] : "通用"}
                    </td>
                    <td className="text-[12px] text-zinc-600">
                      {token.userName ?? "已移除"}
                      <span className={`${meta} block`}>{token.departmentName ?? "—"}</span>
                    </td>
                    <td className="text-[12px] text-zinc-500">{formatTime(token.createdAt)}</td>
                    <td className="text-[12px] text-zinc-500">
                      {formatTime(token.expiresAt, "长期")}
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className={`${linkBtn} text-[12px]`}
                          disabled={pending}
                          onClick={() => openRenew(token)}
                        >
                          {token.status === "active" ? "续期" : "续期 / 重新激活"}
                        </button>
                        {token.status === "active" ? (
                          <button
                            type="button"
                            className={`${linkBtn} text-[12px]`}
                            disabled={pending}
                            onClick={() => run(() => revokeMcpTokenAction(token.id))}
                          >
                            关闭
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={`${linkBtn} text-[12px] text-rose-600`}
                          disabled={pending}
                          onClick={() => run(() => deleteMcpTokenAction(token.id))}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className={meta}>
            共 {filtered.length} 条 · 第 {currentPage} / {totalPages} 页
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={btnGhost}
              disabled={pending || currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
            >
              上一页
            </button>
            <button
              type="button"
              className={btnGhost}
              disabled={pending || currentPage >= totalPages}
              onClick={() => setPage(currentPage + 1)}
            >
              下一页
            </button>
          </div>
        </div>
      </div>

      {renewing ? (
        <Drawer title="续期 / 重新激活" onClose={() => setRenewId(null)}>
          <div className="rounded-xl bg-apple-canvas px-3.5 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-zinc-900">{renewing.name}</span>
              <span className={badge(STATUS_TONE[renewing.status])}>
                {STATUS_LABEL[renewing.status]}
              </span>
              <span className={`${meta} font-mono`}>{renewing.tokenPrefix}…</span>
            </div>
            <p className={`${meta} mt-1`}>
              {renewing.userName ?? "已移除"} · {renewing.departmentName ?? "—"} · 客户端{" "}
              {renewing.client ? MCP_CLIENT_LABELS[renewing.client] : "通用"}
            </p>
            <p className={`${meta} mt-0.5`}>
              当前过期：{formatTime(renewing.expiresAt, "长期")}
            </p>
          </div>

          <div className="mt-4 grid gap-3">
            <label className="block">
              <span className={fieldLabel}>新的过期时间（可选）</span>
              <input
                type="date"
                className={input}
                value={renewDate}
                onChange={(event) => setRenewDate(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-[13px] text-zinc-700">
              <input
                type="checkbox"
                checked={reactivate}
                onChange={(event) => setReactivate(event.target.checked)}
              />
              重新激活（清除已关闭状态）
            </label>
            <div>
              <button
                type="button"
                className={btnBlue}
                disabled={pending || (!renewDate && !reactivate)}
                onClick={submitRenew}
              >
                {pending ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </Drawer>
      ) : null}
    </>
  );
}
