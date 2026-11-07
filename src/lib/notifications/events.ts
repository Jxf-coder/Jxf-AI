/**
 * 通知模板：连接器异常/恢复、运维任务失败、产线失败。
 *
 * 只负责把事件转成纯文本邮件并交给 mailer；
 * 发送失败不上抛，避免影响心跳、runner 与业务主链路。
 */

import { errorMessage, log } from "@/lib/logger";

import { sendNotification, type NotificationMessage } from "./mailer";

export interface HealthAlertLike {
  event: "mcp.connector_unhealthy" | "mcp.connector_recovered";
  connector_id: string;
  connector_name: string;
  status: string;
  failures: number;
  error: string | null;
  at: string;
}

export interface OpsFailureLike {
  id: string;
  kind: string;
  error: string | null;
}

export interface PipelineFailureLike {
  pipelineName: string;
  step: string | null;
  error: string | null;
  runId?: string | null;
}

const PREFIX = "[Jxf-AI]";

function formatUtc(value: string): string {
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}

export function buildHealthAlertEmail(alert: HealthAlertLike): NotificationMessage {
  const recovered = alert.event === "mcp.connector_recovered";
  const title = recovered
    ? `连接器恢复：${alert.connector_name}`
    : `连接器异常：${alert.connector_name}（${alert.status}）`;
  const lines = [
    recovered
      ? `连接器「${alert.connector_name}」已恢复健康，重新参与运行。`
      : `连接器「${alert.connector_name}」连续失败 ${alert.failures} 次，当前状态 ${alert.status}。`,
    "",
    `连接器 ID：${alert.connector_id}`,
    `当前状态：${alert.status}`,
    `连续失败：${alert.failures}`,
    `最近错误：${alert.error ?? "—"}`,
    `发生时间：${formatUtc(alert.at)}`,
    "",
    recovered ? "无需处理；如需复核可到「设置 → MCP 连接器」查看。" : "已熔断的连接器会被 worker 自动跳过；请检查端点、网络与凭证。",
    "",
    "此邮件由系统自动发送，请勿直接回复。",
  ];
  return { subject: `${PREFIX} ${title}`, text: lines.join("\n") };
}

export function buildOpsFailureEmail(task: OpsFailureLike): NotificationMessage {
  const lines = [
    `宿主机运维任务执行失败（${task.kind}）。`,
    "",
    `任务 ID：${task.id}`,
    `任务类型：${task.kind}`,
    `错误信息：${task.error ?? "—"}`,
    "",
    "可在「设置 → 运维任务」查看历史，并在宿主机日志中定位原因。",
    "",
    "此邮件由系统自动发送，请勿直接回复。",
  ];
  return { subject: `${PREFIX} 运维任务失败：${task.kind}`, text: lines.join("\n") };
}

export function buildPipelineFailureEmail(input: PipelineFailureLike): NotificationMessage {
  const lines = [
    `自动化产线执行失败：「${input.pipelineName}」。`,
    "",
    `失败步骤：${input.step ?? "—"}`,
    `错误信息：${input.error ?? "—"}`,
    input.runId ? `运行记录：${input.runId}` : "运行记录：—",
    "",
    "后续步骤已停止；已派出的任务与交付物保留。可在「自动化」页查看运行记录。",
    "",
    "此邮件由系统自动发送，请勿直接回复。",
  ];
  return { subject: `${PREFIX} 产线失败：${input.pipelineName}`, text: lines.join("\n") };
}

async function deliver(message: NotificationMessage, event: string): Promise<void> {
  try {
    await sendNotification(message);
  } catch (caught) {
    log("warn", "notification_dispatch_failed", { event, error: errorMessage(caught) });
  }
}

export async function notifyHealthAlert(alert: HealthAlertLike): Promise<void> {
  await deliver(buildHealthAlertEmail(alert), "mcp_health");
}

export async function notifyOpsTaskFailure(task: OpsFailureLike): Promise<void> {
  await deliver(buildOpsFailureEmail(task), "ops_task");
}

export async function notifyPipelineFailure(input: PipelineFailureLike): Promise<void> {
  await deliver(buildPipelineFailureEmail(input), "pipeline");
}
