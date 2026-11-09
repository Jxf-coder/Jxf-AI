/**
 * 自动化产线验收：定义、首步派活、链式推进、可选步骤、产物传递与定时触发。
 *
 * 会创建真实 work_item 与 queued run；请在测试前停止 worker 避免被领取：
 *   docker stop jxf-ai-worker-app-1
 *   npm run test:pipelines
 *   docker start jxf-ai-worker-app-1
 */
import { Client } from "pg";

import {
  createPipeline,
  listPipelineRuns,
  listPipelines,
  runPipeline,
} from "../src/lib/pipelines.ts";
import { advancePipelineRuns, applyPrevious, sweepScheduledPipelines } from "../src/lib/pipeline-runner.ts";
import { capturePipelineRunExperience } from "../src/lib/knowledge/experience/collectors.ts";
import { reviewWorkItem } from "../src/lib/work-items.ts";
import {
  dispatchPipelineEvents,
  publishPipelineEvent,
  setPipelineEventSubscription,
} from "../src/lib/pipeline-events.ts";
import {
  disableWebhook,
  hashWebhookToken,
  lookupWebhookPipeline,
  rotateWebhookToken,
  verifyWebhookToken,
} from "../src/lib/pipelines-webhook.ts";
import { POST as webhookPost } from "../src/app/api/webhooks/pipelines/[id]/route.ts";

const TENANT = process.env.JXF_TENANT_ID;
const HOST = process.env.SEED_DB_HOST ?? "127.0.0.1";
const PORT = process.env.SEED_DB_PORT ?? process.env.POSTGRES_PORT ?? "5432";
const DB = process.env.POSTGRES_DB;
const OWNER_URL = `postgresql://${process.env.JXF_OWNER_USER}:${process.env.JXF_OWNER_PASSWORD}@${HOST}:${PORT}/${DB}`;

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

