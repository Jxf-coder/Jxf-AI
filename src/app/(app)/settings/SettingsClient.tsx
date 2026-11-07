"use client";

import Link from "next/link";
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
  inputInline,
  linkBtn,
  meta,
} from "@/components/knowledge/tokens";
import type { DeliveryStatus } from "@/lib/settings/delivery-status";
import {
  CLEAR_API_KEY,
  type BrandingSettings,
  type EffectiveAiSummary,
  type PlatformSettingsView,
} from "@/lib/settings/types";

import {
  saveAiSettingsAction,
  saveAuditRetentionAction,
  saveBrandingAction,
  testAiConnectionAction,
} from "./actions";

interface SettingsClientProps {
  settings: PlatformSettingsView;
  effective: EffectiveAiSummary;
  delivery: DeliveryStatus;
  version: string;
  appEnv: string;
}

interface Message {
  tone: "info" | "error";
  text: string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatUtc(value: string | null): string {
  if (!value) {
    return "—";
  }
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}

function StatusBadge({ ok, text }: { ok: boolean; text: string }) {
  return <span className={badge(ok ? "ok" : "muted")}>{text}</span>;
}

export function SettingsClient({
  settings,
  effective,
  delivery,
  version,
  appEnv,
}: SettingsClientProps) {
  const [brand, setBrand] = useState<BrandingSettings>(settings.branding);
  const [brandBusy, setBrandBusy] = useState(false);
  const [brandMessage, setBrandMessage] = useState<Message | null>(null);

  const [aiMode, setAiMode] = useState<"inherit" | "on" | "off">(
    settings.ai.enabled === null ? "inherit" : settings.ai.enabled ? "on" : "off",
  );
  const [baseUrl, setBaseUrl] = useState(settings.ai.baseUrl ?? "");
  const [modelPro, setModelPro] = useState(settings.ai.modelPro ?? "");
  const [modelFlash, setModelFlash] = useState(settings.ai.modelFlash ?? "");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [keyConfigured, setKeyConfigured] = useState(settings.ai.keyConfigured);
  const [keyHint, setKeyHint] = useState(settings.ai.keyHint);
  const [aiBusy, setAiBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [aiMessage, setAiMessage] = useState<Message | null>(null);

  const [retention, setRetention] = useState(settings.audit.retentionDays?.toString() ?? "");
  const [retentionBusy, setRetentionBusy] = useState(false);
  const [retentionMessage, setRetentionMessage] = useState<Message | null>(null);

  async function submitBranding() {
    setBrandBusy(true);
    setBrandMessage(null);
    try {
      const result = await saveBrandingAction(brand);
      setBrandMessage({ tone: result.ok ? "info" : "error", text: result.message });
    } finally {
      setBrandBusy(false);
    }
  }

  async function submitAi() {
    setAiBusy(true);
    setAiMessage(null);
    try {
      const result = await saveAiSettingsAction({
        enabled: aiMode,
        baseUrl,
        modelPro,
        modelFlash,
        apiKey: clearKey ? CLEAR_API_KEY : apiKey,
      });
      setAiMessage({ tone: result.ok ? "info" : "error", text: result.message });
      if (result.ok) {
        setApiKey("");
        setClearKey(false);
        setKeyConfigured(Boolean(result.keyConfigured));
        setKeyHint(result.keyHint ?? null);
      }
    } finally {
      setAiBusy(false);
    }
  }

  async function runAiTest() {
    setTestBusy(true);
    setAiMessage(null);
    try {
      const result = await testAiConnectionAction();
      setAiMessage({ tone: result.ok ? "info" : "error", text: result.message });
    } finally {
      setTestBusy(false);
    }
  }

  async function submitRetention() {
    setRetentionBusy(true);
    setRetentionMessage(null);
    try {
      const parsed = retention.trim() ? Number.parseInt(retention.trim(), 10) : null;
      const result = await saveAuditRetentionAction(parsed !== null && Number.isFinite(parsed) ? parsed : null);
      setRetentionMessage({ tone: result.ok ? "info" : "error", text: result.message });
    } finally {
      setRetentionBusy(false);
    }
  }

  return (
    <>
      <SectionCard
        title="品牌与站点"
        desc="站点名称、登录页标题与全站主题色。保存后无需重建，下一次页面加载即生效。"
        right={<span className={meta}>{settings.updatedAt ? `最近更新 ${formatUtc(settings.updatedAt)}` : "使用默认值"}</span>}
      >
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-hairline bg-white px-3.5 py-3">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: brand.brandPrimary }}
            aria-hidden="true"
          />
          <span className="text-[13px] font-semibold" style={{ color: brand.brandDeep }}>
            {brand.siteName || "站点名称"}
          </span>
          <span className={meta}>{brand.siteTagline}</span>
          <span
            className="ml-auto rounded-full px-2.5 py-0.5 text-[11px] font-medium"
            style={{ backgroundColor: brand.brandSoft, color: brand.brandPrimary }}
          >
            主题预览
          </span>
        </div>

        <div className={formGrid}>
          <Field label="站点名称">
            <input
              className={input}
              value={brand.siteName}
              maxLength={40}
              onChange={(event) => setBrand({ ...brand, siteName: event.target.value })}
              placeholder="例如：Jxf AI 工作台"
            />
          </Field>
          <Field label="副标题">
            <input
              className={input}
              value={brand.siteTagline}
              maxLength={120}
              onChange={(event) => setBrand({ ...brand, siteTagline: event.target.value })}
              placeholder="显示在登录页与浏览器描述中"
            />
          </Field>
          <Field label="品牌主色">
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="品牌主色"
                className="h-9 w-12 rounded-lg border-0 bg-transparent p-0"
                value={brand.brandPrimary}
                onChange={(event) => setBrand({ ...brand, brandPrimary: event.target.value })}
              />
              <input
                className={inputInline}
                value={brand.brandPrimary}
                maxLength={7}
                onChange={(event) => setBrand({ ...brand, brandPrimary: event.target.value })}
              />
            </div>
          </Field>
          <Field label="品牌浅色（激活底色）">
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="品牌浅色"
                className="h-9 w-12 rounded-lg border-0 bg-transparent p-0"
                value={brand.brandSoft}
                onChange={(event) => setBrand({ ...brand, brandSoft: event.target.value })}
              />
              <input
                className={inputInline}
                value={brand.brandSoft}
                maxLength={7}
                onChange={(event) => setBrand({ ...brand, brandSoft: event.target.value })}
              />
            </div>
          </Field>
          <Field label="品牌深色">
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="品牌深色"
                className="h-9 w-12 rounded-lg border-0 bg-transparent p-0"
                value={brand.brandStrong}
                onChange={(event) => setBrand({ ...brand, brandStrong: event.target.value })}
              />
              <input
                className={inputInline}
                value={brand.brandStrong}
                maxLength={7}
                onChange={(event) => setBrand({ ...brand, brandStrong: event.target.value })}
              />
            </div>
          </Field>
          <Field label="品牌最深色">
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="品牌最深色"
                className="h-9 w-12 rounded-lg border-0 bg-transparent p-0"
                value={brand.brandDeep}
                onChange={(event) => setBrand({ ...brand, brandDeep: event.target.value })}
              />
              <input
                className={inputInline}
                value={brand.brandDeep}
                maxLength={7}
                onChange={(event) => setBrand({ ...brand, brandDeep: event.target.value })}
              />
            </div>
          </Field>
        </div>

        <div className={actions}>
          <button type="button" className={btnBlue} disabled={brandBusy} onClick={submitBranding}>
            {brandBusy ? "保存中…" : "保存品牌"}
          </button>
          <button
            type="button"
            className={btnGhost}
            disabled={brandBusy}
            onClick={() => {
              setBrand(settings.branding);
              setBrandMessage(null);
            }}
          >
            还原为当前已保存值
          </button>
        </div>
        {brandMessage ? <InlineMessage tone={brandMessage.tone}>{brandMessage.text}</InlineMessage> : null}
      </SectionCard>

      <SectionCard
        title="模型 Key"
        desc="数据库中的配置会覆盖环境变量，保存后 Web 即时生效；Key 以 AES-256-GCM 加密入库，页面只显示末 4 位。"
        right={<StatusBadge ok={effective.enabled} text={effective.enabled ? "生成已启用" : "仅检索"} />}
      >
        <div className="mb-4 grid gap-2 sm:grid-cols-2">
          <div className="rounded-xl bg-apple-canvas px-3.5 py-2.5">
            <div className={meta}>当前生效 Base URL</div>
            <div className="break-all font-mono text-[12px] text-zinc-900">{effective.baseUrl}</div>
          </div>
          <div className="rounded-xl bg-apple-canvas px-3.5 py-2.5">
            <div className={meta}>当前生效 Key</div>
            <div className="font-mono text-[12px] text-zinc-900">
              {effective.apiKeyHint ?? "未配置（AI 生成将降级为纯关键词检索）"}
            </div>
          </div>
          <div className="rounded-xl bg-apple-canvas px-3.5 py-2.5">
            <div className={meta}>深度模型 / 轻量模型</div>
            <div className="font-mono text-[12px] text-zinc-900">
              {effective.chatModel} · {effective.fastModel}
            </div>
          </div>
          <div className="rounded-xl bg-apple-canvas px-3.5 py-2.5">
            <div className={meta}>向量 / OCR</div>
            <div className="text-[12px] text-zinc-900">
              {effective.embeddingEnabled ? "向量已配置" : "仅关键词"} ·{" "}
              {effective.ocrEnabled ? "OCR 已启用" : "OCR 关闭"}
            </div>
          </div>
        </div>

        <div className={formGrid}>
          <Field label="启用 AI 生成">
            <select
              className={input}
              value={aiMode}
              onChange={(event) => setAiMode(event.target.value as "inherit" | "on" | "off")}
            >
              <option value="inherit">跟随环境变量（JXF_AI_ENABLED）</option>
              <option value="on">强制开启</option>
              <option value="off">强制关闭（只做检索）</option>
            </select>
          </Field>
          <Field label="Base URL">
            <input
              className={input}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="留空跟随环境变量，例如 https://api.openai.com/v1"
            />
          </Field>
          <Field label="深度推理模型（pro）">
            <input
              className={input}
              value={modelPro}
              onChange={(event) => setModelPro(event.target.value)}
              placeholder="留空跟随环境变量"
            />
          </Field>
          <Field label="高频轻量模型（flash）">
            <input
              className={input}
              value={modelFlash}
              onChange={(event) => setModelFlash(event.target.value)}
              placeholder="留空跟随环境变量"
            />
          </Field>
          <Field label="API Key" className="block sm:col-span-2">
            <input
              type="password"
              className={input}
              value={apiKey}
              disabled={clearKey}
              autoComplete="new-password"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                keyConfigured
                  ? `已配置 ${keyHint ?? ""}，留空不修改`
                  : "粘贴新的 Key（保存后只显示末 4 位）"
              }
            />
          </Field>
        </div>

        <label className="mt-3 inline-flex items-center gap-2 text-[12px] text-zinc-600">
          <input
            type="checkbox"
            checked={clearKey}
            onChange={(event) => setClearKey(event.target.checked)}
          />
          清除已保存的 Key（回退到环境变量）
        </label>

        <div className={actions}>
          <button type="button" className={btnBlue} disabled={aiBusy} onClick={submitAi}>
            {aiBusy ? "保存中…" : "保存模型配置"}
          </button>
          <button type="button" className={btnGhost} disabled={testBusy} onClick={runAiTest}>
            {testBusy ? "测试中…" : "测试当前连接"}
          </button>
          {keyConfigured ? <span className={meta}>库内 Key：{keyHint ?? "已配置"}</span> : null}
        </div>
        {aiMessage ? <InlineMessage tone={aiMessage.tone}>{aiMessage.text}</InlineMessage> : null}
      </SectionCard>

      <SectionCard
        title="审计与留存"
        desc="审计只追加不修改。留存清理由宿主机脚本执行，优先使用这里的配置。"
        right={<span className={badge()}>{settings.audit.totalEvents} 条事件</span>}
      >
        <div className="mb-4 grid gap-2 sm:grid-cols-2">
          <div className="rounded-xl bg-apple-canvas px-3.5 py-2.5">
            <div className={meta}>最早事件</div>
            <div className="text-[12px] text-zinc-900">{formatUtc(settings.audit.earliestEventAt)}</div>
          </div>
          <div className="rounded-xl bg-apple-canvas px-3.5 py-2.5">
            <div className={meta}>当前留存策略</div>
            <div className="text-[12px] text-zinc-900">
              {settings.audit.retentionDays ? `${settings.audit.retentionDays} 天` : "默认 365 天"}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Field label="留存天数（30–3650，留空恢复默认）" className="block w-full sm:w-64">
            <input
              type="number"
              min={30}
              max={3650}
              className={input}
              value={retention}
              onChange={(event) => setRetention(event.target.value)}
              placeholder="365"
            />
          </Field>
          <button type="button" className={btnBlue} disabled={retentionBusy} onClick={submitRetention}>
            {retentionBusy ? "保存中…" : "保存留存"}
          </button>
        </div>
        {retentionMessage ? (
          <InlineMessage tone={retentionMessage.tone}>{retentionMessage.text}</InlineMessage>
        ) : null}

        <p className={`${meta} mt-3`}>
          清理命令：<code className="font-mono">npm run audit:prune -- --yes</code>（在宿主机仓库根目录执行；
          未指定 <code className="font-mono">--days</code> 时读取此配置）。
        </p>
        <div className={actions}>
          <Link className={linkBtn} href="/api/audit/export?format=csv">
            导出 CSV
          </Link>
          <Link className={linkBtn} href="/api/audit/export?format=jsonl">
            导出 JSONL
          </Link>
          <Link className={linkBtn} href="/admin/permissions?tab=audit">
            查看审计日志
          </Link>
        </div>
      </SectionCard>

      <SectionCard
        title="交付与备份"
        desc="只读展示宿主机 backups/ 的备份与升级产物；执行仍由运维脚本完成。"
        right={<StatusBadge ok={delivery.available} text={delivery.available ? "备份目录已挂载" : "未挂载备份目录"} />}
      >
        <div className="mb-4 grid gap-2 sm:grid-cols-3">
          <div className="rounded-xl bg-apple-canvas px-3.5 py-2.5">
            <div className={meta}>应用版本</div>
            <div className="font-mono text-[12px] text-zinc-900">{version}</div>
          </div>
          <div className="rounded-xl bg-apple-canvas px-3.5 py-2.5">
            <div className={meta}>运行环境</div>
            <div className="font-mono text-[12px] text-zinc-900">{appEnv}</div>
          </div>
          <div className="rounded-xl bg-apple-canvas px-3.5 py-2.5">
            <div className={meta}>备份目录</div>
            <div className="break-all font-mono text-[12px] text-zinc-900">{delivery.backupDir}</div>
          </div>
        </div>

        {delivery.backups.length === 0 ? (
          <div className="rounded-2xl bg-apple-canvas px-4 py-6 text-center text-[13px] text-zinc-500">
            暂无备份产物。在宿主机执行 <code className="font-mono">npm run backup</code> 后刷新本页。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>备份</th>
                  <th>类型</th>
                  <th>时间</th>
                  <th>DB 版本</th>
                  <th>关键表</th>
                  <th>大小</th>
                </tr>
              </thead>
              <tbody>
                {delivery.backups.map((item) => (
                  <tr key={item.name}>
                    <td className="mono">{item.name}</td>
                    <td>{item.cold ? "冷备" : "热备"}</td>
                    <td className="mono">{formatUtc(item.createdAt)}</td>
                    <td className="mono">{item.dbVersion ?? "—"}</td>
                    <td className="mono">
                      {item.counts.users ?? "—"} 用户 / {item.counts.memberships ?? "—"} 任用
                    </td>
                    <td className="mono">{formatBytes(item.totalBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <div className="rounded-xl bg-apple-canvas px-3.5 py-2.5">
            <div className={meta}>最近升级</div>
            <div className="text-[12px] text-zinc-900">
              {delivery.lastUpgrade
                ? `${delivery.lastUpgrade.status} · ${formatUtc(delivery.lastUpgrade.startedAt)}${
                    delivery.lastUpgrade.rolledBackAt ? " · 已回滚" : ""
                  }`
                : "暂无升级记录"}
            </div>
          </div>
          <div className="rounded-xl bg-apple-canvas px-3.5 py-2.5">
            <div className={meta}>升级 / 回滚</div>
            <div className="font-mono text-[12px] text-zinc-900">npm run upgrade · npm run rollback</div>
          </div>
        </div>

        <p className={`${meta} mt-3`}>
          恢复演练：<code className="font-mono">npm run restore -- --from backups/&lt;stamp&gt; --verify</code>；
          完整健康面见{" "}
          <Link className={linkBtn} href="/health">
            系统健康状态
          </Link>
        </p>
      </SectionCard>
    </>
  );
}
