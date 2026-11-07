/**
 * 邮件通知验收：设置面读写、口令加密、配置解析、发送链路与模板。
 *
 * 不发起真实 SMTP 连接：发送链路使用注入的假 transport。
 * 会临时改写 app_settings 的通知字段，结束后按快照恢复。
 */
import { Client } from "pg";

import {
  buildHealthAlertEmail,
  buildOpsFailureEmail,
  buildPipelineFailureEmail,
} from "../src/lib/notifications/events.ts";
import {
  invalidateMailConfigCache,
  resolveMailConfig,
  sendNotification,
} from "../src/lib/notifications/mailer.ts";
import {
  readPlatformSettings,
  saveNotificationSettings,
  SettingsInputError,
} from "../src/lib/settings/store.ts";

const TENANT = process.env.JXF_TENANT_ID;
const HOST = process.env.SEED_DB_HOST ?? "127.0.0.1";
const PORT = process.env.SEED_DB_PORT ?? process.env.POSTGRES_PORT ?? "5432";
const DB = process.env.POSTGRES_DB;
const OWNER_URL = `postgresql://${process.env.JXF_OWNER_USER}:${process.env.JXF_OWNER_PASSWORD}@${HOST}:${PORT}/${DB}`;
const SMTP_ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "NOTIFICATION_EMAIL_TO",
];

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`[PASS] ${name}`);
    return;
  }
  failed += 1;
  console.error(`[FAIL] ${name}${detail ? ` :: ${detail}` : ""}`);
}

async function loadActor(client, level) {
  const { rows } = await client.query(
    `select m.user_id, m.id as membership_id, m.department_id, d.name as department_name, m.access_level
       from memberships m
       join departments d on d.id = m.department_id
      where m.tenant_id = $1 and m.status = 'active' and m.access_level = $2
      order by m.created_at
      limit 1`,
    [TENANT, level],
  );
  return rows[0] ?? null;
}

async function buildContext(client, actor) {
  const version = await client.query("select app.user_permission_version($1) as version", [
    actor.user_id,
  ]);
  return {
    userId: actor.user_id,
    tenantId: TENANT,
    activeMembership: {
      id: actor.membership_id,
      departmentId: actor.department_id,
      departmentName: actor.department_name,
      level: actor.access_level,
      title: "",
    },
    activeMemberships: [],
    activeMembershipId: actor.membership_id,
    activeDepartmentId: actor.department_id,
    activeDepartmentName: actor.department_name,
    membershipDepartmentIds: [actor.department_id],
    departmentIds: [actor.department_id],
    subtreeDepartmentIds: [actor.department_id],
    accessLevel: actor.access_level,
    permissionVersion: Number(version.rows[0]?.version ?? 0),
  };
}