async function workItem(owner, id) {
  const { rows } = await owner.query(
    `select id, status, brief, current_run_id, deliverable->>'text' as text
       from work_items where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function finishWorkItem(owner, id, status, text = "") {
  await owner.query(
    `update work_items
        set status = $2::work_item_status,
            deliverable = case when $3::text = '' then deliverable else jsonb_build_object('text', $3::text) end,
            updated_at = now()
      where id = $1`,
    [id, status, text],
  );
}

/**
 * 冻结刚创建的执行（queued → done），避免并行运行的 worker 在断言前改写工作项状态。
 * 只影响本次测试创建的工作项对应的 run。
 */
async function freezeRun(owner, workItemId) {
  await owner.query(
    `update runs
        set status = 'done', finished_at = now()
      where id = (select current_run_id from work_items where id = $1)
        and status = 'queued'`,
    [workItemId],
  );
}

async function main() {
  if (!TENANT || !DB || !process.env.JXF_OWNER_USER || !process.env.JXF_APP_USER) {
    throw new Error("缺少数据库环境变量，请用 npm run test:pipelines 执行");
  }

  const owner = new Client({ connectionString: OWNER_URL, application_name: "jxf-pipelines-test" });
  await owner.connect();

  const l1Actor = await loadActor(owner, "L1");
  const l2Actor = await loadActor(owner, "L2");
  if (!l1Actor) {
    throw new Error("需要至少一位有效 L1");
  }

  const stamp = Date.now();
  let employeeId = null;
  const pipelineIds = [];
  const workItemIds = [];
  const runIds = [];
  const eventIds = [];
  /** 经验队列清理：source_id 指向测试产线运行 / 工作项 */
  const experienceSourceIds = [];
  let hooks = null;

  try {
    const employee = await owner.query(
      `insert into ai_employees (tenant_id, slug, name, status, created_by)
       values ($1, $2, $3, 'active', $4)
       returning id`,
      [TENANT, `pipeline-test-${stamp}`, `产线测试员工 ${stamp}`, l1Actor.user_id],
    );
    employeeId = employee.rows[0].id;
    await owner.query(
      `insert into ai_employee_grants (tenant_id, ai_employee_id, department_id, capability, created_by)
       values ($1, $2, $3, 'use', $4)`,
      [TENANT, employeeId, l1Actor.department_id, l1Actor.user_id],
    );

    const l1 = await buildContext(owner, l1Actor);
    hooks = { resolveContext: async () => l1 };

    // ------------------------------------------------------------------
    // 1. 链式推进：首步派发 → 完成 → 带产物派下一步 → 可选步骤失败跳过
    // ------------------------------------------------------------------
    const chainTitles = [`整理数据 ${stamp}`, `生成摘要 ${stamp}`, `输出终稿 ${stamp}`];
    const pipeline = await createPipeline(l1, {
      name: `产线测试 ${stamp}`,
      description: "自动化测试创建的临时产线",
      scheduleIntervalMinutes: null,
      steps: [
        { title: chainTitles[0], brief: "整理本季度销售数据并输出要点", aiEmployeeId: employeeId, aiEmployeeName: "产线测试员工" },
        {
          title: chainTitles[1],
          brief: "基于上一步结果生成三层摘要：{{previous}}",
          aiEmployeeId: employeeId,
          aiEmployeeName: "产线测试员工",
          optional: true,
        },
        { title: chainTitles[2], brief: "基于摘要输出 200 字终稿", aiEmployeeId: employeeId, aiEmployeeName: "产线测试员工" },
      ],
    });
    pipelineIds.push(pipeline.id);
    check("L1 可创建产线", pipeline.steps.length === 3 && pipeline.enabled);
    check("可选步骤标记已保存", pipeline.steps[1]?.optional === true);

    const listed = await listPipelines(l1);
    check("L1 可见新建产线", listed.some((item) => item.id === pipeline.id));

    const result = await runPipeline(l1, pipeline.id);
    check(
      "运行只派第一步",
      result.workItemIds.length === 1 && result.nextStepIndex === 1 && result.failedStep === null,
    );
    check("运行触发方式为手动", result.trigger === "manual");
    workItemIds.push(...result.workItemIds);
    for (const id of result.workItemIds) {
      await freezeRun(owner, id);
    }

    let runs = await listPipelineRuns(l1);
    let target = runs.find((item) => item.id === result.runId);
    const counted =
      (target?.activeCount ?? 0) +
      (target?.reviewCount ?? 0) +
      (target?.doneCount ?? 0) +
      (target?.failedCount ?? 0);
    check(
      "运行记录聚合到已派出的 1 个步骤",
      target?.workItemIds.length === 1 && counted === 1,
      JSON.stringify({ counted, target }),
    );

    let first = await workItem(owner, result.workItemIds[0]);
    check(
      "第一步工作项已进入队列",
      ["queued", "running"].includes(first?.status ?? "") && Boolean(first?.current_run_id),
      first?.status ?? "missing",
    );
    if (first?.current_run_id) {
      runIds.push(first.current_run_id);
    }

    await finishWorkItem(owner, result.workItemIds[0], "done", "第一步交付：销售额 120 万");
    const advanced = await advancePipelineRuns(owner, hooks, { runIds: [result.runId] });
    check("上一步完成后推进下一步", advanced[0]?.action === "dispatched" && advanced[0]?.step === chainTitles[1]);

    let runRow = await owner.query(
      "select work_item_ids, next_step_index from pipeline_runs where id = $1",
      [result.runId],
    );
    check("运行记录推进到第 2 步", runRow.rows[0]?.next_step_index === 2);

    const secondId = runRow.rows[0].work_item_ids[1];
    workItemIds.push(secondId);
    await freezeRun(owner, secondId);
    const second = await workItem(owner, secondId);
    check("第二步引用了上一步交付", second?.brief.includes("销售额 120 万") === true, second?.brief ?? "");
    check("第二步未残留占位符", second?.brief.includes("{{previous}}") === false);
    if (second?.current_run_id) {
      runIds.push(second.current_run_id);
    }

    // 可选步骤失败 → 跳过并继续第 3 步
    await finishWorkItem(owner, secondId, "failed");
    const skipped = await advancePipelineRuns(owner, hooks, { runIds: [result.runId] });
    check("可选步骤失败后跳过并继续", skipped[0]?.action === "skipped" && skipped[0]?.step === chainTitles[2]);

    runRow = await owner.query(
      "select work_item_ids, next_step_index, skipped_steps, failed_step, finished_at from pipeline_runs where id = $1",
      [result.runId],
    );
    const thirdId = runRow.rows[0].work_item_ids[2];
    workItemIds.push(thirdId);
    await freezeRun(owner, thirdId);
    check("跳过步骤已记录", (runRow.rows[0].skipped_steps ?? []).includes(chainTitles[1]));
    check("整条产线未被标记失败", runRow.rows[0].failed_step === null);

    await finishWorkItem(owner, thirdId, "done", "终稿");
    const completed = await advancePipelineRuns(owner, hooks, { runIds: [result.runId] });
    // worker 可能刚好在跑最后一步：此时本轮返回 waiting 也正确（不会重复派活）
    check(
      "最后一步后不再派发新步骤",
      completed[0]?.action === "completed" || completed[0]?.action === "waiting",
      completed[0]?.action ?? "missing",
    );

    runs = await listPipelineRuns(l1);
    target = runs.find((item) => item.id === result.runId);
    // worker 可能在并行执行后续工作项，状态可能是 running / waiting_review；
    // 这里只验证「可选步骤的失败没有被误判为整条产线失败」
    check(
      "跳过步骤已展示且未误判为失败",
      target?.skippedSteps.includes(chainTitles[1]) === true && target?.status !== "partial",
      target ? `status=${target.status}` : "missing",
    );

    // ------------------------------------------------------------------
    // 2. 非可选步骤失败 → 整条产线停止
    // ------------------------------------------------------------------
    const strict = await createPipeline(l1, {
      name: `严格产线 ${stamp}`,
      steps: [
        {
          title: `严格第一步 ${stamp}`,
          brief:
            "第一步：核对合同条款、金额与交付节点，逐条比对附件与正文的一致性；" +
            "发现不一致时必须引用原文位置说明差异，并给出可执行的修订建议，禁止直接改写原文结论。" +
            "完成后输出核对清单与风险点，交付前自查数字是否都能在原文中找到出处。",
          aiEmployeeId: employeeId,
          aiEmployeeName: "产线测试员工",
        },
        {
          title: `严格第二步 ${stamp}`,
          brief:
            "第二步：基于核对清单生成终稿，逐条回应风险点并标注引用位置；" +
            "无法核对的内容必须显式标注待补充，不得编造数字或来源。" +
            "输出前再次检查所有结论是否可由原文直接支撑。",
          aiEmployeeId: employeeId,
          aiEmployeeName: "产线测试员工",
        },
      ],
    });
    pipelineIds.push(strict.id);
    const strictRun = await runPipeline(l1, strict.id);
    workItemIds.push(...strictRun.workItemIds);
    for (const id of strictRun.workItemIds) {
      await freezeRun(owner, id);
    }
    const strictItem = await workItem(owner, strictRun.workItemIds[0]);
    if (strictItem?.current_run_id) {
      runIds.push(strictItem.current_run_id);
    }
    await finishWorkItem(owner, strictRun.workItemIds[0], "failed");
    const stopped = await advancePipelineRuns(owner, hooks, { runIds: [strictRun.runId] });
    check("非可选步骤失败即停止", stopped[0]?.action === "failed");
    const strictRow = await owner.query(
      "select failed_step, finished_at, next_step_index from pipeline_runs where id = $1",
      [strictRun.runId],
    );
    check(
      "失败步骤与收口时间已写入",
      strictRow.rows[0]?.failed_step === `严格第一步 ${stamp}` &&
        Boolean(strictRow.rows[0]?.finished_at) &&
        strictRow.rows[0]?.next_step_index === 1,
    );

    // ------------------------------------------------------------------
    // 2.1 失败产线 → 经验队列（worker 异步提炼）
    // ------------------------------------------------------------------
    experienceSourceIds.push(strictRun.runId);
    const pipelineJobs = await owner.query(
      `select id, channel, source_type, status from experience_jobs
        where tenant_id = $1 and source_id = $2`,
      [TENANT, strictRun.runId],
    );
    check(
      "失败产线入队经验 job",
      pipelineJobs.rowCount === 1 && pipelineJobs.rows[0]?.channel === "pipeline",
      JSON.stringify(pipelineJobs.rows),
    );

    await owner.query("begin");
    try {
      await capturePipelineRunExperience(owner, strictRun.runId);
      await owner.query("commit");
    } catch (error) {
      await owner.query("rollback").catch(() => undefined);
      throw error;
    }
    const pipelineJobsAgain = await owner.query(
      `select count(*)::int as count from experience_jobs
        where tenant_id = $1 and source_id = $2`,
      [TENANT, strictRun.runId],
    );
    check("同一 run 重复采集只累计次数、不重复入队", pipelineJobsAgain.rows[0]?.count === 1);

    // ------------------------------------------------------------------
    // 2.2 工作项退回 → 经验队列（证据来自验收备注与交付原文）
    // ------------------------------------------------------------------
    const reviewItem = await owner.query(
      `insert into work_items
         (tenant_id, department_id, title, brief, input, ai_employee_id,
          assigned_by, reviewer_id, status, deliverable)
       values ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $6, 'waiting_review', $7::jsonb)
       returning id`,
      [
        TENANT,
        l1Actor.department_id,
        `验收测试工作项 ${stamp}`,
        "核对交付物是否可引用、数字是否可核对",
        employeeId,
        l1Actor.user_id,
        JSON.stringify({
          text: `交付正文：${"本段用于模拟无法核对的数字与结论。".repeat(20)}`,
        }),
      ],
    );
    const reviewItemId = reviewItem.rows[0].id;
    workItemIds.push(reviewItemId);
    experienceSourceIds.push(reviewItemId);
    await reviewWorkItem(
      l1,
      reviewItemId,
      "return",
      `退回原因：${"交付物缺少可核对来源，必须补充原文引用后再提交。".repeat(6)}`,
    );
    const reviewJobs = await owner.query(
      `select id, channel, source_type from experience_jobs
        where tenant_id = $1 and source_id = $2`,
      [TENANT, reviewItemId],
    );
    check(
      "退回工作项入队经验 job",
      reviewJobs.rowCount === 1 &&
        reviewJobs.rows[0]?.channel === "review" &&
        reviewJobs.rows[0]?.source_type === "work_item_return",
      JSON.stringify(reviewJobs.rows),
    );

    // ------------------------------------------------------------------
    // 3. 定时触发：到点发起、同窗口不重复
    // ------------------------------------------------------------------
    const scheduled = await createPipeline(l1, {
      name: `定时产线 ${stamp}`,
      scheduleIntervalMinutes: 5,
      steps: [
        { title: `定时第一步 ${stamp}`, brief: "定时任务", aiEmployeeId: employeeId, aiEmployeeName: "产线测试员工" },
        { title: `定时第二步 ${stamp}`, brief: "定时后续", aiEmployeeId: employeeId, aiEmployeeName: "产线测试员工" },
      ],
    });
    pipelineIds.push(scheduled.id);
    check("定时间隔已保存", scheduled.scheduleIntervalMinutes === 5);

    const swept = await sweepScheduledPipelines(owner, hooks);
    const mine = swept.find((item) => item.pipelineId === scheduled.id);
    check("定时产线到点自动发起", Boolean(mine?.runId) && mine?.error === null, mine?.error ?? "");
    if (mine?.runId) {
      const scheduledRun = await owner.query(
        "select trigger_kind, work_item_ids from pipeline_runs where id = $1",
        [mine.runId],
      );
      check("定时运行记录 trigger=schedule", scheduledRun.rows[0]?.trigger_kind === "schedule");
      for (const id of scheduledRun.rows[0]?.work_item_ids ?? []) {
        workItemIds.push(id);
        await freezeRun(owner, id);
        const item = await workItem(owner, id);
        if (item?.current_run_id) {
          runIds.push(item.current_run_id);
        }
      }
    }
    const sweptAgain = await sweepScheduledPipelines(owner, hooks);
    check("同一时间窗不重复触发", !sweptAgain.some((item) => item.pipelineId === scheduled.id));

    // ------------------------------------------------------------------
    // 4. 产物占位符
    // ------------------------------------------------------------------
    check("占位符替换为交付文本", applyPrevious("基于：{{previous}}", "结论 A") === "基于：结论 A");
    check(
      "无产物时显式说明",
      applyPrevious("基于：{{previous}}", null) === "基于：（上一步没有可用交付物）",
    );
    check("无占位符时原样返回", applyPrevious("直接执行", "无关") === "直接执行");

    // ------------------------------------------------------------------
    // 5. 外部 Webhook
    // ------------------------------------------------------------------
    const rotated = await rotateWebhookToken(l1, pipeline.id);
    check("Webhook 令牌为 64 位十六进制", /^[0-9a-f]{64}$/.test(rotated.token));
    const storedToken = await owner.query(
      "select webhook_enabled, webhook_token_hash, webhook_token_hint from pipelines where id = $1",
      [pipeline.id],
    );
    const tokenRow = storedToken.rows[0];
    check(
      "库内只存令牌哈希与末 4 位",
      tokenRow?.webhook_enabled === true &&
        tokenRow?.webhook_token_hash === hashWebhookToken(rotated.token) &&
        tokenRow?.webhook_token_hash !== rotated.token &&
        tokenRow?.webhook_token_hint === `••••${rotated.token.slice(-4)}`,
    );

    const webhookLookup = await lookupWebhookPipeline(pipeline.id);
    check(
      "Webhook 查询返回启用状态",
      webhookLookup?.webhookEnabled === true && webhookLookup?.enabled === true,
    );
    check("正确令牌校验通过", verifyWebhookToken(webhookLookup, rotated.token));
    check("错误令牌校验失败", !verifyWebhookToken(webhookLookup, "0".repeat(64)));

    const callWebhook = (headers = {}, body = "{}") =>
      webhookPost(
        new Request(`http://127.0.0.1/api/webhooks/pipelines/${pipeline.id}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
        }),
        { params: Promise.resolve({ id: pipeline.id }) },
      );

    check("缺少令牌返回 401", (await callWebhook()).status === 401);
    check("错误令牌返回 401", (await callWebhook({ "x-jxf-token": "0".repeat(64) })).status === 401);

    const webhookResponse = await callWebhook(
      { "x-jxf-token": rotated.token },
      JSON.stringify({ event: "push" }),
    );
    const webhookBody = await webhookResponse.json();
    check("正确令牌触发运行 202", webhookResponse.status === 202 && Boolean(webhookBody.runId));
    if (webhookBody.runId) {
      const webhookRun = await owner.query(
        "select trigger_kind, trigger_ref, work_item_ids from pipeline_runs where id = $1",
        [webhookBody.runId],
      );
      check(
        "Webhook 运行标注触发来源",
        webhookRun.rows[0]?.trigger_kind === "webhook" &&
          String(webhookRun.rows[0]?.trigger_ref ?? "").startsWith("webhook:"),
      );
      for (const id of webhookRun.rows[0]?.work_item_ids ?? []) {
        workItemIds.push(id);
        await freezeRun(owner, id);
        const item = await workItem(owner, id);
        if (item?.current_run_id) {
          runIds.push(item.current_run_id);
        }
      }
    }

    await disableWebhook(l1, pipeline.id);
    check(
      "停用后 Webhook 返回 404",
      (await callWebhook({ "x-jxf-token": rotated.token })).status === 404,
    );

    // ------------------------------------------------------------------
    // 6. 内部事件总线
    // ------------------------------------------------------------------
    await setPipelineEventSubscription(l1, pipeline.id, "work_item.finished", true);
    const subscribed = await listPipelines(l1);
    check(
      "事件订阅写入产线视图",
      subscribed.find((item) => item.id === pipeline.id)?.eventTypes.includes("work_item.finished") ===
        true,
    );

    const eventId = await publishPipelineEvent(owner, {
      tenantId: TENANT,
      eventType: "work_item.finished",
      payload: { work_item_id: "test", status: "done" },
    });
    eventIds.push(eventId);
    const dispatched = await dispatchPipelineEvents(owner, hooks, { eventIds: [eventId] });
    check(
      "订阅事件触发产线",
      dispatched[0]?.triggered === 1 && dispatched[0]?.status === "processed",
      JSON.stringify(dispatched[0]),
    );
    if (dispatched[0]?.triggered === 1) {
      const eventRow = await owner.query("select run_ids from pipeline_events where id = $1", [
        eventId,
      ]);
      const eventRunId = eventRow.rows[0]?.run_ids?.[0];
      const eventRun = await owner.query(
        "select trigger_kind, trigger_ref, work_item_ids from pipeline_runs where id = $1",
        [eventRunId],
      );
      check(
        "事件运行标注 trigger=event 与事件 ID",
        eventRun.rows[0]?.trigger_kind === "event" &&
          eventRun.rows[0]?.trigger_ref === `event:${eventId}`,
      );
      for (const id of eventRun.rows[0]?.work_item_ids ?? []) {
        workItemIds.push(id);
        await freezeRun(owner, id);
        const item = await workItem(owner, id);
        if (item?.current_run_id) {
          runIds.push(item.current_run_id);
        }
      }
    }

    const unsubscribedId = await publishPipelineEvent(owner, {
      tenantId: TENANT,
      eventType: "knowledge.ingest_done",
      payload: {},
    });
    eventIds.push(unsubscribedId);
    const unsubscribed = await dispatchPipelineEvents(owner, hooks, { eventIds: [unsubscribedId] });
    check(
      "未订阅的事件不触发产线",
      unsubscribed[0]?.triggered === 0 && unsubscribed[0]?.status === "processed",
    );

    // ------------------------------------------------------------------
    // 7. 审计与权限边界
    // ------------------------------------------------------------------
    const audits = await owner.query(
      "select action from audit_events where target_id = any($1::uuid[])",
      [[...pipelineIds, result.runId].filter(Boolean)],
    );
    check(
      "创建、运行与推进均写审计",
      audits.rows.some((row) => row.action === "pipeline.created") &&
        audits.rows.some((row) => row.action === "pipeline.run") &&
        audits.rows.some((row) => row.action === "pipeline.step_dispatched"),
    );

    if (l2Actor) {
      const l2 = await buildContext(owner, l2Actor);
      const denied = await createPipeline(l2, {
        name: `越权 ${stamp}`,
        steps: [{ title: "x", brief: "x", aiEmployeeId: employeeId, aiEmployeeName: "x" }],
      })
        .then(() => false)
        .catch(() => true);
      check("L2 无管理产线权限时创建被拒绝", denied);

      const deniedRotate = await rotateWebhookToken(l2, pipeline.id)
        .then(() => false)
        .catch(() => true);
      check("L2 不能生成 Webhook 令牌", deniedRotate);
    }
  } finally {
    if (experienceSourceIds.length > 0) {
      const jobs = await owner
        .query("select id from experience_jobs where source_id = any($1::uuid[])", [
          experienceSourceIds.filter(Boolean),
        ])
        .catch(() => ({ rows: [] }));
      const jobIds = jobs.rows.map((row) => row.id);
      if (jobIds.length > 0) {
        await owner
          .query(
            "delete from card_evidence where card_id in (select id from knowledge_cards where source_job_id = any($1::uuid[]))",
            [jobIds],
          )
          .catch(() => undefined);
        await owner
          .query("delete from knowledge_cards where source_job_id = any($1::uuid[])", [jobIds])
          .catch(() => undefined);
        await owner.query("delete from experience_jobs where id = any($1::uuid[])", [jobIds]).catch(() => undefined);
      }
    }
    if (eventIds.length > 0) {
      await owner
        .query("delete from pipeline_events where id = any($1::uuid[])", [eventIds.filter(Boolean)])
        .catch(() => undefined);
    }
    if (pipelineIds.length > 0) {
      await owner
        .query("delete from audit_events where target_id = any($1::uuid[])", [pipelineIds])
        .catch(() => undefined);
    }
    if (workItemIds.length > 0) {
      await owner
        .query("delete from audit_events where target_id = any($1::uuid[])", [workItemIds])
        .catch(() => undefined);
      await owner.query("delete from work_items where id = any($1::uuid[])", [workItemIds]).catch(() => undefined);
    }
    if (runIds.length > 0) {
      await owner.query("delete from audit_events where target_id = any($1::uuid[])", [runIds]).catch(() => undefined);
      await owner.query("delete from runs where id = any($1::uuid[])", [runIds]).catch(() => undefined);
    }
    if (pipelineIds.length > 0) {
      const runRows = await owner
        .query("select id from pipeline_runs where pipeline_id = any($1::uuid[])", [pipelineIds])
        .catch(() => ({ rows: [] }));
      const pipelineRunIds = runRows.rows.map((row) => row.id);
      if (pipelineRunIds.length > 0) {
        await owner
          .query("delete from audit_events where target_id = any($1::uuid[])", [pipelineRunIds])
          .catch(() => undefined);
      }
      await owner.query("delete from pipeline_runs where pipeline_id = any($1::uuid[])", [pipelineIds]).catch(() => undefined);
      await owner.query("delete from pipelines where id = any($1::uuid[])", [pipelineIds]).catch(() => undefined);
    }
    if (employeeId) {
      await owner.query("delete from ai_employee_grants where ai_employee_id = $1", [employeeId]).catch(() => undefined);
      await owner.query("delete from ai_employees where id = $1", [employeeId]).catch(() => undefined);
    }
    await owner.end().catch(() => undefined);
  }

  console.log(`\n[pipelines] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[pipelines] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
