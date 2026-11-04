/**
 * P3 单部门上下文验收：多任用用户在不同部门上下文下的 RLS 作用域。
 *
 * 运行：npm run test:context
 */
import { Client } from "pg";

const TENANT = process.env.CTX_TEST_TENANT ?? "22222222-2222-4222-8222-222222222222";
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
    return;
  }
  failed += 1;
  console.error(`[FAIL] ${name}${detail ? ` :: ${detail}` : ""}`);
}

async function withClient(url, fn) {
  const client = new Client({ connectionString: url, application_name: "jxf-context-test" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function runAs(user, fn) {
  return withClient(APP_URL, async (client) => {
    const departmentIds = user.departmentIds ?? [user.departmentId];
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
        user.userId,
        TENANT,
        user.level,
        `{${departmentIds.join(",")}}`,
        user.departmentId,
        user.membershipId,
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

async function cleanup(owner) {
  await owner.query("delete from audit_events where tenant_id = $1", [TENANT]);
  await owner.query(
    "delete from department_packs where department_id in (select id from departments where tenant_id = $1)",
    [TENANT],
  );
  await owner.query("delete from memberships where tenant_id = $1", [TENANT]);
  for (const depth of [3, 2, 1, 0]) {
    await owner.query(
      `delete from departments
        where tenant_id = $1
          and id in (select descendant_id from department_closure where depth = $2)`,
      [TENANT, depth],
    );
  }
  await owner.query("delete from departments where tenant_id = $1", [TENANT]);
  await owner.query("delete from users where email like '%@ctx.test'");
}

async function main() {
  if (!DB || !process.env.JXF_OWNER_USER || !process.env.JXF_APP_USER) {
    throw new Error("缺少数据库环境变量，请用 npm run test:context 执行");
  }

  const fixtures = await withClient(OWNER_URL, async (owner) => {
    await owner.query("begin");
    await cleanup(owner);

    const users = await owner.query(
      `insert into users (email, name) values ($1, '多任用用户'), ($2, '其他用户')
       returning id, email`,
      ["multi@ctx.test", "other@ctx.test"],
    );
    const multiId = users.rows.find((row) => row.email === "multi@ctx.test").id;
    const otherId = users.rows.find((row) => row.email === "other@ctx.test").id;

    const root = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, null, 'ctx-root', 'CTX 总部') returning id`,
      [TENANT],
    );
    const deptA = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'ctx-a', 'CTX A 部') returning id`,
      [TENANT, root.rows[0].id],
    );
    const deptAChild = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'ctx-a-child', 'CTX A 子部') returning id`,
      [TENANT, deptA.rows[0].id],
    );
    const deptB = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'ctx-b', 'CTX B 部') returning id`,
      [TENANT, root.rows[0].id],
    );
    const deptBChild = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'ctx-b-child', 'CTX B 子部') returning id`,
      [TENANT, deptB.rows[0].id],
    );

    const memberships = await owner.query(
      `insert into memberships (tenant_id, user_id, department_id, title, access_level)
       values ($1, $2, $3, 'A 部成员', 'L3'),
              ($1, $2, $4, 'B 部管理者', 'L2')
       returning id, department_id, access_level`,
      [TENANT, multiId, deptA.rows[0].id, deptB.rows[0].id],
    );

    await owner.query(
      `insert into department_packs (department_id, skill_ids, pipeline_ids)
       values ($1, '{}', '{}'), ($2, '{}', '{}')`,
      [deptA.rows[0].id, deptB.rows[0].id],
    );

    await owner.query(
      `insert into audit_events (tenant_id, actor_user_id, department_id, action)
       values ($1, $2, $3, 'ctx.a'), ($1, $2, $4, 'ctx.b')`,
      [TENANT, otherId, deptA.rows[0].id, deptB.rows[0].id],
    );

    await owner.query("commit");

    const membershipA = memberships.rows.find((row) => row.department_id === deptA.rows[0].id);
    const membershipB = memberships.rows.find((row) => row.department_id === deptB.rows[0].id);

    return {
      multiId,
      otherId,
      deptAId: deptA.rows[0].id,
      deptAChildId: deptAChild.rows[0].id,
      deptBId: deptB.rows[0].id,
      deptBChildId: deptBChild.rows[0].id,
      membershipAId: membershipA.id,
      membershipBId: membershipB.id,
    };
  });

  // 1. 有效任用与登录
  const active = await withClient(APP_URL, async (client) =>
    client.query("select * from app.user_active_memberships($1)", [fixtures.multiId]),
  );
  check("多任用用户返回 2 条任用", active.rowCount === 2, `rowCount=${active.rowCount}`);

  const canLogin = await withClient(APP_URL, async (client) =>
    client.query("select app.user_can_login($1) as ok", [fixtures.multiId]),
  );
  check("有效任用账号允许登录", canLogin.rows[0]?.ok === true);

  // 2. 子树
  const subtree = await withClient(APP_URL, async (client) =>
    client.query("select app.department_subtree_ids($1) as ids", [fixtures.deptBId]),
  );
  const subtreeIds = subtree.rows[0]?.ids ?? [];
  check(
    "B 部门子树包含 B 与 B 子部",
    subtreeIds.includes(fixtures.deptBId) && subtreeIds.includes(fixtures.deptBChildId),
    JSON.stringify(subtreeIds),
  );
  check("B 部门子树不包含 A 部", !subtreeIds.includes(fixtures.deptAId));

  const tenantDepts = await withClient(APP_URL, async (client) =>
    client.query("select app.tenant_department_ids($1) as ids", [TENANT]),
  );
  const tenantDeptIds = tenantDepts.rows[0]?.ids ?? [];
  check("全租户部门包含 5 个部门", tenantDeptIds.length === 5);

  // 3. B 上下文（L2）：读作用域
  const userB = {
    userId: fixtures.multiId,
    level: "L2",
    departmentId: fixtures.deptBId,
    membershipId: fixtures.membershipBId,
  };

  const readA = await runAs(userB, (client) =>
    client.query("select id from departments where id = $1", [fixtures.deptAId]),
  );
  check("B 上下文读 A 部返回 0 行", readA.rowCount === 0);

  const readB = await runAs(userB, (client) =>
    client.query("select id from departments where id = $1", [fixtures.deptBId]),
  );
  check("B 上下文读 B 部返回 1 行", readB.rowCount === 1);

  const readBChild = await runAs(userB, (client) =>
    client.query("select id from departments where id = $1", [fixtures.deptBChildId]),
  );
  check("B 上下文读 B 子部返回 1 行", readBChild.rowCount === 1);

  // 4. 审计作用域
  const audit = await runAs(userB, (client) =>
    client.query("select action from audit_events order by action"),
  );
  check(
    "B 上下文只看到 B 部审计",
    audit.rowCount === 1 && audit.rows[0]?.action === "ctx.b",
    JSON.stringify(audit.rows),
  );

  // 5. 写作用域：department_packs（P4 起写入收紧为 L1）
  const writeB = await runAs(userB, (client) =>
    client.query("update department_packs set updated_by = null where department_id = $1", [
      fixtures.deptBId,
    ]),
  );
  check("L2 上下文不能写能力包（仅 L1）", writeB.rowCount === 0);

  const writeA = await runAs(userB, (client) =>
    client.query("update department_packs set updated_by = null where department_id = $1", [
      fixtures.deptAId,
    ]),
  );
  check("L2 上下文不能写其他部门能力包", writeA.rowCount === 0);

  const userL1 = {
    userId: fixtures.multiId,
    level: "L1",
    departmentId: fixtures.deptBId,
    membershipId: fixtures.membershipBId,
    departmentIds: tenantDeptIds,
  };
  const writeAsL1 = await runAs(userL1, (client) =>
    client.query("update department_packs set updated_by = null where department_id = $1", [
      fixtures.deptBId,
    ]),
  );
  check("L1 上下文可写 B 部能力包", writeAsL1.rowCount === 1);

  // 6. SET LOCAL 上下文值
  const currentDept = await runAs(userB, (client) =>
    client.query("select app.current_active_department_id() as id"),
  );
  check("current_active_department_id 为 B 部", currentDept.rows[0]?.id === fixtures.deptBId);

  // 7. A 上下文（L3）：读作用域
  const userA = {
    userId: fixtures.multiId,
    level: "L3",
    departmentId: fixtures.deptAId,
    membershipId: fixtures.membershipAId,
  };
  const readBFromA = await runAs(userA, (client) =>
    client.query("select id from departments where id = $1", [fixtures.deptBId]),
  );
  check("A 上下文读 B 部返回 0 行", readBFromA.rowCount === 0);

  const readAChildFromA = await runAs(userA, (client) =>
    client.query("select id from departments where id = $1", [fixtures.deptAChildId]),
  );
  check("A 上下文读 A 子部返回 1 行", readAChildFromA.rowCount === 1);

  // 8. 账号冻结：user_can_login 必须为 false
  await withClient(OWNER_URL, (owner) =>
    owner.query("update users set status = 'pending_handover' where id = $1", [fixtures.multiId]),
  );
  const frozen = await withClient(APP_URL, async (client) =>
    client.query("select app.user_can_login($1) as ok", [fixtures.multiId]),
  );
  check("Pending Handover 账号拒绝登录", frozen.rows[0]?.ok === false);
  await withClient(OWNER_URL, (owner) =>
    owner.query("update users set status = 'active' where id = $1", [fixtures.multiId]),
  );

  // 9. 清理
  if (process.env.KEEP_CTX_FIXTURES !== "1") {
    await withClient(OWNER_URL, cleanup);
  }

  console.log(`\n[context] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "error", msg: "context_test_failed", error: String(error) }));
  process.exit(1);
});
