/**
 * 通知内容模型与渠道渲染（纯函数，无数据库 / 网络依赖）。
 *
 * 事件模板只写一次，由各渠道渲染器输出：
 * - 邮件：subject + 纯文本正文
 * - 飞书：interactive 卡片
 * - 企微：markdown 消息
 */

export const SUBSCRIPTION_EVENTS = ["mcp_health", "ops_task", "pipeline"] as const;

export type SubscriptionEventKey = (typeof SUBSCRIPTION_EVENTS)[number];

/** 渠道订阅只覆盖业务事件；test 仅用于设置面「测试发送」，不受订阅过滤 */
export type NotificationEventKey = SubscriptionEventKey | "test";

export const SUBSCRIPTION_EVENT_LABELS: Record<SubscriptionEventKey, string> = {
  mcp_health: "连接器异常/恢复",
  ops_task: "运维任务失败",
  pipeline: "产线失败",
};

export type NotificationSeverity = "info" | "warn" | "error";

export interface NotificationField {
  label: string;
  value: string;
}

export interface NotificationContent {
  event: NotificationEventKey;
  title: string;
  severity: NotificationSeverity;
  summary: string;
  fields: NotificationField[];
  /** 站内相对路径；运行态拿不到可信对外域名，渠道里只展示路径文本 */
  path: string | null;
  /** 邮件纯文本正文 */
  text: string;
}

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

function joinText(lines: Array<string | null | undefined>): string {
  return lines.filter((line) => line !== null && line !== undefined).join("\n");
}

export function buildHealthAlert(alert: HealthAlertLike): NotificationContent {
  const recovered = alert.event === "mcp.connector_recovered";
  const title = recovered
    ? `连接器恢复：${alert.connector_name}`
    : `连接器异常：${alert.connector_name}（${alert.status}）`;
  const summary = recovered
    ? `连接器「${alert.connector_name}」已恢复健康，重新参与运行。`
    : `连接器「${alert.connector_name}」连续失败 ${alert.failures} 次，当前状态 ${alert.status}。`;
  const fields: NotificationField[] = [
    { label: "连接器 ID", value: alert.connector_id },
    { label: "当前状态", value: alert.status },
    { label: "连续失败", value: String(alert.failures) },
    { label: "最近错误", value: alert.error ?? "—" },
    { label: "发生时间", value: formatUtc(alert.at) },
  ];
  const hint = recovered
    ? "无需处理；如需复核可到「设置 → MCP 连接」查看。"
    : "已熔断的连接器会被 worker 自动跳过；请检查端点、网络与凭证。";
  return {
    event: "mcp_health",
    title,
    severity: recovered ? "info" : alert.status === "down" ? "error" : "warn",
    summary,
    fields,
    path: "/settings/mcp",
    text: joinText([
      summary,
      "",
      ...fields.map((field) => `${field.label}：${field.value}`),
      "",
      hint,
      "",
      "此消息由系统自动发送，请勿直接回复。",
    ]),
  };
}

export function buildOpsFailure(task: OpsFailureLike): NotificationContent {
  const summary = `宿主机运维任务执行失败（${task.kind}）。`;
  const fields: NotificationField[] = [
    { label: "任务 ID", value: task.id },
    { label: "任务类型", value: task.kind },
    { label: "错误信息", value: task.error ?? "—" },
  ];
  return {
    event: "ops_task",
    title: `运维任务失败：${task.kind}`,
    severity: "error",
    summary,
    fields,
    path: "/settings",
    text: joinText([
      summary,
      "",
      ...fields.map((field) => `${field.label}：${field.value}`),
      "",
      "可在「设置 → 运维任务」查看历史，并在宿主机日志中定位原因。",
      "",
      "此消息由系统自动发送，请勿直接回复。",
    ]),
  };
}

export function buildPipelineFailure(input: PipelineFailureLike): NotificationContent {
  const summary = `自动化产线执行失败：「${input.pipelineName}」。`;
  const fields: NotificationField[] = [
    { label: "失败步骤", value: input.step ?? "—" },
    { label: "错误信息", value: input.error ?? "—" },
    { label: "运行记录", value: input.runId ?? "—" },
  ];
  return {
    event: "pipeline",
    title: `产线失败：${input.pipelineName}`,
    severity: "error",
    summary,
    fields,
    path: "/pipelines",
    text: joinText([
      summary,
      "",
      ...fields.map((field) => `${field.label}：${field.value}`),
      "",
      "后续步骤已停止；已派出的任务与交付物保留。可在「自动化」页查看运行记录。",
      "",
      "此消息由系统自动发送，请勿直接回复。",
    ]),
  };
}

export function buildChannelTest(channelLabel: string): NotificationContent {
  const now = new Date().toISOString();
  const summary = `如果你在${channelLabel}收到这条消息，说明 Webhook 配置可用。`;
  const fields: NotificationField[] = [
    { label: "渠道", value: channelLabel },
    { label: "时间", value: formatUtc(now) },
  ];
  return {
    event: "test",
    title: `通知渠道测试（${channelLabel}）`,
    severity: "info",
    summary,
    fields,
    path: null,
    text: joinText([
      summary,
      "",
      ...fields.map((field) => `${field.label}：${field.value}`),
    ]),
  };
}

/** 渠道订阅判定：test 永远放行，业务事件按订阅集合过滤 */
export function isSubscribed(events: readonly string[], event: NotificationEventKey): boolean {
  if (event === "test") {
    return true;
  }
  return events.includes(event);
}

export function toEmailMessage(content: NotificationContent): { subject: string; text: string } {
  return { subject: `${PREFIX} ${content.title}`, text: content.text };
}

/** 飞书 interactive 卡片（自定义机器人） */
export function renderFeishuCard(content: NotificationContent): Record<string, unknown> {
  const template =
    content.severity === "error" ? "red" : content.severity === "warn" ? "orange" : "green";
  const lines = [
    content.summary,
    "",
    ...content.fields.map((field) => `**${field.label}**：${field.value}`),
  ];
  if (content.path) {
    lines.push("", `查看：${content.path}`);
  }
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template,
        title: { tag: "plain_text", content: `${PREFIX} ${content.title}` },
      },
      elements: [{ tag: "div", text: { tag: "lark_md", content: lines.join("\n") } }],
    },
  };
}

/** 企微群机器人 markdown（支持 ** 加粗、> 引用、<font color>） */
export function renderWecomMarkdown(content: NotificationContent): string {
  const color = content.severity === "info" ? "info" : "warning";
  const lines = [
    `**[Jxf-AI] ${content.title}**`,
    `<font color="${color}">${content.summary}</font>`,
    "",
    ...content.fields.map((field) => `> ${field.label}：${field.value}`),
  ];
  if (content.path) {
    lines.push("", `> 查看：${content.path}`);
  }
  return lines.join("\n");
}
