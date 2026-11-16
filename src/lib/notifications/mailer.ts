/**
 * 邮件渠道（SMTP）。
 *
 * 配置解析在 config.ts（设置面优先，环境变量兜底）；本模块只负责发送。
 * 未配置时安静跳过（skipped），不影响业务主链路；发送失败只落 warn 日志。
 */

import nodemailer from "nodemailer";

import { log } from "@/lib/logger";

import { resolveMailConfig, type SmtpConfig } from "./config";

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
    log("info", "notification_sent", { channel: "email", subject: message.subject, to: config.to.length });
    return { sent: true, skipped: false, error: null, messageId: result.messageId ?? null };
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    log("warn", "notification_failed", { channel: "email", subject: message.subject, error });
    return { sent: false, skipped: false, error, messageId: null };
  }
}
