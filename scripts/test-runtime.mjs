/**
 * M3 运行时验收：受理幂等、队列租约、事件 seq、取消/续跑、收口、成本账本与 RLS 隔离。
 *
 * 写入以 owner 连接播种（绕过 RLS）；业务断言用 jxf_app + SET LOCAL，
 * 队列断言用 app_worker（受限角色，只拿运行时表 DML）。
 *
 * 运行：npm run test:runtime
 */
import { randomUUID } from "node:crypto";

import { Client, Pool } from "pg";

import { acceptRun } from "../src/lib/runtime/accept.ts";
import { claimRun, heartbeatRun, sweepExhausted } from "../src/lib/runtime/claim.ts";
import { purgeExpiredExperienceSourceText } from "../src/lib/knowledge/experience/queue.ts";
import { isCancelRequested, requestCancel } from "../src/lib/runtime/cancel.ts";
import { emitEvent, savePartialText } from "../src/lib/runtime/emit.ts";
import { markInterruptedForOthers, sweepStaleHeartbeat } from "../src/lib/runtime/recover.ts";
import {
  MAX_MEMORY_ITEMS,
  addThreadMemory,
  deleteThreadMemory,
  listThreadMemories,
} from "../src/lib/runtime/memory.ts";
import { resumeRun } from "../src/lib/runtime/resume.ts";
import { recordUsage } from "../src/lib/runtime/usage.ts";
import { buildSkillContext } from "../src/lib/runtime/skill-context.ts";
import { composeSystemPrompt } from "../src/lib/runtime/prompt.ts";
import { loadRunSnapshot } from "../src/lib/runtime/stream.ts";
import { getPool } from "../src/lib/db/pool.ts";

const TENANT = process.env.RUNTIME_TEST_TENANT ?? "44444444-4444-4444-8444-444444444444";
const HOST = process.env.SEED_DB_HOST ?? "127.0.0.1";
const PORT = process.env.SEED_DB_PORT ?? process.env.POSTGRES_PORT ?? "5432";
const DB = process.env.POSTGRES_DB;
const OWNER_URL = `postgresql://${process.env.JXF_OWNER_USER}:${process.env.JXF_OWNER_PASSWORD}@${HOST}:${PORT}/${DB}`;
const APP_URL = `postgresql://${process.env.JXF_APP_USER}:${process.env.JXF_APP_PASSWORD}@${HOST}:${PORT}/${DB}`;
const WORKER_USER = process.env.JXF_WORKER_USER ?? "app_worker";
const WORKER_URL = `postgresql://${WORKER_USER}:${process.env.JXF_WORKER_PASSWORD}@${HOST}:${PORT}/${DB}`;

