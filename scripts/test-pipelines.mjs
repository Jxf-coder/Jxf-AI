/**
 * 自动化产线（P5 后续切片）验收：定义、批量派活、运行记录与权限边界。
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
  let pipelineId = null;
  let pipelineRunId = null;
  const workItemIds = [];
  const runIds = [];

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

    const pipeline = await createPipeline(l1, {
      name: `产线测试 ${stamp}`,
      description: "自动化测试创建的临时产线",
      steps: [
        { title: "整理数据", brief: "整理本季度销售数据并输出要点", aiEmployeeId: employeeId, aiEmployeeName: "产线测试员工" },
        { title: "生成摘要", brief: "基于上一步结果生成三层摘要", aiEmployeeId: employeeId, aiEmployeeName: "产线测试员工" },
      ],
    });
    pipelineId = pipeline.id;
    check("L1 可创建产线", pipeline.steps.length === 2 && pipeline.enabled);

    const listed = await listPipelines(l1);
    check("L1 可见新建产线", listed.some((item) => item.id === pipelineId));

    const result = await runPipeline(l1, pipelineId);
    pipelineRunId = result.runId;
    check("运行产线派出全部步骤", result.workItemIds.length === 2 && result.failedStep === null);
    workItemIds.push(...result.workItemIds);

    const items = await owner.query(
      "select id, status, current_run_id from work_items where id = any($1::uuid[])",
      [workItemIds],
    );
    check("工作项已落库并排队", items.rows.length === 2 && items.rows.every((row) => row.status === "queued"));
    for (const row of items.rows) {
      if (row.current_run_id) {
        runIds.push(row.current_run_id);
      }
    }
    check("每一步都受理了 run", runIds.length === 2);

    const runs = await listPipelineRuns(l1);
    const target = runs.find((item) => item.pipelineId === pipelineId);
    check("运行记录聚合状态为执行中", target?.status === "running" && target.activeCount === 2);

    const audits = await owner.query(
      "select action from audit_events where target_id = any($1::uuid[])",
      [[pipelineId, pipelineRunId].filter(Boolean)],
    );
    check(
      "创建与运行均写审计",
      audits.rows.some((row) => row.action === "pipeline.created") &&
        audits.rows.some((row) => row.action === "pipeline.run"),
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
    }
  } finally {
    if (pipelineId) {
      await owner.query("delete from audit_events where target_id = $1", [pipelineId]).catch(() => undefined);
    }
    if (pipelineRunId) {
      await owner.query("delete from audit_events where target_id = $1", [pipelineRunId]).catch(() => undefined);
    }
    if (workItemIds.length > 0) {
      await owner.query("delete from audit_events where target_id = any($1::uuid[])", [workItemIds]).catch(() => undefined);
      await owner.query("delete from work_items where id = any($1::uuid[])", [workItemIds]).catch(() => undefined);
    }
    if (runIds.length > 0) {
      await owner.query("delete from audit_events where target_id = any($1::uuid[])", [runIds]).catch(() => undefined);
      await owner.query("delete from runs where id = any($1::uuid[])", [runIds]).catch(() => undefined);
    }
    if (pipelineId) {
      await owner.query("delete from pipeline_runs where pipeline_id = $1", [pipelineId]).catch(() => undefined);
      await owner.query("delete from pipelines where id = $1", [pipelineId]).catch(() => undefined);
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
