"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Field } from "@/components/knowledge/Field";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { SectionCard } from "@/components/knowledge/SectionCard";
import {
  actions,
  badge,
  btnBlue,
  btnGhost,
  emptyState,
  formGrid,
  input,
  meta,
} from "@/components/knowledge/tokens";
import type { MetaConnectionView, MetaDraftView } from "@/lib/skills/meta-ads";

import {
  confirmMetaDraftAction,
  disconnectMetaAction,
  dismissMetaDraftAction,
  revertMetaDraftAction,
  saveMetaConnectionAction,
  syncMetaAction,
} from "../actions";

interface MetaPanelProps {
  connection: MetaConnectionView;
  drafts: MetaDraftView[];
}

const STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  executing: "执行中",
  executed: "已执行",
  failed: "失败",
  dismissed: "不做",
};

export function MetaPanel({ connection, drafts }: MetaPanelProps) {
  const router = useRouter();
  const [form, setForm] = useState({
    accountId: connection.accountId ?? "",
    token: "",
    relayUrl: connection.relayUrl ?? "",
    relayToken: "",
    targetCost: String(connection.settings.targetCostPerResult),
    currency: connection.settings.currency,
    resultLabel: connection.settings.resultLabel,
    maxRaisePct: String(connection.settings.maxRaisePct),
  });
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(label: string, task: () => Promise<{ ok: boolean; message: string }>) {
    setBusy(label);
    setMessage(null);
    try {
      const result = await task();
      setMessage({ tone: result.ok ? "info" : "error", text: result.message });
      if (result.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {message ? <InlineMessage tone={message.tone}>{message.text}</InlineMessage> : null}

      <SectionCard
        title="连接与配置"
        desc="广告帐户与系统用户 token 只保存密文；同步和写入都需要在这里先完成连接。"
        right={
          <span className={badge(connection.connected ? "ok" : "muted")}>
            {connection.connected ? "已连接" : "未连接"}
          </span>
        }
      >
        {connection.connected ? (
          <p className={`mb-4 ${meta}`}>
            {connection.accountName ?? "广告帐户"} · {connection.currency ?? "—"} ·{" "}
            {connection.timezone ?? "—"} · token {connection.tokenHint ?? "已配置"}
          </p>
        ) : null}
        <div className={formGrid}>
          <Field label="广告帐户 ID（只填数字）">
            <input
              className={input}
              value={form.accountId}
              onChange={(event) => setForm({ ...form, accountId: event.target.value })}
              placeholder="1234567890"
            />
          </Field>
          <Field label="系统用户 token">
            <input
              className={input}
              type="password"
              value={form.token}
              onChange={(event) => setForm({ ...form, token: event.target.value })}
              placeholder={connection.connected ? "留空则保留原 token" : "EAAB..."}
            />
          </Field>
          <Field label="海外中转地址（可选）">
            <input
              className={input}
              value={form.relayUrl}
              onChange={(event) => setForm({ ...form, relayUrl: event.target.value })}
              placeholder="https://relay.example.com/graph/v21.0"
            />
          </Field>
          <Field label="中转令牌（可选）">
            <input
              className={input}
              type="password"
              value={form.relayToken}
              onChange={(event) => setForm({ ...form, relayToken: event.target.value })}
              placeholder="留空则不更新"
            />
          </Field>
          <Field label="目标每成果成本">
            <input
              className={input}
              value={form.targetCost}
              onChange={(event) => setForm({ ...form, targetCost: event.target.value })}
            />
          </Field>
          <Field label="成果名称">
            <input
              className={input}
              value={form.resultLabel}
              onChange={(event) => setForm({ ...form, resultLabel: event.target.value })}
              placeholder="线索 / 对话 / 表单"
            />
          </Field>
          <Field label="币种">
            <input
              className={input}
              value={form.currency}
              onChange={(event) => setForm({ ...form, currency: event.target.value })}
            />
          </Field>
          <Field label="一次最多加预算 %">
            <input
              className={input}
              value={form.maxRaisePct}
              onChange={(event) => setForm({ ...form, maxRaisePct: event.target.value })}
            />
          </Field>
        </div>
        <div className={actions}>
          <button
            type="button"
            className={btnBlue}
            disabled={busy === "save" || form.token.trim().length === 0}
            onClick={() =>
              run("save", () =>
                saveMetaConnectionAction({
                  accountId: form.accountId,
                  token: form.token,
                  relayUrl: form.relayUrl,
                  relayToken: form.relayToken,
                  verify: true,
                  settings: {
                    targetCostPerResult: Number(form.targetCost) || 0,
                    currency: form.currency,
                    resultLabel: form.resultLabel,
                    maxRaisePct: Number(form.maxRaisePct) || 0,
                  },
                }),
              )
            }
          >
            {busy === "save" ? "验证中…" : "验证并连接"}
          </button>
          <button
            type="button"
            className={btnGhost}
            disabled={!connection.connected || busy === "disconnect"}
            onClick={() => run("disconnect", () => disconnectMetaAction())}
          >
            断开
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title="今日同步"
        desc="拉取近 7 天活动 / 广告 / 日成效，按规则生成待确认草稿；不会自动写入 Meta。"
        right={
          <button
            type="button"
            className={btnBlue}
            disabled={!connection.connected || busy === "sync"}
            onClick={() => run("sync", () => syncMetaAction())}
          >
            {busy === "sync" ? "同步中…" : "立即同步"}
          </button>
        }
      >
        <p className={meta}>
          规则：学习期不动 → 够本（花费 ≥ 3 倍目标成本）→ 无成果或成本超 1.5 倍则起草关停；
          成本低于目标 80% 且预算可读时起草加预算（最多 {connection.settings.maxRaisePct}%）。
        </p>
      </SectionCard>

      <SectionCard title="动作日志" count={`${drafts.length} 条`}>
        {drafts.length === 0 ? (
          <div className={emptyState}>还没有草稿。同步后所有待确认动作会出现在这里。</div>
        ) : (
          <ul className="space-y-2">
            {drafts.map((draft) => (
              <li key={draft.id} className="rounded-xl bg-apple-canvas px-3.5 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-[13px] font-medium text-zinc-900">{draft.title}</p>
                    <p className={`mt-1 ${meta}`}>
                      {STATUS_LABEL[draft.status] ?? draft.status} · {draft.targetName}
                      {draft.campaignName ? ` · ${draft.campaignName}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {draft.status === "pending" ? (
                      <>
                        <button
                          type="button"
                          className={btnBlue}
                          disabled={busy === draft.id}
                          onClick={() => run(draft.id, () => confirmMetaDraftAction(draft.id))}
                        >
                          确认执行
                        </button>
                        <button
                          type="button"
                          className={btnGhost}
                          disabled={busy === draft.id}
                          onClick={() => run(draft.id, () => dismissMetaDraftAction(draft.id))}
                        >
                          取消草稿
                        </button>
                      </>
                    ) : null}
                    {draft.status === "executed" ? (
                      <button
                        type="button"
                        className={btnGhost}
                        disabled={busy === draft.id}
                        onClick={() => run(draft.id, () => revertMetaDraftAction(draft.id))}
                      >
                        恢复
                      </button>
                    ) : null}
                  </div>
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-zinc-500">{draft.reason}</p>
                {draft.error ? <p className="mt-1 text-[12px] text-rose-600">{draft.error}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
