/**
 * 平台设置领域层（P5 设置面）。
 *
 * - 品牌 / 模型 Key / 审计留存存放在 app_settings 单行表；
 * - 读写必须经 platform:settings 守卫（L1-only），所有变更写审计；
 * - 模型 Key 加密后入库，前端只看到末 4 位提示；
 * - 登录页与启动期通过 SECURITY DEFINER 函数读取，不绕过 RLS 直接查表。
 */

import type { PoolClient } from "pg";

import { auditInTx } from "@/lib/audit";
import { getPool } from "@/lib/db/pool";
import { withUserContext, type UserContext } from "@/lib/db/user-context";
import { SUBSCRIPTION_EVENTS, type SubscriptionEventKey } from "@/lib/notifications/content";
import { requireContextPermission } from "@/lib/permissions/server";
import type { PermissionResource } from "@/types/permission";

import { decryptSecret, encryptSecret, secretHint } from "./crypto";
import {
  CLEAR_API_KEY,
  DEFAULT_BRANDING,
  type AuditSettings,
  type AiSettings,
  type BrandingSettings,
  type PlatformSettingsView,
} from "./types";

export { CLEAR_API_KEY };
export type { AiSettings, AuditSettings, BrandingSettings, PlatformSettingsView };

export class SettingsInputError extends Error {}

export interface RuntimeSettings {
  aiEnabled: boolean | null;
  aiBaseUrl: string | null;
  aiApiKeyEnc: string | null;
  aiApiKeyHint: string | null;
  aiModelPro: string | null;
  aiModelFlash: string | null;
  auditRetentionDays: number | null;
  notifyEmailEnabled: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpPassEnc: string | null;
  smtpPassHint: string | null;
  notifyEmailTo: string | null;
}

interface SettingsRow {
  site_name: string;
  site_tagline: string;
  brand_primary: string;
  brand_strong: string;
  brand_deep: string;
  brand_soft: string;
  ai_enabled: boolean | null;
  ai_base_url: string | null;
  ai_model_pro: string | null;
  ai_model_flash: string | null;
  key_configured: boolean;
  ai_api_key_hint: string | null;
  audit_retention_days: number | null;
  notify_email_enabled: boolean;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_pass_configured: boolean;
  smtp_pass_hint: string | null;
  notify_email_to: string | null;
  notify_feishu_enabled: boolean;
  feishu_webhook_configured: boolean;
  feishu_webhook_hint: string | null;
  feishu_secret_configured: boolean;
  feishu_secret_hint: string | null;
  notify_feishu_events: string[] | null;
  notify_wecom_enabled: boolean;
  wecom_webhook_configured: boolean;
  wecom_webhook_hint: string | null;
  notify_wecom_events: string[] | null;
  updated_at: Date | string;
}

const SETTINGS_QUERY = `
  select site_name, site_tagline, brand_primary, brand_strong, brand_deep, brand_soft,
         ai_enabled, ai_base_url, ai_model_pro, ai_model_flash,
         ai_api_key_enc is not null as key_configured, ai_api_key_hint,
         audit_retention_days,
         notify_email_enabled, smtp_host, smtp_port, smtp_user,
         smtp_pass_enc is not null as smtp_pass_configured, smtp_pass_hint,
         notify_email_to,
         notify_feishu_enabled,
         feishu_webhook_enc is not null as feishu_webhook_configured, feishu_webhook_hint,
         feishu_secret_enc is not null as feishu_secret_configured, feishu_secret_hint,
         notify_feishu_events,
         notify_wecom_enabled,
         wecom_webhook_enc is not null as wecom_webhook_configured, wecom_webhook_hint,
         notify_wecom_events,
         updated_at
    from app_settings
   where id = 1
`;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function settingsResource(context: UserContext): PermissionResource {
  const departmentId = context.activeDepartmentId;
  return { kind: "department", id: departmentId ?? undefined, departmentId };
}

async function requireSettingsPermission(client: PoolClient, context: UserContext): Promise<void> {
  await requireContextPermission(client, context, "platform:settings", settingsResource(context));
}

