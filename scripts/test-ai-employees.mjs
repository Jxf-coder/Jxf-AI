/**
 * M2 尾 · AI 员工目录与授权验收。
 *
 * 覆盖：Fail-Closed 可见性、草稿语义、部门子树继承、个人例外、授权表不泄露、
 *       L1 独占写权限、创建者 manage 授权保护、离职后立即不可见、审计落库。
 *
 * 写入以 owner 连接播种（绕过 RLS），断言全部以 jxf_app + SET LOCAL 身份执行。
 * 运行：npm run test:ai-employees
 */
import { Client } from "pg";

import {
  createAiEmployee,
  grantAiEmployeeToDepartment,
  grantAiEmployeeToUser,
  listAiEmployees,
  listAiEmployeeGrantCandidates,
  loadAiEmployee,
  revokeAiEmployeeGrant,
  setAiEmployeeStatus,
} from "../src/lib/ai-employees.ts";
import { PermissionDeniedError } from "../src/lib/permissions/guard.ts";

const TENANT = process.env.AI_TEST_TENANT ?? "33333333-3333-4333-8333-333333333333";
const HOST = process.env.SEED_DB_HOST ?? "127.0.0.1";
const PORT = process.env.SEED_DB_PORT ?? process.env.POSTGRES_PORT ?? "5432";
const DB = process.env.POSTGRES_DB;
const OWNER_URL = `postgresql://${process.env.JXF_OWNER_USER}:${process.env.JXF_OWNER_PASSWORD}@${HOST}:${PORT}/${DB}`;
const APP_URL = `postgresql://${process.env.JXF_APP_USER}:${process.env.JXF_APP_PASSWORD}@${HOST}:${PORT}/${DB}`;

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
  const client = new Client({ connectionString: url, application_name: "jxf-ai-employee-test" });
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
        actor.departmentIds[0] ?? "",
        actor.membershipId ?? "",
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

/** 从数据库真实解析身份（离职/调岗后重新解析，模拟下一次请求） */
async function resolveActor(userId, membershipId) {
  return withClient(APP_URL, async (client) => {
    const { rows } = await client.query(
      "select app.user_department_ids($1) as ids, app.effective_access_level($1) as level",
      [userId],
    );
    const level = rows[0]?.level ?? null;
    const ownDepartments = rows[0]?.ids ?? [];
    let departmentIds = ownDepartments;
    if (level === "L1") {
      const scope = await client.query("select app.tenant_department_ids($1) as ids", [TENANT]);
      departmentIds = scope.rows[0]?.ids ?? ownDepartments;
    }
    return { userId, level, departmentIds, membershipId };
  });
}

async function expectError(fn, code) {
  try {
    await fn();
    return { ok: false, error: null };
  } catch (error) {
    return { ok: !code || error.code === code, error };
  }
}

async function cleanup(owner) {
  await owner.query("delete from ai_employees where tenant_id = $1", [TENANT]);
  await owner.query("delete from memberships where tenant_id = $1", [TENANT]);
  await owner.query(
    "delete from departments where tenant_id = $1 and id in (select descendant_id from department_closure where depth >= 3)",
    [TENANT],
  );
  await owner.query(
    "delete from departments where tenant_id = $1 and id in (select descendant_id from department_closure where depth = 2)",
    [TENANT],
  );
  await owner.query(
    "delete from departments where tenant_id = $1 and id in (select descendant_id from department_closure where depth = 1)",
    [TENANT],
  );
  await owner.query("delete from departments where tenant_id = $1", [TENANT]);
  await owner.query("delete from users where email like '%@ai.test'");
}