async function main() {
  if (!TENANT || !DB || !process.env.JXF_OWNER_USER || !process.env.JXF_APP_USER) {
    throw new Error("缺少数据库环境变量，请用 npm run test:notifications 执行");
  }
  for (const key of SMTP_ENV_KEYS) {
    delete process.env[key];
  }

  const owner = new Client({ connectionString: OWNER_URL, application_name: "jxf-notifications-test" });
  await owner.connect();

  const l1Actor = await loadActor(owner, "L1");
  const l3Actor = await loadActor(owner, "L3");
  if (!l1Actor) {
    throw new Error("需要至少一位有效 L1");
  }

  const snapshot = await owner.query(
    `select notify_email_enabled, smtp_host, smtp_port, smtp_user, smtp_pass_enc, smtp_pass_hint, notify_email_to
       from app_settings where id = 1`,
  );

  try {
    const l1 = await buildContext(owner, l1Actor);

    // 1. 默认关闭时安静跳过
    await saveNotificationSettings(l1, {
      enabled: false,
      smtpHost: "",
      smtpPort: null,
      smtpUser: "",
      smtpPass: "",
      to: "",
    });
    invalidateMailConfigCache();
    const skipped = await sendNotification({ subject: "测试", text: "测试" });
    check("未启用时跳过发送", skipped.skipped === true && skipped.error === null);

    // 2. 校验：非法收件人 / 启用时缺 host
    const badEmail = await saveNotificationSettings(l1, {
      enabled: true,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpUser: "",
      smtpPass: "",
      to: "not-an-email",
    })
      .then(() => false)
      .catch((error) => error instanceof SettingsInputError);
    check("非法收件人被拒绝", badEmail);

    const missingHost = await saveNotificationSettings(l1, {
      enabled: true,
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      smtpPass: "",
      to: "ops@example.com",
    })
      .then(() => false)
      .catch((error) => error instanceof SettingsInputError);
    check("启用时缺少 SMTP_HOST 被拒绝", missingHost);

    // 3. 保存合法配置：口令加密入库
    const plainPass = "smtp-secret-1234";
    const saved = await saveNotificationSettings(l1, {
      enabled: true,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpUser: "ops@example.com",
      smtpPass: plainPass,
      to: "ops@example.com, boss@example.com",
    });
    check("口令已配置并只展示末 4 位", saved.passConfigured && saved.passHint === "••••1234");

    const view = await readPlatformSettings(l1);
    check(
      "设置面读回通知配置",
      view.notifications.enabled &&
        view.notifications.smtpHost === "smtp.example.com" &&
        view.notifications.smtpPort === 587 &&
        view.notifications.to === "ops@example.com, boss@example.com",
    );

    const raw = await owner.query(
      "select smtp_pass_enc, smtp_pass_hint from app_settings where id = 1",
    );
    const stored = raw.rows[0]?.smtp_pass_enc ?? "";
    check("口令以 v1 密文入库", stored.startsWith("v1."));
    check("库内不含口令明文", !stored.includes(plainPass));

    // 4. 配置解析与发送链路
    invalidateMailConfigCache();
    const resolved = await resolveMailConfig();
    check(
      "解析出生效配置",
      resolved.config?.host === "smtp.example.com" &&
        resolved.config?.port === 587 &&
        resolved.config?.pass === plainPass &&
        resolved.config?.to.length === 2,
      JSON.stringify({ ...resolved.config, pass: "***" }),
    );

    let captured = null;
    const sent = await sendNotification(
      { subject: "[Jxf-AI] 测试邮件", text: "正文" },
      {
        config: resolved.config,
        factory: (config) => ({
          sendMail: async (message) => {
            captured = { message, config };
            return { messageId: "test-id" };
          },
        }),
      },
    );
    check("注入 transport 后发送成功", sent.sent && sent.messageId === "test-id");
    check(
      "收件人与发件人正确",
      captured?.message.to === "ops@example.com, boss@example.com" &&
        captured?.message.from === "ops@example.com" &&
        captured?.message.subject === "[Jxf-AI] 测试邮件",
    );

    let failureCaptured = false;
    const failed = await sendNotification(
      { subject: "失败", text: "失败" },
      {
        config: resolved.config,
        factory: () => ({
          sendMail: async () => {
            failureCaptured = true;
            throw new Error("smtp unreachable");
          },
        }),
      },
    );
    check("SMTP 失败只返回错误不抛出", failureCaptured && failed.error === "smtp unreachable");

    // 5. 邮件模板
    const health = buildHealthAlertEmail({
      event: "mcp.connector_unhealthy",
      connector_id: "c1",
      connector_name: "CRM 连接器",
      status: "down",
      failures: 3,
      error: "connect ETIMEDOUT",
      at: "2026-11-07T12:00:00.000Z",
    });
    check(
      "连接器异常模板包含关键信息",
      health.subject.includes("CRM 连接器") &&
        health.text.includes("down") &&
        health.text.includes("connect ETIMEDOUT"),
    );
    const recovered = buildHealthAlertEmail({
      event: "mcp.connector_recovered",
      connector_id: "c1",
      connector_name: "CRM 连接器",
      status: "healthy",
      failures: 0,
      error: null,
      at: "2026-11-07T12:05:00.000Z",
    });
    check("连接器恢复模板区分事件", recovered.subject.includes("恢复"));

    const ops = buildOpsFailureEmail({ id: "t1", kind: "backup", error: "exit 1" });
    check("运维失败模板包含任务与错误", ops.subject.includes("backup") && ops.text.includes("exit 1"));

    const pipeline = buildPipelineFailureEmail({
      pipelineName: "季度分析",
      step: "生成摘要",
      error: "员工未上线",
      runId: "r1",
    });
    check(
      "产线失败模板包含步骤与运行记录",
      pipeline.subject.includes("季度分析") &&
        pipeline.text.includes("生成摘要") &&
        pipeline.text.includes("r1"),
    );

    // 6. 权限边界
    if (l3Actor) {
      const l3 = await buildContext(owner, l3Actor);
      const denied = await saveNotificationSettings(l3, {
        enabled: false,
        smtpHost: "",
        smtpPort: null,
        smtpUser: "",
        smtpPass: "",
        to: "",
      })
        .then(() => false)
        .catch(() => true);
      check("L3 不能修改通知配置", denied);
    }
  } finally {
    const row = snapshot.rows[0];
    if (row) {
      await owner
        .query(
          `update app_settings
              set notify_email_enabled = $1, smtp_host = $2, smtp_port = $3, smtp_user = $4,
                  smtp_pass_enc = $5, smtp_pass_hint = $6, notify_email_to = $7
            where id = 1`,
          [
            row.notify_email_enabled,
            row.smtp_host,
            row.smtp_port,
            row.smtp_user,
            row.smtp_pass_enc,
            row.smtp_pass_hint,
            row.notify_email_to,
          ],
        )
        .catch(() => undefined);
    }
    await owner.end().catch(() => undefined);
  }

  console.log(`\n[notifications] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[notifications] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
