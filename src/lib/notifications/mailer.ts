/**
 * 邮件通知（SMTP）。
 *
 * 配置来源：设置面（app_settings）优先，环境变量兜底。
 * 口令与模型 Key 一样加密入库；本模块不解密任何非通知字段。
 *
 * 未配置时安静跳过（skipped），不影响业务主链路；发送失败只落 warn 日志。
 */

import nodemailer from "nodemailer";

import { getPool } from "@/lib/db/pool";
import { errorMessage, log } from "@/lib/logger";
import { decryptSecret } from "@/lib/settings/crypto";

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
  /** config 为 null 时说明原因，便于日志与测试断言 */
  reason: string | null;
}

export interface NotificationMessage {
  subject: string;
  text: string;
  html?: string;
}

export interface MailTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<{ messageId?: string }>;
}

export type TransportFactory = (config: SmtpConfig) => MailTransport;

export interface SendResult {
  sent: boolean;
  skipped: boolean;
  error: string | null;
  messageId: string | null;
}

interface NotificationRow {
  notify_email_enabled: boolean | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_pass_enc: string | null;
  notify_email_to: string | null;
}

interface ResolvedRow {
  value: NotificationRow | null;
  ok: boolean;
}

const CACHE_TTL_MS = 30_000;
let cache: { row: NotificationRow | null; expiresAt: number } | null = null;

export function invalidateMailConfigCache(): void {
  cache = null;
}

async function readNotificationRow(): Promise<ResolvedRow> {
  if (cache && cache.expiresAt > Date.now()) {
    return { value: cache.row, ok: true };
  }
  try {
    const { rows } = await getPool().query<{ value: NotificationRow | null }>(
      "select app.runtime_settings() as value",
    );
    const row = rows[0]?.value ?? null;
    cache = { row, expiresAt: Date.now() + CACHE_TTL_MS };
    return { value: row, ok: true };
  } catch (caught) {
    // 数据库暂不可用：退回环境变量，不阻断调用方
    log("warn", "notification_settings_read_failed", { error: errorMessage(caught) });
    return { value: null, ok: false };
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

/**
 * 解析生效配置。
 * - 设置面显式启用 → 以设置面为准；
 * - 设置面从未配置（没有 smtp_host）且环境变量配了收件人 → 使用环境变量；
 * - 其余情况视为未配置。
 */
export async function resolveMailConfig(): Promise<MailConfigResolution> {
  const { value: row } = await readNotificationRow();

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

function defaultTransportFactory(config: SmtpConfig): MailTransport {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass ?? "" } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/**
 * 发送通知。业务主链路不应因邮件失败而失败：
 * 调用方通常 fire-and-forget 或只记录返回值。
 */
export async function sendNotification(
  message: NotificationMessage,
  deps: { config?: SmtpConfig | null; factory?: TransportFactory } = {},
): Promise<SendResult> {
  let config = deps.config ?? null;
  if (!config) {
    const resolved = await resolveMailConfig();
    config = resolved.config;
    if (!config) {
      log("info", "notification_skipped", { reason: resolved.reason, subject: message.subject });
      return { sent: false, skipped: true, error: null, messageId: null };
    }
  }

  const factory = deps.factory ?? defaultTransportFactory;
  try {
    const result = await factory(config).sendMail({
      from: config.from,
      to: config.to.join(", "),
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    log("info", "notification_sent", { subject: message.subject, to: config.to.length });
    return { sent: true, skipped: false, error: null, messageId: result.messageId ?? null };
  } catch (caught) {
    const error = errorMessage(caught);
    log("warn", "notification_failed", { subject: message.subject, error });
    return { sent: false, skipped: false, error, messageId: null };
  }
}