async function seed() {
  return withClient(OWNER_URL, async (owner) => {
    await owner.query("begin");
    await cleanup(owner);

    const users = await owner.query(
      `insert into users (email, name) values
         ('a1@ai.test', '一组顾问'),
         ('a2@ai.test', '一组经理'),
         ('a3@ai.test', '华东小队顾问'),
         ('b1@ai.test', '二组顾问'),
         ('boss@ai.test', '创始人')
       returning id, email`,
    );
    const uid = Object.fromEntries(users.rows.map((row) => [row.email, row.id]));

    const root = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, null, 'ai-root', 'AI 总部') returning id`,
      [TENANT],
    );
    const groupA = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'ai-group-a', 'AI 一组') returning id`,
      [TENANT, root.rows[0].id],
    );
    const groupB = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'ai-group-b', 'AI 二组') returning id`,
      [TENANT, root.rows[0].id],
    );
    const teamA1 = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'ai-team-a1', 'AI 华东小队') returning id`,
      [TENANT, groupA.rows[0].id],
    );

    const memberships = await owner.query(
      `insert into memberships (tenant_id, user_id, department_id, title, access_level, status) values
         ($1, $2, $3, '顾问', 'L3', 'active'),
         ($1, $4, $3, '经理', 'L2', 'active'),
         ($1, $5, $6, '小队顾问', 'L3', 'active'),
         ($1, $7, $8, '顾问', 'L3', 'active'),
         ($1, $9, $10, '创始人', 'L1', 'active')
       returning id, user_id`,
      [
        TENANT,
        uid["a1@ai.test"],
        groupA.rows[0].id,
        uid["a2@ai.test"],
        uid["a3@ai.test"],
        teamA1.rows[0].id,
        uid["b1@ai.test"],
        groupB.rows[0].id,
        uid["boss@ai.test"],
        root.rows[0].id,
      ],
    );
    const membershipOf = (email) => memberships.rows.find((row) => row.user_id === uid[email]).id;

    // 无任何授权的 active 项：用来证明 L1 也不能「看全部」
    await owner.query(
      `insert into ai_employees (tenant_id, slug, name, description, status)
       values ($1, 'orphan-agent', '无授权助手', '任何部门都没有被授权', 'active')`,
      [TENANT],
    );

    await owner.query("commit");
    return {
      uid,
      membershipOf,
      departments: {
        root: root.rows[0].id,
        groupA: groupA.rows[0].id,
        groupB: groupB.rows[0].id,
        teamA1: teamA1.rows[0].id,
      },
    };
  });
}

function buildContext(actor, departmentName) {
  return {
    userId: actor.userId,
    tenantId: TENANT,
    activeMembership: null,
    activeMemberships: [],
    activeMembershipId: actor.membershipId,
    activeDepartmentId: actor.departmentIds[0] ?? null,
    activeDepartmentName: departmentName,
    membershipDepartmentIds: actor.departmentIds,
    departmentIds: actor.departmentIds,
    subtreeDepartmentIds: actor.departmentIds,
    accessLevel: actor.level,
    permissionVersion: 0,
    requestId: "ai-employee-test",
  };
}

