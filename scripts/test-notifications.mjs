/**
 * 通知渠道验收：设置面读写、密钥加密、配置解析、事件订阅与三个渠道的发送链路。
 *
 * 不发起真实网络 / SMTP 连接：邮件用注入的假 transport，IM 渠道用注入的 fetch。
 * 会临时改写 app_settings 的通知字段，结束后按快照恢复。
 */
import { Client } from "pg";

import {
  invalidateNotificationConfigCache,
  resolveChannelTargets,
  resolveMailConfig,
} from "../src/lib/notifications/config.ts";
import {
  buildChannelTest,
  buildHealthAlert,
  buildOpsFailure,
  buildPipelineFailure,
  renderFeishuCard,
  renderWecomMarkdown,
  toEmailMessage,
} from "../src/lib/notifications/content.ts";
import { dispatchNotification } from "../src/lib/notifications/events.ts";
import { buildFeishuPayload, feishuSign } from "../src/lib/notifications/feishu.ts";
import { sendNotification } from "../src/lib/notifications/mailer.ts";
import {
  CLEAR_API_KEY,
  readPlatformSettings,
  saveChannelSettings,
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

const FEISHU_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/abcd1234";
const FEISHU_SECRET = "feishu-sign-5678";
const WECOM_WEBHOOK = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=wecom-key-9876";

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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const HEALTH_ALERT = {
  event: "mcp.connector_unhealthy",
  connector_id: "c1",
  connector_name: "CRM 连接器",
  status: "down",
  failures: 3,
  error: "connect ETIMEDOUT",
  at: "2026-11-07T12:00:00.000Z",
};

const PIPELINE_FAILURE = {
  pipelineName: "季度分析",
  step: "生成摘要",
  error: "员工未上线",
  runId: "r1",
};

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
    `select notify_email_enabled, smtp_host, smtp_port, smtp_user, smtp_pass_enc, smtp_pass_hint, notify_email_to,
            notify_feishu_enabled, feishu_webhook_enc, feishu_webhook_hint, feishu_secret_enc, feishu_secret_hint,
            notify_feishu_events,
            notify_wecom_enabled, wecom_webhook_enc, wecom_webhook_hint, notify_wecom_events
       from app_settings where id = 1`,
  );

  try {
    const l1 = await buildContext(owner, l1Actor);

    // 0. 纯函数：内容渲染与飞书签名
    const healthContent = buildHealthAlert(HEALTH_ALERT);
    const card = renderFeishuCard(healthContent);
    const cardText = JSON.stringify(card);
    check(
      "飞书卡片包含标题、字段与路径",
      cardText.includes("CRM 连接器") &&
        cardText.includes("连接器 ID") &&
        cardText.includes("/settings/mcp") &&
        card.msg_type === "interactive",
    );
    const wecomText = renderWecomMarkdown(healthContent);
    check(
      "企微 markdown 包含标题与字段",
      wecomText.includes("**[Jxf-AI] 连接器异常") &&
        wecomText.includes("> 连接器 ID：c1") &&
        wecomText.includes("warning"),
    );
    const sign = feishuSign("1700000000", FEISHU_SECRET);
    check(
      "飞书签名稳定且为 44 位 base64",
      sign === feishuSign("1700000000", FEISHU_SECRET) && /^[A-Za-z0-9+/]{43}=$/.test(sign),
    );
    const signed = buildFeishuPayload(healthContent, FEISHU_SECRET, 1_700_000_000_000);
    check(
      "配置签名后请求体带 timestamp / sign",
      signed.timestamp === "1700000000" && typeof signed.sign === "string",
    );
    const unsigned = buildFeishuPayload(healthContent, null);
    check("未配置签名时不带 sign", unsigned.sign === undefined && unsigned.timestamp === undefined);

    // 1. 默认关闭时安静跳过
    await saveNotificationSettings(l1, {
      enabled: false,
      smtpHost: "",
      smtpPort: null,
      smtpUser: "",
      smtpPass: "",
      to: "",
    });
    invalidateNotificationConfigCache();
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
      "设置面读回邮件配置",
      view.notifications.enabled &&
        view.notifications.smtpHost === "smtp.example.com" &&
        view.notifications.smtpPort === 587 &&
        view.notifications.to === "ops@example.com, boss@example.com",
    );

    const raw = await owner.query(
      "select smtp_pass_enc, smtp_pass_hint from app_settings where id = 1",
    );
    const stored = raw.rows[0]?.smtp_pass_enc ?? "";
    check("口令以 v1/v2 密文入库", /^v[12]\./.test(stored));
    check("库内不含口令明文", !stored.includes(plainPass));

    // 4. 配置解析与发送链路
    invalidateNotificationConfigCache();
    const resolved = await resolveMailConfig();
    check(
      "解析出生效邮件配置",
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
    const failedMail = await sendNotification(
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
    check("SMTP 失败只返回错误不抛出", failureCaptured && failedMail.error === "smtp unreachable");

    // 5. 邮件模板
    const healthMail = toEmailMessage(buildHealthAlert(HEALTH_ALERT));
    check(
      "连接器异常模板包含关键信息",
      healthMail.subject.includes("CRM 连接器") &&
        healthMail.text.includes("down") &&
        healthMail.text.includes("connect ETIMEDOUT"),
    );
    const recovered = toEmailMessage(
      buildHealthAlert({ ...HEALTH_ALERT, event: "mcp.connector_recovered", status: "healthy" }),
    );
    check("连接器恢复模板区分事件", recovered.subject.includes("恢复"));

    const ops = toEmailMessage(buildOpsFailure({ id: "t1", kind: "backup", error: "exit 1" }));
    check("运维失败模板包含任务与错误", ops.subject.includes("backup") && ops.text.includes("exit 1"));

    const pipeline = toEmailMessage(buildPipelineFailure(PIPELINE_FAILURE));
    check(
      "产线失败模板包含步骤与运行记录",
      pipeline.subject.includes("季度分析") &&
        pipeline.text.includes("生成摘要") &&
        pipeline.text.includes("r1"),
    );

    // 6. IM 渠道保存、加密与设置面读回
    // 先关闭邮件，避免后面的派发真去连 SMTP（本脚本不发起真实网络连接）
    await saveNotificationSettings(l1, {
      enabled: false,
      smtpHost: "",
      smtpPort: null,
      smtpUser: "",
      smtpPass: "",
      to: "",
    });
    invalidateNotificationConfigCache();

    const savedFeishu = await saveChannelSettings(l1, {
      channel: "feishu",
      enabled: true,
      webhook: FEISHU_WEBHOOK,
      secret: FEISHU_SECRET,
      events: ["pipeline"],
    });
    check(
      "飞书 Webhook 已配置且脱敏",
      savedFeishu.webhookConfigured && savedFeishu.webhookHint === "open.feishu.cn ····1234",
      savedFeishu.webhookHint ?? "null",
    );
    check(
      "飞书签名密钥只展示末 4 位",
      savedFeishu.secretConfigured && savedFeishu.secretHint === "••••5678",
    );

    const rawChannel = await owner.query(
      "select feishu_webhook_enc, feishu_secret_enc from app_settings where id = 1",
    );
    const webhookEnc = rawChannel.rows[0]?.feishu_webhook_enc ?? "";
    check("Webhook 以 v1/v2 密文入库", /^v[12]\./.test(webhookEnc));
    check(
      "库内不含 Webhook 明文与密钥明文",
      !webhookEnc.includes("abcd1234") && !webhookEnc.includes(FEISHU_SECRET),
    );

    const savedWecom = await saveChannelSettings(l1, {
      channel: "wecom",
      enabled: true,
      webhook: WECOM_WEBHOOK,
      events: ["mcp_health"],
    });
    check(
      "企微 Webhook 已配置且脱敏",
      savedWecom.webhookConfigured && savedWecom.webhookHint === "qyapi.weixin.qq.com ····9876",
    );

    const viewChannels = await readPlatformSettings(l1);
    check(
      "设置面读回 IM 渠道与订阅",
      viewChannels.notifications.feishu.enabled &&
        viewChannels.notifications.feishu.events.join(",") === "pipeline" &&
        viewChannels.notifications.wecom.enabled &&
        viewChannels.notifications.wecom.events.join(",") === "mcp_health",
    );

    // 7. 配置解析：解密与事件集合
    invalidateNotificationConfigCache();
    const targets = await resolveChannelTargets();
    check(
      "飞书目标解密正确",
      targets.feishu?.webhook === FEISHU_WEBHOOK &&
        targets.feishu?.secret === FEISHU_SECRET &&
        targets.feishu?.events.join(",") === "pipeline",
    );
    check(
      "企微目标解密正确",
      targets.wecom?.webhook === WECOM_WEBHOOK && targets.wecom?.secret === null,
    );

    // 8. 订阅过滤：产线只发飞书，连接器只发企微
    const calls = [];
    const okFetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse(url.includes("feishu") ? { code: 0, msg: "success" } : { errcode: 0, errmsg: "ok" });
    };

    const pipelineResults = await dispatchNotification(buildPipelineFailure(PIPELINE_FAILURE), {
      targets,
      fetchImpl: okFetch,
      audit: false,
    });
    check(
      "产线失败只发订阅了该事件的飞书",
      pipelineResults.length === 1 &&
        pipelineResults[0].channel === "feishu" &&
        pipelineResults[0].ok,
      JSON.stringify(pipelineResults),
    );
    check("飞书请求体是 interactive 卡片", calls[0]?.body?.msg_type === "interactive");
    check(
      "飞书请求体带签名",
      typeof calls[0]?.body?.timestamp === "string" && typeof calls[0]?.body?.sign === "string",
    );

    const healthResults = await dispatchNotification(buildHealthAlert(HEALTH_ALERT), {
      targets,
      fetchImpl: okFetch,
      audit: false,
    });
    check(
      "连接器事件只发订阅了该事件的企微",
      healthResults.length === 1 &&
        healthResults[0].channel === "wecom" &&
        healthResults[0].ok,
      JSON.stringify(healthResults),
    );
    check("企微请求体是 markdown", calls[1]?.body?.msgtype === "markdown");

    // 9. 失败语义：飞书错误码按失败处理，且不影响其它渠道
    const failingFetch = async () => jsonResponse({ code: 19021, msg: "sign match fail" });
    const failedDispatch = await dispatchNotification(buildChannelTest("飞书"), {
      targets: {
        email: null,
        emailReason: null,
        feishu: targets.feishu,
        wecom: null,
      },
      fetchImpl: failingFetch,
      audit: false,
    });
    check(
      "飞书错误码按失败处理并带原因",
      failedDispatch[0]?.ok === false && (failedDispatch[0]?.error ?? "").includes("19021"),
    );

    const httpFailFetch = async () => jsonResponse({}, 502);
    const httpFailed = await dispatchNotification(buildChannelTest("企微"), {
      targets: { email: null, emailReason: null, feishu: null, wecom: targets.wecom },
      fetchImpl: httpFailFetch,
      audit: false,
    });
    check(
      "HTTP 5xx 重试后仍失败且不抛出",
      httpFailed[0]?.ok === false && (httpFailed[0]?.error ?? "").includes("502"),
    );

    // 10. 测试发送不受订阅过滤（事件集合为空也能发）
    let testCalls = 0;
    const testResults = await dispatchNotification(buildChannelTest("企微"), {
      targets: {
        email: null,
        emailReason: null,
        feishu: null,
        wecom: { channel: "wecom", webhook: WECOM_WEBHOOK, secret: null, events: [] },
      },
      fetchImpl: async () => {
        testCalls += 1;
        return jsonResponse({ errcode: 0, errmsg: "ok" });
      },
      audit: false,
    });
    check("测试发送不受订阅过滤", testResults[0]?.ok === true && testCalls === 1);

    // 11. 校验：启用时必须有合法 Webhook，且至少订阅一个事件
    await saveChannelSettings(l1, {
      channel: "wecom",
      enabled: false,
      webhook: CLEAR_API_KEY,
      events: ["pipeline"],
    });
    const noWebhook = await saveChannelSettings(l1, {
      channel: "wecom",
      enabled: true,
      webhook: "",
      events: ["pipeline"],
    })
      .then(() => false)
      .catch((error) => error instanceof SettingsInputError);
    check("启用企微时缺少 Webhook 被拒绝", noWebhook);

    const badUrl = await saveChannelSettings(l1, {
      channel: "feishu",
      enabled: false,
      webhook: "not-a-url",
      events: ["pipeline"],
    })
      .then(() => false)
      .catch((error) => error instanceof SettingsInputError);
    check("非法 Webhook 地址被拒绝", badUrl);

    const noEvents = await saveChannelSettings(l1, {
      channel: "feishu",
      enabled: true,
      webhook: "",
      events: [],
    })
      .then(() => false)
      .catch((error) => error instanceof SettingsInputError);
    check("启用渠道但未选事件被拒绝", noEvents);

    const unknownEvent = await saveChannelSettings(l1, {
      channel: "feishu",
      enabled: false,
      webhook: "",
      events: ["unknown"],
    })
      .then(() => false)
      .catch((error) => error instanceof SettingsInputError);
    check("未知事件被拒绝", unknownEvent);

    // 12. 权限边界
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
      check("L3 不能修改邮件通知配置", denied);

      const channelDenied = await saveChannelSettings(l3, {
        channel: "feishu",
        enabled: false,
        webhook: "",
        events: ["pipeline"],
      })
        .then(() => false)
        .catch(() => true);
      check("L3 不能修改 IM 渠道配置", channelDenied);
    }
  } finally {
    const row = snapshot.rows[0];
    if (row) {
      await owner
        .query(
          `update app_settings
              set notify_email_enabled = $1, smtp_host = $2, smtp_port = $3, smtp_user = $4,
                  smtp_pass_enc = $5, smtp_pass_hint = $6, notify_email_to = $7,
                  notify_feishu_enabled = $8, feishu_webhook_enc = $9, feishu_webhook_hint = $10,
                  feishu_secret_enc = $11, feishu_secret_hint = $12, notify_feishu_events = $13,
                  notify_wecom_enabled = $14, wecom_webhook_enc = $15, wecom_webhook_hint = $16,
                  notify_wecom_events = $17
            where id = 1`,
          [
            row.notify_email_enabled,
            row.smtp_host,
            row.smtp_port,
            row.smtp_user,
            row.smtp_pass_enc,
            row.smtp_pass_hint,
            row.notify_email_to,
            row.notify_feishu_enabled,
            row.feishu_webhook_enc,
            row.feishu_webhook_hint,
            row.feishu_secret_enc,
            row.feishu_secret_hint,
            row.notify_feishu_events,
            row.notify_wecom_enabled,
            row.wecom_webhook_enc,
            row.wecom_webhook_hint,
            row.notify_wecom_events,
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