function requiredText(value: unknown, label: string, max: number): string {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new SettingsInputError(`${label}不能为空`);
  }
  if (text.length > max) {
    throw new SettingsInputError(`${label}不能超过 ${max} 个字符`);
  }
  return text;
}

function optionalText(value: unknown, max: number): string | null {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  if (text.length > max) {
    throw new SettingsInputError(`内容不能超过 ${max} 个字符`);
  }
  return text;
}

function hexColor(value: unknown, label: string, fallback: string): string {
  const text = String(value ?? "").trim() || fallback;
  if (!HEX_COLOR.test(text)) {
    throw new SettingsInputError(`${label}必须是 #RRGGBB 格式`);
  }
  return text.toLowerCase();
}

function normalizeHex(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

function normalizeText(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const text = value.trim();
  return text ? text.slice(0, max) : fallback;
}

/** 数据库 text[] → 只保留已知事件，顺序固定；空数组保持为空（表示不接收业务事件） */
function normalizeEventKeys(raw: unknown): SubscriptionEventKey[] {
  if (!Array.isArray(raw)) {
    return [...SUBSCRIPTION_EVENTS];
  }
  const set = new Set(raw.map((item) => String(item)));
  return SUBSCRIPTION_EVENTS.filter((key) => set.has(key));
}

function channelView(
  enabled: boolean,
  webhookConfigured: boolean,
  webhookHintValue: string | null,
  secretConfigured: boolean,
  secretHintValue: string | null,
  events: unknown,
) {
  return {
    enabled,
    webhookConfigured,
    webhookHint: webhookHintValue,
    secretConfigured,
    secretHint: secretHintValue,
    events: normalizeEventKeys(events),
  };
}

// ---------------------------------------------------------------------------
// 读（用户上下文）
// ---------------------------------------------------------------------------

export async function readPlatformSettings(context: UserContext): Promise<PlatformSettingsView> {
  return withUserContext(context, async (client) => {
    await requireSettingsPermission(client, context);

    const { rows } = await client.query<SettingsRow>(SETTINGS_QUERY);
    const row = rows[0];

    const auditStats = await client.query<{ total: number; earliest: Date | null }>(
      "select count(*)::int as total, min(created_at) as earliest from audit_events",
    );

    const deliveries = await client.query<{
      created_at: Date;
      action: string;
      payload: Record<string, unknown> | null;
    }>(
      `select created_at, action, payload
         from audit_events
        where action in ('notification.sent', 'notification.failed')
        order by created_at desc
        limit 8`,
    );

    return {
      branding: row
        ? {
            siteName: row.site_name,
            siteTagline: row.site_tagline,
            brandPrimary: normalizeHex(row.brand_primary, DEFAULT_BRANDING.brandPrimary),
            brandStrong: normalizeHex(row.brand_strong, DEFAULT_BRANDING.brandStrong),
            brandDeep: normalizeHex(row.brand_deep, DEFAULT_BRANDING.brandDeep),
            brandSoft: normalizeHex(row.brand_soft, DEFAULT_BRANDING.brandSoft),
          }
        : DEFAULT_BRANDING,
      ai: {
        enabled: row?.ai_enabled ?? null,
        baseUrl: row?.ai_base_url ?? null,
        modelPro: row?.ai_model_pro ?? null,
        modelFlash: row?.ai_model_flash ?? null,
        keyConfigured: Boolean(row?.key_configured),
        keyHint: row?.ai_api_key_hint ?? null,
      },
      audit: {
        retentionDays: row?.audit_retention_days ?? null,
        totalEvents: auditStats.rows[0]?.total ?? 0,
        earliestEventAt: auditStats.rows[0]?.earliest
          ? new Date(auditStats.rows[0].earliest).toISOString()
          : null,
      },
      notifications: {
        enabled: Boolean(row?.notify_email_enabled),
        smtpHost: row?.smtp_host ?? null,
        smtpPort: row?.smtp_port ?? null,
        smtpUser: row?.smtp_user ?? null,
        passConfigured: Boolean(row?.smtp_pass_configured),
        passHint: row?.smtp_pass_hint ?? null,
        to: row?.notify_email_to ?? null,
        feishu: channelView(
          Boolean(row?.notify_feishu_enabled),
          Boolean(row?.feishu_webhook_configured),
          row?.feishu_webhook_hint ?? null,
          Boolean(row?.feishu_secret_configured),
          row?.feishu_secret_hint ?? null,
          row?.notify_feishu_events,
        ),
        wecom: channelView(
          Boolean(row?.notify_wecom_enabled),
          Boolean(row?.wecom_webhook_configured),
          row?.wecom_webhook_hint ?? null,
          false,
          null,
          row?.notify_wecom_events,
        ),
        recent: deliveries.rows.map((item) => {
          const payload = item.payload ?? {};
          return {
            at: new Date(item.created_at).toISOString(),
            channel: String(payload.channel ?? "—"),
            event: String(payload.event ?? "—"),
            ok: item.action === "notification.sent",
            error: typeof payload.error === "string" ? payload.error : null,
          };
        }),
      },
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  });
}

/** 启动期 / 运行时覆盖读取：走 SECURITY DEFINER，不需要用户上下文 */
export async function readRuntimeSettings(): Promise<RuntimeSettings> {
  const { rows } = await getPool().query<{ value: Record<string, unknown> | null }>(
    "select app.runtime_settings() as value",
  );
  const raw = rows[0]?.value ?? {};
  const retention = Number(raw.audit_retention_days);
  return {
    aiEnabled: typeof raw.ai_enabled === "boolean" ? raw.ai_enabled : null,
    aiBaseUrl: typeof raw.ai_base_url === "string" ? raw.ai_base_url : null,
    aiApiKeyEnc: typeof raw.ai_api_key_enc === "string" ? raw.ai_api_key_enc : null,
    aiApiKeyHint: typeof raw.ai_api_key_hint === "string" ? raw.ai_api_key_hint : null,
    aiModelPro: typeof raw.ai_model_pro === "string" ? raw.ai_model_pro : null,
    aiModelFlash: typeof raw.ai_model_flash === "string" ? raw.ai_model_flash : null,
    auditRetentionDays: Number.isFinite(retention) && retention >= 30 ? retention : null,
    notifyEmailEnabled: raw.notify_email_enabled === true,
    smtpHost: typeof raw.smtp_host === "string" && raw.smtp_host ? raw.smtp_host : null,
    smtpPort: Number.isFinite(Number(raw.smtp_port)) && Number(raw.smtp_port) > 0
      ? Number(raw.smtp_port)
      : null,
    smtpUser: typeof raw.smtp_user === "string" && raw.smtp_user ? raw.smtp_user : null,
    smtpPassEnc: typeof raw.smtp_pass_enc === "string" && raw.smtp_pass_enc ? raw.smtp_pass_enc : null,
    smtpPassHint: typeof raw.smtp_pass_hint === "string" && raw.smtp_pass_hint ? raw.smtp_pass_hint : null,
    notifyEmailTo:
      typeof raw.notify_email_to === "string" && raw.notify_email_to ? raw.notify_email_to : null,
  };
}

// ---------------------------------------------------------------------------
// 公开品牌：登录页与全站主题（无身份依赖，短 TTL 缓存）
// ---------------------------------------------------------------------------

let brandingCache: { value: BrandingSettings; expiresAt: number } | null = null;
const BRANDING_TTL_MS = 30_000;

export function invalidateBrandingCache(): void {
  brandingCache = null;
}

export async function getPublicBranding(): Promise<BrandingSettings> {
  if (brandingCache && brandingCache.expiresAt > Date.now()) {
    return brandingCache.value;
  }
  try {
    const { rows } = await getPool().query<{ value: Record<string, unknown> | null }>(
      "select app.public_branding() as value",
    );
    const raw = rows[0]?.value ?? {};
    const value: BrandingSettings = {
      siteName: normalizeText(raw.site_name, DEFAULT_BRANDING.siteName, 40),
      siteTagline: normalizeText(raw.site_tagline, DEFAULT_BRANDING.siteTagline, 120),
      brandPrimary: normalizeHex(raw.brand_primary, DEFAULT_BRANDING.brandPrimary),
      brandStrong: normalizeHex(raw.brand_strong, DEFAULT_BRANDING.brandStrong),
      brandDeep: normalizeHex(raw.brand_deep, DEFAULT_BRANDING.brandDeep),
      brandSoft: normalizeHex(raw.brand_soft, DEFAULT_BRANDING.brandSoft),
    };
    brandingCache = { value, expiresAt: Date.now() + BRANDING_TTL_MS };
    return value;
  } catch {
    // 建库前 / 数据库暂不可用时回退默认品牌，不阻断登录页
    return DEFAULT_BRANDING;
  }
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

export async function saveBranding(context: UserContext, input: BrandingSettings): Promise<void> {
  const clean: BrandingSettings = {
    siteName: requiredText(input.siteName, "站点名称", 40),
    siteTagline: optionalText(input.siteTagline, 120) ?? "",
    brandPrimary: hexColor(input.brandPrimary, "品牌主色", DEFAULT_BRANDING.brandPrimary),
    brandStrong: hexColor(input.brandStrong, "品牌深色", DEFAULT_BRANDING.brandStrong),
    brandDeep: hexColor(input.brandDeep, "品牌最深色", DEFAULT_BRANDING.brandDeep),
    brandSoft: hexColor(input.brandSoft, "品牌浅色", DEFAULT_BRANDING.brandSoft),
  };

  await withUserContext(context, async (client) => {
    await requireSettingsPermission(client, context);
    await client.query(
      `update app_settings
          set site_name = $1, site_tagline = $2,
              brand_primary = $3, brand_strong = $4, brand_deep = $5, brand_soft = $6,
              updated_at = now(), updated_by_user_id = $7
        where id = 1`,
      [
        clean.siteName,
        clean.siteTagline,
        clean.brandPrimary,
        clean.brandStrong,
        clean.brandDeep,
        clean.brandSoft,
        context.userId,
      ],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "settings.brand_updated",
      targetType: "app_settings",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: {
        site_name: clean.siteName,
        brand_primary: clean.brandPrimary,
        brand_strong: clean.brandStrong,
        brand_deep: clean.brandDeep,
        brand_soft: clean.brandSoft,
      },
    });
  });

  invalidateBrandingCache();
}

export interface AiSettingsInput {
  enabled: boolean | null;
  baseUrl: string;
  modelPro: string;
  modelFlash: string;
  /** 空字符串 = 保留已保存 Key；CLEAR_API_KEY = 清除 */
  apiKey: string;
}

export interface AiSettingsSaved {
  keyConfigured: boolean;
  keyHint: string | null;
}

export async function saveAiSettings(
  context: UserContext,
  input: AiSettingsInput,
): Promise<AiSettingsSaved> {
  const baseUrl = optionalText(input.baseUrl, 300);
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new SettingsInputError("Base URL 不是合法地址");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new SettingsInputError("Base URL 只支持 http / https");
    }
  }
  const modelPro = optionalText(input.modelPro, 100);
  const modelFlash = optionalText(input.modelFlash, 100);
  const rawKey = input.apiKey.trim();
  if (rawKey && rawKey !== CLEAR_API_KEY && rawKey.length > 500) {
    throw new SettingsInputError("API Key 过长");
  }

  let saved: AiSettingsSaved = { keyConfigured: false, keyHint: null };

  await withUserContext(context, async (client) => {
    await requireSettingsPermission(client, context);

    const current = await client.query<{
      ai_api_key_enc: string | null;
      ai_api_key_hint: string | null;
    }>("select ai_api_key_enc, ai_api_key_hint from app_settings where id = 1");
    const existing = current.rows[0];

    let nextEnc = existing?.ai_api_key_enc ?? null;
    let nextHint = existing?.ai_api_key_hint ?? null;
    let keyChanged = false;

    if (rawKey === CLEAR_API_KEY) {
      keyChanged = nextEnc !== null;
      nextEnc = null;
      nextHint = null;
    } else if (rawKey) {
      nextEnc = encryptSecret(rawKey);
      nextHint = secretHint(rawKey);
      keyChanged = true;
    }

    const normalizedBaseUrl = baseUrl ? baseUrl.replace(/\/+$/, "") : null;

    await client.query(
      `update app_settings
          set ai_enabled = $1, ai_base_url = $2, ai_model_pro = $3, ai_model_flash = $4,
              ai_api_key_enc = $5, ai_api_key_hint = $6,
              updated_at = now(), updated_by_user_id = $7
        where id = 1`,
      [
        input.enabled,
        normalizedBaseUrl,
        modelPro,
        modelFlash,
        nextEnc,
        nextHint,
        context.userId,
      ],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "settings.ai_updated",
      targetType: "app_settings",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: {
        enabled: input.enabled,
        base_url: normalizedBaseUrl,
        model_pro: modelPro,
        model_flash: modelFlash,
        api_key_changed: keyChanged,
        api_key_configured: nextEnc !== null,
      },
    });

    saved = { keyConfigured: nextEnc !== null, keyHint: nextHint };
  });

  return saved;
}

