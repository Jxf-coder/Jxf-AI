/**
 * 通知派发：事件 → 各已启用渠道（邮件 / 飞书 / 企微）。
 *
 * - 单渠道失败不影响其它渠道，也不上抛业务主链路；
 * - 订阅过滤只作用于业务事件，设置面的「测试发送」始终放行；
 * - 每次投递写审计（notification.sent / notification.failed），便于回答「为什么没收到」。
 */

import { auditStandalone } from "@/lib/audit";
import { errorMessage, log } from "@/lib/logger";

import { resolveChannelTargets, type ChannelTargets } from "./config";
import {
  buildHealthAlert,
  buildOpsFailure,
  buildPipelineFailure,
  isSubscribed,
  toEmailMessage,
  type HealthAlertLike,
  type NotificationContent,
  type OpsFailureLike,
  type PipelineFailureLike,
} from "./content";
import { sendFeishuMessage } from "./feishu";
import type { ChannelSendResult, FetchLike } from "./http";
import { sendNotification } from "./mailer";
import { sendWecomMessage } from "./wecom";

export type NotificationChannelName = "email" | "feishu" | "wecom";

export interface DispatchResult {
  channel: NotificationChannelName;
  ok: boolean;
  skipped: boolean;
  error: string | null;
  durationMs: number;
}

export interface DispatchOptions {
  /** 测试或脚本可注入已解析的目标，跳过设置面读取 */
  targets?: ChannelTargets;
  fetchImpl?: FetchLike;
  /** 默认写审计；测试可关闭 */
  audit?: boolean;
}

interface Job {
  channel: NotificationChannelName;
  run: () => Promise<ChannelSendResult>;
}

async function writeAudit(content: NotificationContent, result: DispatchResult): Promise<void> {
  await auditStandalone({
    actorUserId: null,
    action: result.ok ? "notification.sent" : "notification.failed",
    targetType: "notification_channel",
    targetId: null,
    payload: {
      channel: result.channel,
      event: content.event,
      title: content.title,
      duration_ms: result.durationMs,
      error: result.error ? result.error.slice(0, 300) : null,
    },
  });
}

/** 把内容发往所有已启用且订阅了该事件的渠道 */
export async function dispatchNotification(
  content: NotificationContent,
  options: DispatchOptions = {},
): Promise<DispatchResult[]> {
  const targets = options.targets ?? (await resolveChannelTargets());
  const jobs: Job[] = [];

  if (targets.email) {
    const emailConfig = targets.email;
    jobs.push({
      channel: "email",
      run: () =>
        sendNotification(toEmailMessage(content), { config: emailConfig }).then((result) => ({
          sent: result.sent,
          skipped: result.skipped,
          error: result.error,
        })),
    });
  }

  if (targets.feishu && isSubscribed(targets.feishu.events, content.event)) {
    const target = targets.feishu;
    jobs.push({
      channel: "feishu",
      run: () => sendFeishuMessage(target, content, { fetchImpl: options.fetchImpl }),
    });
  }

  if (targets.wecom && isSubscribed(targets.wecom.events, content.event)) {
    const target = targets.wecom;
    jobs.push({
      channel: "wecom",
      run: () => sendWecomMessage(target, content, { fetchImpl: options.fetchImpl }),
    });
  }

  const results = await Promise.all(
    jobs.map(async (job): Promise<DispatchResult> => {
      const startedAt = Date.now();
      try {
        const outcome = await job.run();
        return {
          channel: job.channel,
          ok: outcome.sent,
          skipped: outcome.skipped,
          error: outcome.error,
          durationMs: Date.now() - startedAt,
        };
      } catch (caught) {
        return {
          channel: job.channel,
          ok: false,
          skipped: false,
          error: errorMessage(caught),
          durationMs: Date.now() - startedAt,
        };
      }
    }),
  );

  for (const result of results) {
    log(result.ok ? "info" : "warn", result.ok ? "notification_sent" : "notification_failed", {
      channel: result.channel,
      event: content.event,
      duration_ms: result.durationMs,
      error: result.error,
    });
    if (options.audit !== false) {
      await writeAudit(content, result).catch((caught) => {
        log("warn", "notification_audit_failed", { error: errorMessage(caught) });
      });
    }
  }

  return results;
}

export async function notifyHealthAlert(alert: HealthAlertLike): Promise<void> {
  await dispatchNotification(buildHealthAlert(alert));
}

export async function notifyOpsTaskFailure(task: OpsFailureLike): Promise<void> {
  await dispatchNotification(buildOpsFailure(task));
}

export async function notifyPipelineFailure(input: PipelineFailureLike): Promise<void> {
  await dispatchNotification(buildPipelineFailure(input));
}
