"use client";

import { useState } from "react";

import { Field } from "@/components/knowledge/Field";
import { InlineMessage } from "@/components/knowledge/InlineMessage";
import { SectionCard } from "@/components/knowledge/SectionCard";
import {
  actions,
  badge,
  btnBlue,
  btnGhost,
  formGrid,
  input,
  meta,
} from "@/components/knowledge/tokens";
import { SUBSCRIPTION_EVENTS, SUBSCRIPTION_EVENT_LABELS } from "@/lib/notifications/content";
import {
  CLEAR_API_KEY,
  type NotificationChannelView,
  type NotificationSettings,
} from "@/lib/settings/types";

import { saveChannelAction, testChannelAction } from "./actions";

interface Message {
  tone: "info" | "error";
  text: string;
}

const CHANNEL_LABEL: Record<string, string> = {
  email: "邮件",
  feishu: "飞书",
  wecom: "企业微信",
};

const EVENT_LABEL: Record<string, string> = {
  ...SUBSCRIPTION_EVENT_LABELS,
  test: "测试发送",
};

function formatUtc(value: string): string {
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}

interface ChannelEditorProps {
  channel: "feishu" | "wecom";
  label: string;
  view: NotificationChannelView;
  secretSupported: boolean;
  secretLabel: string;
  placeholder: string;
}