export async function saveAuditRetention(
  context: UserContext,
  days: number | null,
): Promise<void> {
  if (days !== null && (!Number.isInteger(days) || days < 30 || days > 3650)) {
    throw new SettingsInputError("留存天数必须是 30–3650 之间的整数");
  }

  await withUserContext(context, async (client) => {
    await requireSettingsPermission(client, context);
    await client.query(
      `update app_settings
          set audit_retention_days = $1, updated_at = now(), updated_by_user_id = $2
        where id = 1`,
      [days, context.userId],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "settings.audit_retention_updated",
      targetType: "app_settings",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: { retention_days: days },
    });
  });
}

export interface NotificationSettingsInput {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number | null;
  smtpUser: string;
  /** 空字符串 = 保留已保存口令；CLEAR_API_KEY = 清除 */
  smtpPass: string;
  /** 逗号 / 分号 / 空白分隔的收件人列表 */
  to: string;
}

export interface NotificationSettingsSaved {
  passConfigured: boolean;
  passHint: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeRecipients(raw: string): string[] {
  const list = raw
    .split(/[,;，；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const unique: string[] = [];
  for (const item of list) {
    if (!EMAIL.test(item)) {
      throw new SettingsInputError(`收件人邮箱格式不正确：${item.slice(0, 60)}`);
    }
    if (!unique.includes(item)) {
      unique.push(item);
    }
  }
  return unique;
}

export async function saveNotificationSettings(
  context: UserContext,
  input: NotificationSettingsInput,
): Promise<NotificationSettingsSaved> {
  const smtpHost = optionalText(input.smtpHost, 255);
  const smtpUser = optionalText(input.smtpUser, 255);
  const recipients = normalizeRecipients(input.to);
  const smtpPort = input.smtpPort;

  if (input.enabled) {
    if (!smtpHost) {
      throw new SettingsInputError("启用邮件通知时必须填写 SMTP_HOST");
    }
    if (smtpPort === null || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
      throw new SettingsInputError("SMTP 端口必须是 1–65535 之间的整数");
    }
    if (recipients.length === 0) {
      throw new SettingsInputError("启用邮件通知时必须至少填写一个收件人");
    }
  } else if (smtpPort !== null && (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)) {
    throw new SettingsInputError("SMTP 端口必须是 1–65535 之间的整数");
  }

  const rawPass = input.smtpPass.trim();
  if (rawPass && rawPass !== CLEAR_API_KEY && rawPass.length > 500) {
    throw new SettingsInputError("SMTP 口令过长");
  }

  let saved: NotificationSettingsSaved = { passConfigured: false, passHint: null };

  await withUserContext(context, async (client) => {
    await requireSettingsPermission(client, context);

    const current = await client.query<{
      smtp_pass_enc: string | null;
      smtp_pass_hint: string | null;
    }>("select smtp_pass_enc, smtp_pass_hint from app_settings where id = 1");
    const existing = current.rows[0];

    let nextEnc = existing?.smtp_pass_enc ?? null;
    let nextHint = existing?.smtp_pass_hint ?? null;
    let passChanged = false;

    if (rawPass === CLEAR_API_KEY) {
      passChanged = nextEnc !== null;
      nextEnc = null;
      nextHint = null;
    } else if (rawPass) {
      nextEnc = encryptSecret(rawPass);
      nextHint = secretHint(rawPass);
      passChanged = true;
    }

    await client.query(
      `update app_settings
          set notify_email_enabled = $1,
              smtp_host = $2,
              smtp_port = $3,
              smtp_user = $4,
              smtp_pass_enc = $5,
              smtp_pass_hint = $6,
              notify_email_to = $7,
              updated_at = now(),
              updated_by_user_id = $8
        where id = 1`,
      [
        input.enabled,
        smtpHost,
        smtpPort,
        smtpUser,
        nextEnc,
        nextHint,
        recipients.length > 0 ? recipients.join(", ") : null,
        context.userId,
      ],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "settings.notification_updated",
      targetType: "app_settings",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: {
        enabled: input.enabled,
        smtp_host: smtpHost,
        smtp_port: smtpPort,
        recipient_count: recipients.length,
        password_changed: passChanged,
        password_configured: nextEnc !== null,
      },
    });

    saved = { passConfigured: nextEnc !== null, passHint: nextHint };
  });

  return saved;
}

// ---------------------------------------------------------------------------
// IM 群机器人（飞书 / 企微）
// ---------------------------------------------------------------------------

export type ImChannelKey = "feishu" | "wecom";

interface ChannelColumns {
  label: string;
  enabled: string;
  webhookEnc: string;
  webhookHint: string;
  /** 仅飞书有签名密钥 */
  secretEnc: string | null;
  secretHint: string | null;
  events: string;
}

const CHANNEL_COLUMNS: Record<ImChannelKey, ChannelColumns> = {
  feishu: {
    label: "飞书",
    enabled: "notify_feishu_enabled",
    webhookEnc: "feishu_webhook_enc",
    webhookHint: "feishu_webhook_hint",
    secretEnc: "feishu_secret_enc",
    secretHint: "feishu_secret_hint",
    events: "notify_feishu_events",
  },
  wecom: {
    label: "企业微信",
    enabled: "notify_wecom_enabled",
    webhookEnc: "wecom_webhook_enc",
    webhookHint: "wecom_webhook_hint",
    secretEnc: null,
    secretHint: null,
    events: "notify_wecom_events",
  },
};

export interface ChannelSettingsInput {
  channel: ImChannelKey;
  enabled: boolean;
  /** 空字符串 = 保留已保存地址；CLEAR_API_KEY = 清除 */
  webhook: string;
  /** 仅飞书：空字符串 = 保留；CLEAR_API_KEY = 清除 */
  secret?: string;
  events: string[];
}

export interface ChannelSettingsSaved {
  webhookConfigured: boolean;
  webhookHint: string | null;
  secretConfigured: boolean;
  secretHint: string | null;
}

function parseWebhookUrl(raw: string, label: string): URL {
  if (raw.length > 2000) {
    throw new SettingsInputError(`${label} Webhook 地址过长`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SettingsInputError(`${label} Webhook 地址不是合法 URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SettingsInputError(`${label} Webhook 地址必须以 http:// 或 https:// 开头`);
  }
  if (!parsed.hostname) {
    throw new SettingsInputError(`${label} Webhook 地址缺少主机名`);
  }
  return parsed;
}

function webhookHint(raw: string, parsed: URL): string {
  return `${parsed.host} ····${raw.slice(-4)}`;
}

function normalizeInputEvents(raw: unknown): SubscriptionEventKey[] {
  const list = Array.isArray(raw) ? raw.map((item) => String(item)) : [];
  const set = new Set(list);
  for (const key of set) {
    if (!(SUBSCRIPTION_EVENTS as readonly string[]).includes(key)) {
      throw new SettingsInputError(`未知的通知事件：${key.slice(0, 40)}`);
    }
  }
  return SUBSCRIPTION_EVENTS.filter((key) => set.has(key));
}

export async function saveChannelSettings(
  context: UserContext,
  input: ChannelSettingsInput,
): Promise<ChannelSettingsSaved> {
  const spec = CHANNEL_COLUMNS[input.channel];
  if (!spec) {
    throw new SettingsInputError("未知的通知渠道");
  }

  const events = normalizeInputEvents(input.events);
  if (input.enabled && events.length === 0) {
    throw new SettingsInputError(`启用${spec.label}通知时至少选择一个事件`);
  }

  const rawWebhook = String(input.webhook ?? "").trim();
  let parsedWebhook: URL | null = null;
  if (rawWebhook && rawWebhook !== CLEAR_API_KEY) {
    parsedWebhook = parseWebhookUrl(rawWebhook, spec.label);
  }

  const rawSecret = String(input.secret ?? "").trim();

  let saved: ChannelSettingsSaved = {
    webhookConfigured: false,
    webhookHint: null,
    secretConfigured: false,
    secretHint: null,
  };

  await withUserContext(context, async (client) => {
    await requireSettingsPermission(client, context);

    const current = await client.query<{
      webhook_enc: string | null;
      webhook_hint: string | null;
      secret_enc: string | null;
      secret_hint: string | null;
    }>(
      `select ${spec.webhookEnc} as webhook_enc, ${spec.webhookHint} as webhook_hint` +
        (spec.secretEnc
          ? `, ${spec.secretEnc} as secret_enc, ${spec.secretHint} as secret_hint`
          : ", null::text as secret_enc, null::text as secret_hint") +
        " from app_settings where id = 1",
    );
    const existing = current.rows[0];

    let nextWebhookEnc = existing?.webhook_enc ?? null;
    let nextWebhookHint = existing?.webhook_hint ?? null;
    if (rawWebhook === CLEAR_API_KEY) {
      nextWebhookEnc = null;
      nextWebhookHint = null;
    } else if (parsedWebhook) {
      nextWebhookEnc = encryptSecret(rawWebhook);
      nextWebhookHint = webhookHint(rawWebhook, parsedWebhook);
    }

    if (input.enabled && !nextWebhookEnc) {
      throw new SettingsInputError(`启用${spec.label}通知时必须填写 Webhook 地址`);
    }
    if (input.enabled && nextWebhookEnc && decryptSecret(nextWebhookEnc) === null) {
      throw new SettingsInputError(
        `已保存的${spec.label} Webhook 无法解密（加密密钥可能已轮换），请重新填写地址`,
      );
    }

    let nextSecretEnc = existing?.secret_enc ?? null;
    let nextSecretHint = existing?.secret_hint ?? null;
    if (spec.secretEnc) {
      if (rawSecret === CLEAR_API_KEY) {
        nextSecretEnc = null;
        nextSecretHint = null;
      } else if (rawSecret) {
        nextSecretEnc = encryptSecret(rawSecret);
        nextSecretHint = secretHint(rawSecret);
      }
    }

    const params: unknown[] = [input.enabled, nextWebhookEnc, nextWebhookHint, events];
    let sql = `update app_settings
                  set ${spec.enabled} = $1,
                      ${spec.webhookEnc} = $2,
                      ${spec.webhookHint} = $3,
                      ${spec.events} = $4::text[]`;
    if (spec.secretEnc) {
      params.push(nextSecretEnc, nextSecretHint);
      sql += `, ${spec.secretEnc} = $5, ${spec.secretHint} = $6`;
    }
    params.push(context.userId);
    sql += `, updated_at = now(), updated_by_user_id = $${params.length} where id = 1`;
    await client.query(sql, params);

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "settings.notification_channel_updated",
      targetType: "app_settings",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: {
        channel: input.channel,
        enabled: input.enabled,
        webhook_changed: parsedWebhook !== null || rawWebhook === CLEAR_API_KEY,
        webhook_configured: nextWebhookEnc !== null,
        webhook_host: parsedWebhook?.host ?? null,
        secret_configured: nextSecretEnc !== null,
        events,
      },
    });

    saved = {
      webhookConfigured: nextWebhookEnc !== null,
      webhookHint: nextWebhookHint,
      secretConfigured: nextSecretEnc !== null,
      secretHint: nextSecretHint,
    };
  });

  return saved;
}
