/**
 * 通知配置解析：设置面（app_settings）优先，环境变量兜底（仅邮件）。
 *
 * - 单次读取 app.runtime_settings()，30 秒进程内缓存；保存设置后调用 invalidate 立即生效。
 * - Webhook 地址与飞书签名密钥按密文入库，这里解密后只在进程内使用。
 */

import { getPool } from "@/lib/db/pool";
import { errorMessage, log } from "@/lib/logger";
import { decryptSecret } from "@/lib/settings/crypto";

import { SUBSCRIPTION_EVENTS, type SubscriptionEventKey } from "./content";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
  to: string[];
}

export interface MailConfigResolution {
  config: SmtpConfig | null;
  /** config 为 null 时说明原因，便于日志、测试与「测试发送」提示 */
  reason: string | null;
}

export type ImChannelKey = "feishu" | "wecom";

export interface ImChannelTarget {
  channel: ImChannelKey;
  webhook: string;
  /** 仅飞书使用；未配置签名为 null */
  secret: string | null;
  events: SubscriptionEventKey[];
}

export interface ChannelTargets {
  email: SmtpConfig | null;
  emailReason: string | null;
  feishu: ImChannelTarget | null;
  wecom: ImChannelTarget | null;
}

interface NotificationRow {
  notify_email_enabled: boolean | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_pass_enc: string | null;
  notify_email_to: string | null;
  notify_feishu_enabled: boolean | null;
  feishu_webhook_enc: string | null;
  feishu_secret_enc: string | null;
  notify_feishu_events: unknown;
  notify_wecom_enabled: boolean | null;
  wecom_webhook_enc: string | null;
  notify_wecom_events: unknown;
}

const CACHE_TTL_MS = 30_000;
let cache: { row: NotificationRow | null; expiresAt: number } | null = null;

export function invalidateNotificationConfigCache(): void {
  cache = null;
}

async function readNotificationRow(): Promise<NotificationRow | null> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.row;
  }
  try {
    const { rows } = await getPool().query<{ value: NotificationRow | null }>(
      "select app.runtime_settings() as value",
    );
    const row = rows[0]?.value ?? null;
    cache = { row, expiresAt: Date.now() + CACHE_TTL_MS };
    return row;
  } catch (caught) {
    // 数据库暂不可用：退回环境变量，不阻断调用方
    log("warn", "notification_settings_read_failed", { error: errorMessage(caught) });
    return null;
  }
}

function splitRecipients(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(/[,;，；\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.includes("@"));
}

function envPort(): number {
  const parsed = Number.parseInt(process.env.SMTP_PORT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 587;
}

function normalizeEvents(raw: unknown): SubscriptionEventKey[] {
  if (!Array.isArray(raw)) {
    return [...SUBSCRIPTION_EVENTS];
  }
  const set = new Set(raw.map((item) => String(item)));
  return SUBSCRIPTION_EVENTS.filter((key) => set.has(key));
}

function buildImTarget(
  channel: ImChannelKey,
  enabled: boolean | null,
  encrypted: string | null,
  secretEncrypted: string | null,
  events: unknown,
): ImChannelTarget | null {
  if (enabled !== true) {
    return null;
  }
  if (!encrypted) {
    return null;
  }
  const webhook = decryptSecret(encrypted);
  if (!webhook) {
    log("warn", "notification_webhook_decrypt_failed", { channel });
    return null;
  }
  const secret = secretEncrypted ? decryptSecret(secretEncrypted) : null;
  return { channel, webhook, secret, events: normalizeEvents(events) };
}

/**
 * 邮件配置：
 * - 设置面显式启用 → 以设置面为准；
 * - 设置面从未配置（没有 smtp_host）且环境变量配了收件人 → 使用环境变量；
 * - 其余情况视为未配置。
 */
export async function resolveMailConfig(): Promise<MailConfigResolution> {
  const row = await readNotificationRow();

  const dbHost = row?.smtp_host?.trim() || null;
  const dbTo = splitRecipients(row?.notify_email_to);
  const dbEnabled = row?.notify_email_enabled === true;
  const envHost = process.env.SMTP_HOST?.trim() || null;
  const envTo = splitRecipients(process.env.NOTIFICATION_EMAIL_TO);

  const useEnv = !dbHost && envTo.length > 0;
  if (!dbEnabled && !useEnv) {
    return { config: null, reason: "邮件通知未启用" };
  }

  const host = dbEnabled ? dbHost ?? envHost : envHost;
  const to = dbEnabled ? dbTo : envTo;
  if (!host) {
    return { config: null, reason: "缺少 SMTP_HOST" };
  }
  if (to.length === 0) {
    return { config: null, reason: "缺少收件人（NOTIFICATION_EMAIL_TO）" };
  }

  const port = dbEnabled ? row?.smtp_port ?? envPort() : envPort();
  const user = (dbEnabled ? row?.smtp_user : process.env.SMTP_USER)?.trim() || null;

  let pass: string | null = null;
  if (dbEnabled && row?.smtp_pass_enc) {
    pass = decryptSecret(row.smtp_pass_enc);
    if (pass === null) {
      log("warn", "notification_smtp_pass_decrypt_failed", { host });
    }
  } else if (process.env.SMTP_PASS) {
    pass = process.env.SMTP_PASS;
  }

  return {
    config: {
      host,
      port,
      secure: port === 465,
      user,
      pass,
      from: process.env.SMTP_FROM?.trim() || user || "no-reply@jxf.local",
      to,
    },
    reason: null,
  };
}

/** 生效的渠道集合：未启用的渠道为 null，由派发层安静跳过 */
export async function resolveChannelTargets(): Promise<ChannelTargets> {
  const row = await readNotificationRow();
  const mail = await resolveMailConfig();
  return {
    email: mail.config,
    emailReason: mail.reason,
    feishu: row
      ? buildImTarget(
          "feishu",
          row.notify_feishu_enabled,
          row.feishu_webhook_enc,
          row.feishu_secret_enc,
          row.notify_feishu_events,
        )
      : null,
    wecom: row
      ? buildImTarget(
          "wecom",
          row.notify_wecom_enabled,
          row.wecom_webhook_enc,
          null,
          row.notify_wecom_events,
        )
      : null,
  };
}