function ChannelEditor({
  channel,
  label,
  view,
  secretSupported,
  secretLabel,
  placeholder,
}: ChannelEditorProps) {
  const [enabled, setEnabled] = useState(view.enabled);
  const [webhook, setWebhook] = useState("");
  const [clearWebhook, setClearWebhook] = useState(false);
  const [webhookConfigured, setWebhookConfigured] = useState(view.webhookConfigured);
  const [webhookHint, setWebhookHint] = useState(view.webhookHint);
  const [secret, setSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [secretConfigured, setSecretConfigured] = useState(view.secretConfigured);
  const [secretHint, setSecretHint] = useState(view.secretHint);
  const [events, setEvents] = useState<string[]>(view.events);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  function toggleEvent(key: string) {
    setEvents((previous) =>
      previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key],
    );
  }

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveChannelAction({
        channel,
        enabled,
        webhook: clearWebhook ? CLEAR_API_KEY : webhook,
        secret: secretSupported ? (clearSecret ? CLEAR_API_KEY : secret) : "",
        events,
      });
      setMessage({ tone: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setWebhook("");
        setClearWebhook(false);
        setSecret("");
        setClearSecret(false);
        setWebhookConfigured(Boolean(result.keyConfigured));
        setWebhookHint(result.keyHint ?? null);
        if (secretSupported && secret) {
          setSecretConfigured(true);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setTestBusy(true);
    setMessage(null);
    try {
      const result = await testChannelAction(channel);
      setMessage({ tone: result.ok ? "info" : "error", text: result.message });
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <div className="border-t border-hairline pt-4 first:border-t-0 first:pt-0">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-zinc-900">{label}</span>
        <span className={badge(enabled ? "ok" : "muted")}>{enabled ? "已启用" : "未启用"}</span>
        {webhookConfigured ? (
          <span className={meta}>Webhook：{webhookHint ?? "已配置"}</span>
        ) : (
          <span className={meta}>尚未配置 Webhook</span>
        )}
        {secretSupported && secretConfigured ? (
          <span className={meta}>签名：{secretHint ?? "已配置"}</span>
        ) : null}
      </div>

      <div className={formGrid}>
        <Field label="启用">
          <select
            className={input}
            value={enabled ? "on" : "off"}
            onChange={(event) => setEnabled(event.target.value === "on")}
          >
            <option value="off">关闭</option>
            <option value="on">开启</option>
          </select>
        </Field>
        <Field label="Webhook 地址">
          <input
            className={input}
            value={webhook}
            disabled={clearWebhook}
            onChange={(event) => setWebhook(event.target.value)}
            placeholder={
              webhookConfigured ? "已配置，留空不修改" : placeholder
            }
          />
        </Field>
        {secretSupported ? (
          <Field label={secretLabel}>
            <input
              type="password"
              className={input}
              value={secret}
              disabled={clearSecret}
              autoComplete="new-password"
              onChange={(event) => setSecret(event.target.value)}
              placeholder={
                secretConfigured ? "已配置，留空不修改" : "可选：机器人安全设置里的签名密钥"
              }
            />
          </Field>
        ) : null}
        <Field label="接收事件" className="block sm:col-span-2">
          <div className="flex flex-wrap gap-4 pt-1">
            {SUBSCRIPTION_EVENTS.map((key) => (
              <label key={key} className="inline-flex items-center gap-2 text-[12px] text-zinc-700">
                <input
                  type="checkbox"
                  checked={events.includes(key)}
                  onChange={() => toggleEvent(key)}
                />
                {SUBSCRIPTION_EVENT_LABELS[key]}
              </label>
            ))}
          </div>
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="inline-flex items-center gap-2 text-[12px] text-zinc-600">
          <input
            type="checkbox"
            checked={clearWebhook}
            onChange={(event) => setClearWebhook(event.target.checked)}
          />
          清除已保存的 Webhook
        </label>
        {secretSupported ? (
          <label className="inline-flex items-center gap-2 text-[12px] text-zinc-600">
            <input
              type="checkbox"
              checked={clearSecret}
              onChange={(event) => setClearSecret(event.target.checked)}
            />
            清除签名密钥
          </label>
        ) : null}
      </div>

      <div className={actions}>
        <button type="button" className={btnBlue} disabled={busy} onClick={submit}>
          {busy ? "保存中…" : `保存${label}通知`}
        </button>
        <button type="button" className={btnGhost} disabled={testBusy} onClick={runTest}>
          {testBusy ? "发送中…" : "测试发送"}
        </button>
      </div>
      {message ? <InlineMessage tone={message.tone}>{message.text}</InlineMessage> : null}
    </div>
  );
}

export function NotifyChannels({ settings }: { settings: NotificationSettings }) {
  const enabledCount =
    Number(settings.enabled) + Number(settings.feishu.enabled) + Number(settings.wecom.enabled);

  return (
    <SectionCard
      title="IM 通知（飞书 / 企微）"
      desc="在飞书或企业微信群里添加「群机器人」，把 Webhook 地址填到这里即可收到故障卡片。地址与签名密钥加密入库，只回显主机名与末 4 位。"
      right={
        <span className={badge(enabledCount > 0 ? "ok" : "muted")}>
          {enabledCount > 0 ? `${enabledCount} 个渠道启用` : "全部未启用"}
        </span>
      }
    >
      <div className="space-y-5">
        <ChannelEditor
          channel="feishu"
          label="飞书群机器人"
          view={settings.feishu}
          secretSupported
          secretLabel="签名密钥（可选）"
          placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
        />
        <ChannelEditor
          channel="wecom"
          label="企业微信群机器人"
          view={settings.wecom}
          secretSupported={false}
          secretLabel=""
          placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
        />
      </div>

      <p className={`${meta} mt-4`}>
        机器人安全设置建议选「自定义关键词」并填 <code className="font-mono">Jxf-AI</code>
        （消息标题自带该前缀），比 IP 白名单更适合私有化部署。
      </p>

      <div className="mt-5 border-t border-hairline pt-4">
        <div className={meta}>最近投递（来自审计，最多 8 条）</div>
        {settings.recent.length === 0 ? (
          <p className="mt-2 text-[12px] text-zinc-500">还没有投递记录，触发一次故障或点「测试发送」后可见。</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-[12px]">
              <thead className="text-zinc-500">
                <tr>
                  <th className="py-1 pr-3 font-medium">时间</th>
                  <th className="py-1 pr-3 font-medium">渠道</th>
                  <th className="py-1 pr-3 font-medium">事件</th>
                  <th className="py-1 pr-3 font-medium">结果</th>
                  <th className="py-1 font-medium">错误</th>
                </tr>
              </thead>
              <tbody>
                {settings.recent.map((item, index) => (
                  <tr key={`${item.at}-${index}`} className="border-t border-hairline align-top">
                    <td className="whitespace-nowrap py-1.5 pr-3">{formatUtc(item.at)}</td>
                    <td className="py-1.5 pr-3">{CHANNEL_LABEL[item.channel] ?? item.channel}</td>
                    <td className="py-1.5 pr-3">{EVENT_LABEL[item.event] ?? item.event}</td>
                    <td className="py-1.5 pr-3">{item.ok ? "成功" : "失败"}</td>
                    <td className="py-1.5 text-zinc-500">{item.error ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