async function main() {
  if (!DB || !process.env.JXF_OWNER_USER || !process.env.JXF_APP_USER) {
    throw new Error("缺少数据库环境变量，请用 npm run test:ai-employees 执行");
  }

  // 服务层通过 getPool 连接，需要与容器内一致的派生变量
  process.env.APP_DATABASE_URL = process.env.APP_DATABASE_URL ?? APP_URL;
  process.env.S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
  process.env.S3_BUCKET = process.env.S3_BUCKET ?? process.env.MINIO_BUCKET ?? "jxf-assets";
  process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY ?? process.env.MINIO_ROOT_USER ?? "jxf";
  process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY ?? process.env.MINIO_ROOT_PASSWORD ?? "jxf";

  const fx = await seed();

  const boss = await resolveActor(fx.uid["boss@ai.test"], fx.membershipOf("boss@ai.test"));
  const memberA = await resolveActor(fx.uid["a1@ai.test"], fx.membershipOf("a1@ai.test"));
  const leadA = await resolveActor(fx.uid["a2@ai.test"], fx.membershipOf("a2@ai.test"));
  const teamA3 = await resolveActor(fx.uid["a3@ai.test"], fx.membershipOf("a3@ai.test"));
  const memberB = await resolveActor(fx.uid["b1@ai.test"], fx.membershipOf("b1@ai.test"));

  const bossContext = buildContext(boss, "AI 总部");
  const memberAContext = buildContext(memberA, "AI 一组");
  const leadAContext = buildContext(leadA, "AI 一组");
  const teamA3Context = buildContext(teamA3, "AI 华东小队");
  const memberBContext = buildContext(memberB, "AI 二组");

  const visibleIds = async (actor) =>
    runAs(actor, (client) => client.query("select id, name from ai_employees")).then((result) =>
      result.rows.map((row) => row.id),
    );

  // 1. 未授权 active 项：任何人都 0 行（含 L1）
  const orphan = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select id from ai_employees where tenant_id = $1 and slug = 'orphan-agent'",
      [TENANT],
    );
    return rows[0].id;
  });
  check("Fail-Closed：L1 也看不到未授权的 active 员工", !(await visibleIds(boss)).includes(orphan));
  check("Fail-Closed：普通成员看不到未授权员工", (await visibleIds(memberA)).length === 0);

  // 2. 服务层写权限：仅 L1
  let nonL1CreateBlocked = false;
  try {
    await createAiEmployee(memberAContext, { slug: "illegal", name: "越权创建" });
  } catch (error) {
    nonL1CreateBlocked = error instanceof PermissionDeniedError;
  }
  check("写权限：L3 调用服务层创建被拒绝", nonL1CreateBlocked);

  const directInsert = await expectError(
    () =>
      runAs(memberA, (client) =>
        client.query(
          `insert into ai_employees (tenant_id, slug, name, status, created_by)
           values ($1, 'direct-insert', '直插越权', 'draft', $2)`,
          [TENANT, memberA.userId],
        ),
      ),
    "42501",
  );
  check("写权限：绕过服务层直插被 RLS 拒绝", directInsert.ok, String(directInsert.error));

  // 3. 新建：draft + 创建者个人 manage 授权
  const created = await createAiEmployee(bossContext, {
    slug: "kb-assistant",
    name: "知识库助手",
    description: "回答知识库相关问题的 AI 员工",
  });
  const createdGrants = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select user_id, capability from ai_employee_grants where ai_employee_id = $1",
      [created.id],
    );
    return rows;
  });
  check(
    "新建：自动写入创建者 manage 授权",
    createdGrants.length === 1 &&
      createdGrants[0].user_id === boss.userId &&
      createdGrants[0].capability === "manage",
    JSON.stringify(createdGrants),
  );
  const createdStatus = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query("select status from ai_employees where id = $1", [created.id]);
    return rows[0]?.status;
  });
  check("新建：默认草稿态", createdStatus === "draft", createdStatus);

  // 4. 草稿语义：创建者与 L1 可见，其他人（含 L2）不可见
  check("草稿：创建者本人可见", (await visibleIds(boss)).includes(created.id));
  check("草稿：普通成员不可见", !(await visibleIds(memberA)).includes(created.id));
  check("草稿：L2 也不可见", !(await visibleIds(leadA)).includes(created.id));

  // 5. 上线后仍未授权：只有创建者（creator grant）可见
  await setAiEmployeeStatus(bossContext, created.id, "active");
  check("上线未授权：创建者仍可见", (await visibleIds(boss)).includes(created.id));
  check("上线未授权：普通成员不可见", !(await visibleIds(memberA)).includes(created.id));

  // 6. 部门授权：父部门覆盖子树
  await grantAiEmployeeToDepartment(bossContext, created.id, fx.departments.groupA);
  check("部门授权：本部门成员可见", (await visibleIds(memberA)).includes(created.id));
  check("部门授权：子部门成员可见", (await visibleIds(teamA3)).includes(created.id));
  check("部门授权：兄弟部门不可见", !(await visibleIds(memberB)).includes(created.id));

  // 7. 授权表不泄露；L1 管理视图可见完整授权
  const grantsAsMemberA = await runAs(memberA, (client) =>
    client.query("select id from ai_employee_grants where ai_employee_id = $1", [created.id]),
  );
  const grantsAsMemberB = await runAs(memberB, (client) =>
    client.query("select id from ai_employee_grants where ai_employee_id = $1", [created.id]),
  );
  const grantsAsBoss = await runAs(boss, (client) =>
    client.query("select id from ai_employee_grants where ai_employee_id = $1", [created.id]),
  );
  check("授权表：被授权部门只看到与自己相关的行", grantsAsMemberA.rowCount === 1, `rows=${grantsAsMemberA.rowCount}`);
  check("授权表：无关部门 0 行", grantsAsMemberB.rowCount === 0, `rows=${grantsAsMemberB.rowCount}`);
  check("授权表：L1 可见完整授权（创建者 + 部门）", grantsAsBoss.rowCount === 2, `rows=${grantsAsBoss.rowCount}`);

  // 8. 个人授权作为例外，撤回后立即失效
  await grantAiEmployeeToUser(bossContext, created.id, memberB.userId);
  check("个人授权：例外成员可见", (await visibleIds(memberB)).includes(created.id));

  const departmentGrant = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select id from ai_employee_grants where ai_employee_id = $1 and department_id = $2",
      [created.id, fx.departments.groupA],
    );
    return rows[0]?.id;
  });
  await revokeAiEmployeeGrant(bossContext, departmentGrant);
  check("撤回部门授权：本部门立即不可见", !(await visibleIds(memberA)).includes(created.id));
  check("撤回部门授权：子部门立即不可见", !(await visibleIds(teamA3)).includes(created.id));
  check("撤回部门授权：个人例外不受影响", (await visibleIds(memberB)).includes(created.id));

  const userGrant = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select id from ai_employee_grants where ai_employee_id = $1 and user_id = $2",
      [created.id, memberB.userId],
    );
    return rows[0]?.id;
  });
  await revokeAiEmployeeGrant(bossContext, userGrant);
  check("撤回个人授权：立即不可见", !(await visibleIds(memberB)).includes(created.id));

  // 9. 创建者 manage 授权不可移除
  const creatorGrant = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select id from ai_employee_grants where ai_employee_id = $1 and user_id = $2",
      [created.id, boss.userId],
    );
    return rows[0]?.id;
  });
  check("创建者授权：存在且指向创建者", Boolean(creatorGrant), String(creatorGrant));

  let creatorGrantProtected = false;
  if (creatorGrant) {
    try {
      await revokeAiEmployeeGrant(bossContext, creatorGrant);
    } catch {
      creatorGrantProtected = true;
    }
  }
  check("创建者授权：manage 不可移除", creatorGrantProtected);

  // 10. 停用仍按授权可见（状态不等于可见性）
  await grantAiEmployeeToDepartment(bossContext, created.id, fx.departments.groupA);
  await setAiEmployeeStatus(bossContext, created.id, "disabled");
  const disabledVisible = await loadAiEmployee(memberAContext, created.id);
  check("停用：授权成员仍可见且状态为 disabled", disabledVisible?.status === "disabled", JSON.stringify(disabledVisible));

  // 11. 离职/调岗：下一次请求立即不可见
  await withClient(OWNER_URL, (owner) =>
    owner.query(
      "update memberships set status = 'removed', removed_at = now() where id = $1",
      [teamA3.membershipId],
    ),
  );
  const teamA3AfterLeave = await resolveActor(fx.uid["a3@ai.test"], teamA3.membershipId);
  check(
    "离职：重新解析身份后部门范围为空",
    teamA3AfterLeave.departmentIds.length === 0 && teamA3AfterLeave.level === null,
    JSON.stringify(teamA3AfterLeave),
  );
  check("离职：下一次请求读不到 AI 员工", (await visibleIds(teamA3AfterLeave)).length === 0);

  // 12. 授权候选与审计
  const candidates = await listAiEmployeeGrantCandidates(bossContext);
  check(
    "授权候选：返回部门与在职成员（离职者已排除）",
    candidates.departments.length >= 4 && candidates.users.length === 4,
    JSON.stringify({ departments: candidates.departments.length, users: candidates.users.length }),
  );

  const audits = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select action from audit_events where tenant_id = $1 and action like 'ai_employee.%'",
      [TENANT],
    );
    return rows.map((row) => row.action);
  });
  check(
    "审计：创建/上线/授权/撤回/停用均落库",
    ["ai_employee.created", "ai_employee.status_changed", "ai_employee.grant_added", "ai_employee.grant_removed"].every(
      (action) => audits.includes(action),
    ),
    JSON.stringify(audits),
  );

  // 13. 列表只返回可见项（含草稿隔离）
  const memberAList = await listAiEmployees(memberAContext);
  check(
    "列表：普通成员只看到被授权项",
    memberAList.every((item) => item.id === created.id),
    JSON.stringify(memberAList.map((item) => item.name)),
  );

  await withClient(OWNER_URL, cleanup);

  console.log(`\n[AI-EMPLOYEES] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(JSON.stringify({ level: "error", msg: "ai_employee_test_failed", error: String(error) }));
  process.exit(1);
});