// 成本按整数微元断言：1000 / 2000 微元每百万 token
process.env.JXF_AI_PRICE_PROMPT_MICROS_PER_MTOK ??= "1000";
process.env.JXF_AI_PRICE_COMPLETION_MICROS_PER_MTOK ??= "2000";
process.env.APP_DATABASE_URL ??= APP_URL;

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`[PASS] ${name}`);
  } else {
    failed += 1;
    console.error(`[FAIL] ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function withClient(url, fn) {
  const client = new Client({ connectionString: url, application_name: "jxf-runtime-test" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** 以 jxf_app + SET LOCAL 身份执行（复刻 withUserContext） */
async function runAs(actor, fn) {
  return withClient(APP_URL, async (client) => {
    await client.query("begin");
    await client.query(
      `select
         set_config('app.user_id', $1, true),
         set_config('app.tenant_id', $2, true),
         set_config('app.access_level', $3, true),
         set_config('app.department_ids', $4, true),
         set_config('app.active_department_id', $5, true),
         set_config('app.membership_id', $6, true)`,
      [
        actor.userId,
        TENANT,
        actor.level ?? "",
        `{${actor.departmentIds.join(",")}}`,
        actor.activeDepartmentId ?? "",
        actor.activeMembershipId ?? "",
      ],
    );
    try {
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function withWorkerTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function expectErrorCode(fn, expectedCode) {
  try {
    await fn();
    return { ok: false, error: null };
  } catch (error) {
    return { ok: error.code === expectedCode, error };
  }
}

async function resolveActor(userId, membershipId, departmentId) {
  return withClient(APP_URL, async (client) => {
    const { rows } = await client.query(
      "select app.user_department_ids($1) as ids, app.effective_access_level($1) as level",
      [userId],
    );
    const level = rows[0]?.level ?? null;
    let departmentIds = rows[0]?.ids ?? [];
    if (level === "L1") {
      const scope = await client.query("select app.tenant_department_ids($1) as ids", [TENANT]);
      departmentIds = scope.rows[0]?.ids ?? departmentIds;
    }
    return {
      userId,
      tenantId: TENANT,
      activeMembership: {
        id: membershipId,
        departmentId,
        departmentName: "",
        level,
        title: level === "L1" ? "创始人" : "交付顾问",
      },
      activeMemberships: [],
      activeMembershipId: membershipId,
      activeDepartmentId: departmentId,
      activeDepartmentName: "",
      membershipDepartmentIds: [departmentId],
      departmentIds,
      subtreeDepartmentIds: departmentIds,
      accessLevel: level,
      permissionVersion: 0,
    };
  });
}

async function cleanup(owner) {
  await owner.query("delete from token_usages where tenant_id = $1", [TENANT]);
  await owner.query("delete from runs where tenant_id = $1", [TENANT]);
  await owner.query("delete from threads where tenant_id = $1", [TENANT]);
  await owner.query("delete from ai_employee_grants where tenant_id = $1", [TENANT]);
  await owner.query("delete from ai_employees where tenant_id = $1", [TENANT]);
  await owner.query("delete from skills where tenant_id = $1", [TENANT]);
  await owner.query("delete from memberships where tenant_id = $1", [TENANT]);
  await owner.query(
    "delete from departments where tenant_id = $1 and id in (select descendant_id from department_closure where depth >= 2)",
    [TENANT],
  );
  await owner.query(
    "delete from departments where tenant_id = $1 and id in (select descendant_id from department_closure where depth = 1)",
    [TENANT],
  );
  await owner.query("delete from departments where tenant_id = $1", [TENANT]);
  await owner.query("delete from users where email like '%@rt.test'");
}

async function seed(owner) {
  await owner.query("begin");
  await cleanup(owner);

  const users = await owner.query(
    `insert into users (email, name) values
       ('a1@rt.test', '一组交付'),
       ('b1@rt.test', '二组顾问'),
       ('boss@rt.test', '运行态 L1')
     returning id, email`,
  );
  const uid = Object.fromEntries(users.rows.map((row) => [row.email, row.id]));

  const root = await owner.query(
    `insert into departments (tenant_id, parent_id, slug, name)
     values ($1, null, 'rt-root', '运行态总部') returning id`,
    [TENANT],
  );
  const groupA = await owner.query(
    `insert into departments (tenant_id, parent_id, slug, name)
     values ($1, $2, 'rt-group-a', '运行态一组') returning id`,
    [TENANT, root.rows[0].id],
  );
  const groupB = await owner.query(
    `insert into departments (tenant_id, parent_id, slug, name)
     values ($1, $2, 'rt-group-b', '运行态二组') returning id`,
    [TENANT, root.rows[0].id],
  );

  const memberships = await owner.query(
    `insert into memberships (tenant_id, user_id, department_id, title, access_level, status) values
       ($1, $2, $3, '交付顾问', 'L3', 'active'),
       ($1, $4, $5, '二组顾问', 'L3', 'active'),
       ($1, $6, $7, '创始人', 'L1', 'active')
     returning id, user_id`,
    [
      TENANT,
      uid["a1@rt.test"],
      groupA.rows[0].id,
      uid["b1@rt.test"],
      groupB.rows[0].id,
      uid["boss@rt.test"],
      root.rows[0].id,
    ],
  );
  const membershipOf = (email) => memberships.rows.find((row) => row.user_id === uid[email]).id;

  const skillKey = `rt-skill-${randomUUID().slice(0, 8)}`;
  const missingSkillKey = `rt-missing-${randomUUID().slice(0, 8)}`;
  await owner.query(
    `insert into skills (tenant_id, key, name, category, summary, hint, prompt_body, origin, status, created_by)
     values ($1, $2, '运行态技能', 'tool', '', '', $3, 'tenant', 'active', $4)`,
    [TENANT, skillKey, "技能要求：先给结论，再列依据。", uid["boss@rt.test"]],
  );
  const employee = await owner.query(
    `insert into ai_employees (tenant_id, slug, name, description, status, skill_keys, created_by)
     values ($1, $2, '运行态员工', '', 'active', $3::text[], $4)
     returning id`,
    [TENANT, `rt-emp-${randomUUID().slice(0, 8)}`, [skillKey, missingSkillKey], uid["boss@rt.test"]],
  );
  await owner.query(
    `insert into ai_employee_grants (tenant_id, ai_employee_id, department_id, capability, created_by)
     values ($1, $2, $3, 'use', $4)`,
    [TENANT, employee.rows[0].id, groupA.rows[0].id, uid["boss@rt.test"]],
  );

  await owner.query("commit");

  return {
    uid,
    deptA: groupA.rows[0].id,
    deptB: groupB.rows[0].id,
    deptRoot: root.rows[0].id,
    skillKey,
    employeeId: employee.rows[0].id,
    memberships: {
      a1: membershipOf("a1@rt.test"),
      b1: membershipOf("b1@rt.test"),
      boss: membershipOf("boss@rt.test"),
    },
  };
}

async function insertRun(owner, { departmentId, principalId, status = "queued", extra = {} }) {
  const { rows } = await owner.query(
    `insert into runs (tenant_id, department_id, kind, status, principal_id, input,
                       worker_id, lease_until, heartbeat_at, attempts)
     values ($1, $2, 'task', $3, $4, '{}'::jsonb, $5, $6, $7, $8)
     returning id`,
    [
      TENANT,
      departmentId,
      status,
      principalId,
      extra.workerId ?? null,
      extra.leaseUntil ?? null,
      extra.heartbeatAt ?? null,
      extra.attempts ?? 0,
    ],
  );
  return rows[0].id;
}

async function main() {
  const owner = new Client({ connectionString: OWNER_URL, application_name: "jxf-runtime-test-owner" });
  await owner.connect();
  const seeded = await seed(owner);
  const { uid, deptA, deptB, deptRoot, memberships, skillKey, employeeId } = seeded;
  const workerPool = new Pool({ connectionString: WORKER_URL, max: 4, application_name: "jxf-runtime-worker" });

  const a1 = await resolveActor(uid["a1@rt.test"], memberships.a1, deptA);
  const b1 = await resolveActor(uid["b1@rt.test"], memberships.b1, deptB);
  const boss = await resolveActor(uid["boss@rt.test"], memberships.boss, deptRoot);

  try {
    // -------------------------------------------------------------------------
    // 0. 技能上下文装配（纯函数，不依赖数据库）
    // -------------------------------------------------------------------------
    const skillCtx = buildSkillContext(
      ["skill-a", "skill-off", "skill-empty", "skill-gone"],
      [
        { key: "skill-a", name: "技能 A", version: 2, status: "active", prompt_body: "A 正文" },
        { key: "skill-off", name: "停用技能", version: 1, status: "retired", prompt_body: "不该出现" },
        { key: "skill-empty", name: "空技能", version: 1, status: "active", prompt_body: "   " },
      ],
    );
    check(
      "技能按勾选顺序注入正文",
      skillCtx.prompt.includes("## 技能 A（skill-a · v2）") && skillCtx.prompt.includes("A 正文"),
    );
    check(
      "停用 / 空正文 / 缺失技能被跳过并记录原因",
      skillCtx.entries
        .map((item) => item.skippedReason ?? "injected")
        .join(",") === "injected,inactive,empty,missing" &&
        skillCtx.entries[0].injected === true,
      JSON.stringify(skillCtx.entries),
    );

    const longCtx = buildSkillContext(
      ["skill-long"],
      [{ key: "skill-long", name: "长技能", version: 1, status: "active", prompt_body: "x".repeat(9000) }],
      { perSkill: 3000, total: 6000 },
    );
    check(
      "单技能超限被截断且总量不超预算",
      longCtx.chars === 3000 && longCtx.truncated && longCtx.entries[0].truncated === true,
      String(longCtx.chars),
    );

    const composed = composeSystemPrompt({
      kind: "task",
      employee: {
        name: "运行态员工",
        persona: "严谨",
        skillsPrompt: "【可用技能】\n\n## 技能 A\nA 正文",
      },
      memory: "记忆 X",
    });
    check(
      "系统提示顺序：身份 → 技能 → 记忆",
      composed.indexOf("A 正文") > composed.indexOf("人格设定：严谨") &&
        composed.indexOf("记忆 X") > composed.indexOf("A 正文"),
      composed,
    );
    check(
      "无员工时保持默认提示",
      composeSystemPrompt({ kind: "chat", employee: null, memory: "" }) ===
        "你是企业内部的 AI 助手，回答必须基于已知信息，不确定就如实说明。",
    );

    // -------------------------------------------------------------------------
    // 1. 受理与幂等
    // -------------------------------------------------------------------------
    const turn = randomUUID();
    const accepted = await acceptRun(a1, {
      kind: "chat",
      input: { question: "运行时幂等验收：这条问题只会产生一个 run" },
      clientTurnId: turn,
    });
    check("受理返回 queued run", accepted.status === "queued", accepted.status);
    check("chat 自动创建会话", Boolean(accepted.threadId));

    const duplicate = await acceptRun(a1, {
      kind: "chat",
      input: { question: "运行时幂等验收：这条问题只会产生一个 run" },
      clientTurnId: turn,
    });
    check(
      "同一 clientTurnId 重复提交返回同一 run 且 resumed",
      duplicate.runId === accepted.runId && duplicate.resumed === true && duplicate.threadId === accepted.threadId,
    );

    const concurrentTurn = randomUUID();
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () =>
        acceptRun(a1, {
          kind: "chat",
          input: { question: "并发提交只产生一个 run" },
          clientTurnId: concurrentTurn,
        }),
      ),
    );
    check("并发 5 次提交只产生一个 run", new Set(concurrent.map((item) => item.runId)).size === 1);
    const concurrentRuns = await owner.query(
      "select count(1)::int as n from runs where tenant_id = $1 and client_turn_id = $2",
      [TENANT, concurrentTurn],
    );
    check("并发提交 run 行数为 1", concurrentRuns.rows[0].n === 1, String(concurrentRuns.rows[0].n));
    const concurrentThreads = await owner.query(
      "select count(1)::int as n from threads where tenant_id = $1 and title = $2",
      [TENANT, "并发提交只产生一个 run"],
    );
    check("并发提交不产生孤儿会话", concurrentThreads.rows[0].n === 1, String(concurrentThreads.rows[0].n));

    await owner.query("update runs set status = 'done', finished_at = now() where tenant_id = $1 and client_turn_id = $2", [
      TENANT,
      concurrentTurn,
    ]);

    // -------------------------------------------------------------------------
    // 2. RLS：跨部门隔离与只追加
    // -------------------------------------------------------------------------
    const readOwn = await runAs(a1, (client) =>
      client.query("select count(1)::int as n from runs where id = $1", [accepted.runId]),
    );
    check("本部门可读自己的 run", readOwn.rows[0].n === 1);

    const readCross = await runAs(b1, (client) =>
      client.query("select count(1)::int as n from runs where id = $1", [accepted.runId]),
    );
    check("跨部门读 run 返回 0 行", readCross.rows[0].n === 0);

    const threadCross = await runAs(b1, (client) =>
      client.query("select count(1)::int as n from threads where id = $1", [accepted.threadId]),
    );
    check("跨部门读 thread 返回 0 行", threadCross.rows[0].n === 0);

    const updateCross = await runAs(b1, (client) =>
      client.query("update runs set result = '{\"x\":1}'::jsonb where id = $1", [accepted.runId]),
    );
    check("跨部门更新 run 影响 0 行", updateCross.rowCount === 0, String(updateCross.rowCount));

    const insertCross = await runAs(b1, (client) =>
      client.query(
        `insert into runs (tenant_id, department_id, kind, principal_id)
         values ($1, $2, 'task', $3)`,
        [TENANT, deptA, uid["b1@rt.test"]],
      ),
    ).catch((error) => error);
    check("跨部门写 run 被拒绝（42501）", insertCross?.code === "42501", insertCross?.code);

    const appInsertEvent = await expectErrorCode(
      () =>
        runAs(a1, (client) =>
          client.query(
            `insert into run_events (run_id, seq, department_id, type) values ($1, 999, $2, 'status')`,
            [accepted.runId, deptA],
          ),
        ),
      "42501",
    );
    check("业务角色不能直接写 run_events（只追加由 worker 负责）", appInsertEvent.ok, appInsertEvent.error?.code);

    const appDeleteEvent = await runAs(a1, (client) =>
      client.query("delete from run_events where run_id = $1", [accepted.runId]),
    );
    check("业务角色删除 run_events 影响 0 行（无 DELETE 策略）", appDeleteEvent.rowCount === 0, String(appDeleteEvent.rowCount));

    const appDeleteRun = await runAs(a1, (client) => client.query("delete from runs where id = $1", [accepted.runId]));
    const runStillThere = await owner.query("select count(1)::int as n from runs where id = $1", [accepted.runId]);
    check(
      "业务角色删除 run 影响 0 行且数据仍在",
      appDeleteRun.rowCount === 0 && runStillThere.rows[0].n === 1,
      `${appDeleteRun.rowCount}/${runStillThere.rows[0].n}`,
    );

    // 经验沉淀通道会显式授予 worker 对 knowledge_cards 的读写，因此这里改用
    // 仍然完全属于业务侧的知识库主表 documents 做越权判定。
    const workerReadBusiness = await expectErrorCode(
      () => workerPool.query("select count(1) from documents"),
      "42501",
    );
    check("worker 角色不持有业务表权限", workerReadBusiness.ok, workerReadBusiness.error?.code);

    const workerInsertRun = await expectErrorCode(
      () =>
        workerPool.query(
          `insert into runs (tenant_id, department_id, kind, principal_id) values ($1, $2, 'task', $3)`,
          [TENANT, deptA, uid["a1@rt.test"]],
        ),
      "42501",
    );
    check("worker 不能创建 run", workerInsertRun.ok, workerInsertRun.error?.code);

    // -------------------------------------------------------------------------
    // 3. worker 写 step / 事件：seq 原子递增、瞬时内容不落库
    // -------------------------------------------------------------------------
    const stepId = await withWorkerTx(workerPool, async (client) => {
      const step = await client.query(
        "insert into run_steps (run_id, ord, phase) values ($1, 1, 'answer') returning id",
        [accepted.runId],
      );
      return step.rows[0].id;
    });
    await workerPool.query(
      `update run_steps set model = 'test-model', provider = 'test', finish_reason = 'stop', duration_ms = 12
        where id = $1`,
      [stepId],
    );
    const stepRow = await owner.query("select model, finish_reason, duration_ms from run_steps where id = $1", [stepId]);
    check(
      "worker 可回填 run_steps 的模型与耗时",
      stepRow.rows[0].model === "test-model" && stepRow.rows[0].finish_reason === "stop",
      JSON.stringify(stepRow.rows[0]),
    );

    const appUpdateStep = await runAs(a1, (client) =>
      client.query("update run_steps set finish_reason = 'tampered' where id = $1", [stepId]),
    );
    const stepAfterAppUpdate = await owner.query("select finish_reason from run_steps where id = $1", [stepId]);
    check(
      "业务角色改 run_steps 影响 0 行（无 UPDATE 策略）",
      appUpdateStep.rowCount === 0 && stepAfterAppUpdate.rows[0].finish_reason === "stop",
      `${appUpdateStep.rowCount}/${stepAfterAppUpdate.rows[0].finish_reason}`,
    );

    const stepReadOwn = await runAs(a1, (client) =>
      client.query("select count(1)::int as n from run_steps where run_id = $1", [accepted.runId]),
    );
    const stepReadCross = await runAs(b1, (client) =>
      client.query("select count(1)::int as n from run_steps where run_id = $1", [accepted.runId]),
    );
    check("本部门可读 run_steps", stepReadOwn.rows[0].n === 1);
    check("跨部门读 run_steps 返回 0 行", stepReadCross.rows[0].n === 0);

    const seqs = [];
    for (const type of ["status", "step", "tool"]) {
      const seq = await withWorkerTx(workerPool, (client) => emitEvent(client, accepted.runId, type, { probe: type }));
      seqs.push(seq);
    }
    check("事件 seq 从 1 单调递增", seqs.join(",") === "1,2,3", seqs.join(","));

    const eventOwn = await runAs(a1, (client) =>
      client.query("select count(1)::int as n from run_events where run_id = $1", [accepted.runId]),
    );
    const eventCross = await runAs(b1, (client) =>
      client.query("select count(1)::int as n from run_events where run_id = $1", [accepted.runId]),
    );
    check("本部门可读 run_events", eventOwn.rows[0].n === 3, String(eventOwn.rows[0].n));
    check("跨部门读 run_events 返回 0 行", eventCross.rows[0].n === 0);

    // 300 次 delta 快照：只更新 partial_text，不产生事件行
    await withWorkerTx(workerPool, async (client) => {
      for (let index = 1; index <= 300; index += 1) {
        await savePartialText(client, accepted.runId, `片段 ${index}`);
      }
    });
    const afterDeltas = await owner.query(
      `select (select count(1)::int from run_events where run_id = $1) as events,
              (select last_seq from runs where id = $1) as last_seq,
              (select partial_text from runs where id = $1) as partial_text`,
      [accepted.runId],
    );
    check(
      "300 次 delta 不落事件（只更新 partial_text 快照）",
      afterDeltas.rows[0].events === 3 && Number(afterDeltas.rows[0].last_seq) === 3 && afterDeltas.rows[0].partial_text === "片段 300",
      JSON.stringify(afterDeltas.rows[0]),
    );

    // -------------------------------------------------------------------------
    // 4. 成本账本：一次调用一行，runs 冗余与之一致
    // -------------------------------------------------------------------------
    const usage = await recordUsage(workerPool, {
      tenantId: TENANT,
      departmentId: deptA,
      runId: accepted.runId,
      stepId,
      provider: "test",
      model: "test-model",
      promptTokens: 1000,
      completionTokens: 500,
    });
    const usageRow = await owner.query(
      `select count(1)::int as rows,
              (select prompt_tokens from runs where id = $1) as prompt_tokens,
              (select completion_tokens from runs where id = $1) as completion_tokens,
              (select cost_micros from runs where id = $1) as cost_micros
         from token_usages where run_id = $1`,
      [accepted.runId],
    );
    check("每次模型调用恰好一行 token_usages", usageRow.rows[0].rows === 1, String(usageRow.rows[0].rows));
    check(
      "runs 冗余用量与 cost_micros 等于账本累加",
      Number(usageRow.rows[0].prompt_tokens) === 1000 &&
        Number(usageRow.rows[0].completion_tokens) === 500 &&
        Number(usageRow.rows[0].cost_micros) === usage.costMicros &&
        usage.costMicros === 2,
      JSON.stringify(usageRow.rows[0]),
    );
    const usageCross = await runAs(b1, (client) =>
      client.query("select count(1)::int as n from token_usages where run_id = $1", [accepted.runId]),
    );
    check("跨部门读 token_usages 返回 0 行", usageCross.rows[0].n === 0);

    // -------------------------------------------------------------------------
    // 5. 队列：领取、续租、过期回收、尝试次数上限
    // -------------------------------------------------------------------------
    const acceptedClaim = await claimRun(workerPool, "worker-1");
    check("worker 领取 queued run", acceptedClaim?.id === accepted.runId, acceptedClaim?.id);
    check("领取后 attempts=1 且状态 running", acceptedClaim?.attempts === 1);
    await owner.query("update runs set status = 'done', finished_at = now(), lease_until = null where id = $1", [
      accepted.runId,
    ]);

    const claimRunId = await insertRun(owner, { departmentId: deptA, principalId: uid["a1@rt.test"] });
    const firstClaim = await claimRun(workerPool, "worker-1");
    check("首次领取 attempts=1", firstClaim?.id === claimRunId && firstClaim?.attempts === 1, JSON.stringify(firstClaim));

    await owner.query("update runs set lease_until = now() - interval '1 second' where id = $1", [claimRunId]);
    const reclaimed = await claimRun(workerPool, "worker-1");
    check("租约过期后任务被回收，attempts 递增", reclaimed?.id === claimRunId && reclaimed?.attempts === 2, JSON.stringify(reclaimed));

    await owner.query("update runs set lease_until = now() - interval '1 second' where id = $1", [claimRunId]);
    const third = await claimRun(workerPool, "worker-1");
    check("第三次领取 attempts=3", third?.id === claimRunId && third?.attempts === 3, JSON.stringify(third));

    await owner.query("update runs set lease_until = now() + interval '1 second' where id = $1", [claimRunId]);
    await heartbeatRun(workerPool, claimRunId, "worker-1", 120);
    const heartbeat = await owner.query("select lease_until > now() + interval '60 seconds' as extended from runs where id = $1", [
      claimRunId,
    ]);
    check("心跳续租延长 lease", heartbeat.rows[0].extended === true);

    await owner.query("update runs set lease_until = now() - interval '1 second' where id = $1", [claimRunId]);
    const exhausted = await sweepExhausted(workerPool);
    const exhaustedRow = await owner.query("select status, error from runs where id = $1", [claimRunId]);
    check(
      "attempts 达上限后置 failed，不再重试",
      exhausted.includes(claimRunId) && exhaustedRow.rows[0].status === "failed",
      JSON.stringify(exhaustedRow.rows[0]),
    );
    const afterExhausted = await claimRun(workerPool, "worker-1");
    check("failed 任务不会被再次领取", afterExhausted === null);

    const x = await insertRun(owner, { departmentId: deptA, principalId: uid["a1@rt.test"] });
    const y = await insertRun(owner, { departmentId: deptA, principalId: uid["a1@rt.test"] });
    const [claimX, claimY] = await Promise.all([
      claimRun(workerPool, "worker-a"),
      claimRun(workerPool, "worker-b"),
    ]);
    check(
      "两个 worker 并发领取不会拿到同一条（SKIP LOCKED）",
      claimX && claimY && claimX.id !== claimY.id && new Set([claimX.id, claimY.id]).size === 2,
      `${claimX?.id} / ${claimY?.id}`,
    );
    check("并发领取覆盖两条 queued 任务", [claimX?.id, claimY?.id].sort().join(",") === [x, y].sort().join(","));
    await owner.query("update runs set status = 'done', finished_at = now(), lease_until = null where id = any($1::uuid[])", [
      [x, y],
    ]);

    // -------------------------------------------------------------------------
    // 6. 取消与继续执行
    // -------------------------------------------------------------------------
    const cancelRunId = await insertRun(owner, { departmentId: deptA, principalId: uid["a1@rt.test"] });
    const cancelled = await requestCancel(a1, cancelRunId);
    check("用户取消写入 cancel_requested_at", cancelled);
    check("worker 能读到取消请求", await isCancelRequested(workerPool, cancelRunId));
    const crossCancel = await requestCancel(b1, cancelRunId).then(
      () => false,
      () => true,
    );
    check("跨部门用户不能取消", crossCancel);

    await owner.query("update runs set status = 'interrupted', worker_id = null, finished_at = now() where id = $1", [
      cancelRunId,
    ]);
    const resumed = await resumeRun(a1, cancelRunId);
    const resumedRow = await owner.query(
      "select status, cancel_requested_at, worker_id from runs where id = $1",
      [cancelRunId],
    );
    check(
      "interrupted 可显式继续执行并清空取消位",
      resumed && resumedRow.rows[0].status === "queued" && resumedRow.rows[0].cancel_requested_at === null,
      JSON.stringify(resumedRow.rows[0]),
    );

    await owner.query("update runs set status = 'done', finished_at = now() where id = $1", [cancelRunId]);
    check("done 状态不能继续执行", !(await resumeRun(a1, cancelRunId)));

    // -------------------------------------------------------------------------
    // 7. 收口：重启与心跳超时
    // -------------------------------------------------------------------------
    const orphan = await insertRun(owner, {
      departmentId: deptA,
      principalId: uid["a1@rt.test"],
      status: "running",
      extra: {
        workerId: "worker-old",
        leaseUntil: new Date(Date.now() + 90_000),
        heartbeatAt: new Date(),
      },
    });
    const stillOwned = await insertRun(owner, {
      departmentId: deptA,
      principalId: uid["boss@rt.test"],
      status: "running",
      extra: {
        workerId: "worker-current",
        leaseUntil: new Date(Date.now() + 90_000),
        heartbeatAt: new Date(),
      },
    });
    const recovered = await markInterruptedForOthers(workerPool, "worker-current");
    const orphanRow = await owner.query(
      "select status, error, (select count(1)::int from run_events e where e.run_id = $1 and e.type = 'status') as events from runs where id = $1",
      [orphan],
    );
    const stillOwnedRow = await owner.query("select status from runs where id = $1", [stillOwned]);
    check("重启后不属于本进程的 running 收口为 interrupted", recovered.includes(orphan));
    check(
      "收口写 status 事件且 error 说明原因",
      orphanRow.rows[0].status === "interrupted" &&
        orphanRow.rows[0].error === "worker restarted" &&
        orphanRow.rows[0].events === 1,
      JSON.stringify(orphanRow.rows[0]),
    );
    check("属于本进程的 running 不被误收口", stillOwnedRow.rows[0].status === "running");

    const stale = await insertRun(owner, {
      departmentId: deptA,
      principalId: uid["a1@rt.test"],
      status: "running",
      extra: {
        workerId: "worker-current",
        leaseUntil: new Date(Date.now() + 90_000),
        heartbeatAt: new Date(Date.now() - 120_000),
      },
    });
    const swept = await sweepStaleHeartbeat(workerPool);
    const staleRow = await owner.query("select status, error from runs where id = $1", [stale]);
    check(
      "心跳超时 60s 收口为 interrupted（不是 failed）",
      swept.includes(stale) && staleRow.rows[0].status === "interrupted" && staleRow.rows[0].error === "heartbeat timeout",
      JSON.stringify(staleRow.rows[0]),
    );

    // -------------------------------------------------------------------------
    // 8. 列表查询不扫事件表
    // -------------------------------------------------------------------------
    await owner.query("set enable_seqscan = off");
    const plan = await owner.query(
      "explain (format text) select id from runs where department_id = $1 order by created_at desc limit 50",
      [deptA],
    );
    await owner.query("reset enable_seqscan");
    check(
      "运行列表按 department_id + created_at 走索引",
      plan.rows.some((row) => String(row["QUERY PLAN"]).includes("runs_department_created_idx")),
      plan.rows.map((row) => row["QUERY PLAN"]).join(" | "),
    );

    // -------------------------------------------------------------------------
    // 9. Redis 之外的越权补充：L1 可跨部门读
    // -------------------------------------------------------------------------
    const bossRead = await runAs(boss, (client) =>
      client.query("select count(1)::int as n from runs where id = $1", [accepted.runId]),
    );
    check("L1 可读任意部门 run", bossRead.rows[0].n === 1);

    // -------------------------------------------------------------------------
    // 10. 会话记忆：仅本人可见、注入当前会话、上限与删除
    // -------------------------------------------------------------------------
    const memoryText = "客户偏好：先给结论再给论据";
    const memory = await addThreadMemory(a1, accepted.threadId, memoryText);
    const memoryList = await listThreadMemories(a1, accepted.threadId);
    check(
      "本人可读到自己置顶的会话记忆",
      memoryList.length === 1 && memoryList[0].id === memory.id && memoryList[0].content === memoryText,
      JSON.stringify(memoryList),
    );

    const memoryDirectCross = await runAs(b1, (client) =>
      client.query("select count(1)::int as n from thread_memories where thread_id = $1", [accepted.threadId]),
    );
    check("RLS 让其他用户直接查询会话记忆返回 0 行", memoryDirectCross.rows[0].n === 0, String(memoryDirectCross.rows[0].n));

    const memoryOtherList = await listThreadMemories(b1, accepted.threadId);
    check("其他用户读不到他人会话记忆", memoryOtherList.length === 0, String(memoryOtherList.length));

    const memoryRun = await acceptRun(a1, {
      kind: "chat",
      input: { question: "会话记忆注入验收" },
      threadId: accepted.threadId,
      clientTurnId: randomUUID(),
    });
    const memoryRunRow = await owner.query("select input->>'memory' as memory from runs where id = $1", [memoryRun.runId]);
    check(
      "受理时把会话记忆快照进 runs.input",
      memoryRunRow.rows[0].memory === `- ${memoryText}`,
      JSON.stringify(memoryRunRow.rows[0]),
    );
    await owner.query("update runs set status = 'done', finished_at = now() where id = $1", [memoryRun.runId]);

    const memoryAudit = await owner.query(
      "select count(1)::int as n from audit_events where action = 'chat.memory_added' and target_id = $1",
      [memory.id],
    );
    check("置顶记忆写入审计", memoryAudit.rows[0].n === 1, String(memoryAudit.rows[0].n));

    const tooLong = await addThreadMemory(a1, accepted.threadId, "长".repeat(501)).then(
      () => false,
      () => true,
    );
    check("单条记忆超过 500 字被拒绝", tooLong);

    const capThread = await acceptRun(a1, {
      kind: "chat",
      input: { question: "记忆上限验收会话" },
      clientTurnId: randomUUID(),
    });
    for (let index = 1; index <= MAX_MEMORY_ITEMS; index += 1) {
      await addThreadMemory(a1, capThread.threadId, `偏好 ${index}`);
    }
    const overCap = await addThreadMemory(a1, capThread.threadId, "第 11 条").then(
      () => false,
      () => true,
    );
    check(`每条会话最多 ${MAX_MEMORY_ITEMS} 条记忆`, overCap);

    await deleteThreadMemory(a1, memory.id);
    const afterDelete = await listThreadMemories(a1, accepted.threadId);
    check("删除后本人会话记忆列表为空", afterDelete.length === 0, String(afterDelete.length));

    // -------------------------------------------------------------------------
    // 10.5 技能注入：受理快照 + 运行快照可见性
    // -------------------------------------------------------------------------
    const skillRun = await acceptRun(a1, {
      kind: "task",
      input: { question: "技能注入验收", title: "技能注入验收" },
      aiEmployeeId: employeeId,
      clientTurnId: randomUUID(),
    });
    const skillSnapshot = await owner.query(
      "select input->'employee' as employee from runs where id = $1",
      [skillRun.runId],
    );
    const employeeSnapshot = skillSnapshot.rows[0]?.employee ?? {};
    const skillEntries = Array.isArray(employeeSnapshot.skills) ? employeeSnapshot.skills : [];
    check(
      "受理时把技能正文快照进 runs.input",
      typeof employeeSnapshot.skillsPrompt === "string" &&
        employeeSnapshot.skillsPrompt.includes("先给结论") &&
        employeeSnapshot.skillsPromptChars === skillEntries[0]?.chars,
      JSON.stringify({ chars: employeeSnapshot.skillsPromptChars, entries: skillEntries }),
    );
    check(
      "注入结果包含生效与缺失两类",
      skillEntries[0]?.key === skillKey &&
        skillEntries[0]?.injected === true &&
        skillEntries[1]?.skippedReason === "missing",
      JSON.stringify(skillEntries),
    );

    const visibleSnapshot = await runAs(a1, (client) => loadRunSnapshot(client, skillRun.runId));
    check(
      "运行快照向调用者暴露技能注入结果",
      visibleSnapshot?.employeeSkills.length === 2 &&
        visibleSnapshot.employeeSkills[0].key === skillKey &&
        visibleSnapshot.employeeSkills[0].injected === true,
      JSON.stringify(visibleSnapshot?.employeeSkills),
    );
    await owner.query("update runs set status = 'done', finished_at = now() where id = $1", [skillRun.runId]);

    // -------------------------------------------------------------------------
    // 11. 经验来源文本保留期：过期置空、pending 引用跳过、未到期保留
    //     整个断言在 worker 事务内执行并回滚，避免清掉库里其他过期文本
    // -------------------------------------------------------------------------
    const insertJob = (text, ageDays) =>
      owner.query(
        `insert into experience_jobs
           (tenant_id, department_id, channel, source_type, source_id, source_version,
            cooldown_bucket, source_text, status, created_at)
         values ($1, $2, 'manual', 'pipeline_run', $3, 'v1', $4, $5, 'done',
                 now() - make_interval(days => $6))
         returning id`,
        [TENANT, deptA, randomUUID(), `manual:${randomUUID()}`, text, ageDays],
      );

    const expiredJob = await insertJob("过期来源文本", 100);
    const referencedJob = await insertJob("被引用来源文本", 100);
    const freshJob = await insertJob("未过期来源文本", 1);
    await owner.query(
      `insert into knowledge_cards
         (tenant_id, department_id, kind, title, body, status, origin, folder_key,
          source_job_id, source_channel)
       values ($1, $2, 'fact', '保留期引用卡', '正文', 'pending', 'distill', '05-distill', $3, 'pipeline')`,
      [TENANT, deptA, referencedJob.rows[0].id],
    );

    const purgeClient = await workerPool.connect();
    try {
      await purgeClient.query("begin");
      const purgedResult = await purgeExpiredExperienceSourceText(purgeClient);
      const afterPurge = await purgeClient.query(
        "select id, source_text from experience_jobs where id = any($1::uuid[])",
        [[expiredJob.rows[0].id, referencedJob.rows[0].id, freshJob.rows[0].id]],
      );
      const sourceTextOf = Object.fromEntries(afterPurge.rows.map((row) => [row.id, row.source_text]));
      check(
        "保留期：过期且未被引用的来源文本被清空",
        sourceTextOf[expiredJob.rows[0].id] === null,
        JSON.stringify(sourceTextOf[expiredJob.rows[0].id]),
      );
      check(
        "保留期：被 pending 卡引用的旧 job 保留原文",
        sourceTextOf[referencedJob.rows[0].id] === "被引用来源文本",
        JSON.stringify(sourceTextOf[referencedJob.rows[0].id]),
      );
      check(
        "保留期：未到期的来源文本保留",
        sourceTextOf[freshJob.rows[0].id] === "未过期来源文本",
        JSON.stringify(sourceTextOf[freshJob.rows[0].id]),
      );
      check(
        "保留期：返回清理与跳过计数",
        purgedResult.purged >= 1 && purgedResult.skipped >= 1,
        JSON.stringify(purgedResult),
      );
      await purgeClient.query("rollback");
    } finally {
      purgeClient.release();
    }
  } finally {
    await owner.query("begin");
    await cleanup(owner);
    await owner.query("commit");
    await owner.end();
    await workerPool.end();
    await getPool().end();
  }

  console.log(`\n[RUNTIME] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[RUNTIME] 执行失败", error);
  process.exit(1);
});
