/**
 * P1 越权验收（§5.1 十条的可执行版本）——部门模型。
 * 使用真实 PostgreSQL + jxf_app 角色，逐条验证 RLS 在「无身份 / 越权 / 离岗」时 fail-closed。
 *
 * 运行：npm run test:rls
 */
import { randomUUID } from "node:crypto";

import { Client } from "pg";

const TENANT = process.env.RLS_TEST_TENANT ?? "11111111-1111-4111-8111-111111111111";
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
  const client = new Client({ connectionString: url, application_name: "jxf-rls-test" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function runAs(user, fn) {
  return withClient(APP_URL, async (client) => {
    await client.query("begin");
    await client.query(
      `select
         set_config('app.user_id', $1, true),
         set_config('app.tenant_id', $2, true),
         set_config('app.access_level', $3, true),
         set_config('app.department_ids', $4, true)`,
      [user.userId, TENANT, user.level ?? "", `{${user.departmentIds.join(",")}}`],
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

async function resolveDepartments(userId) {
  return withClient(APP_URL, async (client) => {
    const { rows } = await client.query(
      "select app.user_department_ids($1) as department_ids, app.effective_access_level($1) as level",
      [userId],
    );
    return {
      userId,
      departmentIds: rows[0]?.department_ids ?? [],
      level: rows[0]?.level ?? null,
    };
  });
}

async function expectError(fn, code) {
  try {
    await fn();
    return { ok: false, error: null };
  } catch (error) {
    return { ok: error.code === code, error };
  }
}

async function cleanup(owner) {
  await owner.query("delete from audit_events where tenant_id = $1", [TENANT]);
  await owner.query("delete from department_packs where department_id in (select id from departments where tenant_id = $1)", [TENANT]);
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
  await owner.query("delete from users where email like '%@rls.test'");
}

async function main() {
  if (!DB || !process.env.JXF_OWNER_USER || !process.env.JXF_APP_USER) {
    throw new Error("缺少数据库环境变量，请用 npm run test:rls 执行");
  }

  const fixtures = await withClient(OWNER_URL, async (owner) => {
    await owner.query("begin");
    await cleanup(owner);

    const userRows = await owner.query(
      `insert into users (email, name) values
         ('u1@rls.test', '王五'),
         ('u2@rls.test', '赵六'),
         ('u3@rls.test', '李四'),
         ('u4@rls.test', '已离岗'),
         ('u5@rls.test', '张三')
       returning id, email`,
    );
    const userIds = Object.fromEntries(userRows.rows.map((row) => [row.email, row.id]));

    const root = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, null, 'rls-root', 'RLS 总部') returning id`,
      [TENANT],
    );
    const childA = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'rls-child-a', 'RLS 一组') returning id`,
      [TENANT, root.rows[0].id],
    );
    const childB = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'rls-child-b', 'RLS 二组') returning id`,
      [TENANT, root.rows[0].id],
    );
    const grandA = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'rls-grand-a', 'RLS 华东小组') returning id`,
      [TENANT, childA.rows[0].id],
    );

    const memberships = await owner.query(
      `insert into memberships (tenant_id, user_id, department_id, title, access_level, status, removed_at) values
         ($1, $2, $3, '交付顾问', 'L3', 'active', null),
         ($1, $4, $5, '解决方案工程师', 'L3', 'active', null),
         ($1, $6, $3, '交付经理', 'L2', 'active', null),
         ($1, $7, $3, '顾问', 'L3', 'removed', now()),
         ($1, $8, $9, '创始人', 'L1', 'active', null)
       returning id, user_id, department_id, status`,
      [
        TENANT,
        userIds["u1@rls.test"],
        childA.rows[0].id,
        userIds["u2@rls.test"],
        childB.rows[0].id,
        userIds["u3@rls.test"],
        userIds["u4@rls.test"],
        userIds["u5@rls.test"],
        root.rows[0].id,
      ],
    );

    await owner.query(
      "insert into audit_events (tenant_id, actor_user_id, action) values ($1, $2, 'rls.test')",
      [TENANT, userIds["u5@rls.test"]],
    );

    await owner.query("commit");
    return {
      userIds,
      rootId: root.rows[0].id,
      childAId: childA.rows[0].id,
      childBId: childB.rows[0].id,
      grandAId: grandA.rows[0].id,
      membershipOfU1: memberships.rows.find((row) => row.user_id === userIds["u1@rls.test"]).id,
      membershipOfU5: memberships.rows.find((row) => row.user_id === userIds["u5@rls.test"]).id,
    };
  });

  const seatAUser = await resolveDepartments(fixtures.userIds["u1@rls.test"]);
  const seatBUser = await resolveDepartments(fixtures.userIds["u2@rls.test"]);
  const leadUser = await resolveDepartments(fixtures.userIds["u3@rls.test"]);
  const removedUser = await resolveDepartments(fixtures.userIds["u4@rls.test"]);
  const ownerUser = await resolveDepartments(fixtures.userIds["u5@rls.test"]);

  // 1. L3 读兄弟部门 → 0 行
  const sibling = await runAs(seatAUser, (client) =>
    client.query("select id from departments where id = $1", [fixtures.childBId]),
  );
  check("L3 读兄弟部门", sibling.rowCount === 0, `rowCount=${sibling.rowCount}`);

  // 2. L2 读自身与下级小组 → 2 行
  const descendants = await runAs(leadUser, (client) =>
    client.query("select id from departments where id = any($1::uuid[])", [
      [fixtures.childAId, fixtures.grandAId],
    ]),
  );
  check("L2 读自身部门与下级小组", descendants.rowCount === 2, `rowCount=${descendants.rowCount}`);

  // 3. L3 读父部门 → 0 行
  const parent = await runAs(seatAUser, (client) =>
    client.query("select id from departments where id = $1", [fixtures.rootId]),
  );
  check("L3 读父部门", parent.rowCount === 0, `rowCount=${parent.rowCount}`);

  // 4. 成员可见性：L3 读不到兄弟部门成员
  const foreignMember = await runAs(seatBUser, (client) =>
    client.query("select id from memberships where department_id = $1", [fixtures.childAId]),
  );
  check("L3 读兄弟部门成员", foreignMember.rowCount === 0, `rowCount=${foreignMember.rowCount}`);

  // 5. 已离岗 → department_ids 为空且读 0 行
  check("离岗用户 department_ids 为空", removedUser.departmentIds.length === 0, JSON.stringify(removedUser));
  const removedRead = await runAs(removedUser, (client) => client.query("select id from departments"));
  check("离岗用户读部门", removedRead.rowCount === 0, `rowCount=${removedRead.rowCount}`);

  // 6. L3 读审计 → 0 行；L1 可见
  const l3Audit = await runAs(seatAUser, (client) => client.query("select id from audit_events"));
  check("L3 读 audit_events", l3Audit.rowCount === 0, `rowCount=${l3Audit.rowCount}`);
  const l1Audit = await runAs(ownerUser, (client) => client.query("select id from audit_events"));
  check("L1 读 audit_events", l1Audit.rowCount > 0, `rowCount=${l1Audit.rowCount}`);

  // 7. 显式传他人 department_id（IDOR）→ 0 行
  const idor = await runAs(seatAUser, (client) =>
    client.query("select id from departments where id = any($1::uuid[])", [
      [fixtures.childBId, fixtures.rootId],
    ]),
  );
  check("IDOR 显式传入他人 department_id", idor.rowCount === 0, `rowCount=${idor.rowCount}`);

  // 8. 未注入任何身份 → 0 行
  const anon = await withClient(APP_URL, async (client) => {
    await client.query("begin");
    const result = await client.query("select id from departments where tenant_id = $1", [TENANT]);
    await client.query("commit");
    return result;
  });
  check("未注入身份读取", anon.rowCount === 0, `rowCount=${anon.rowCount}`);

  // 9. L3 越权写入 → RLS 拒绝（42501）
  const deniedWrite = await expectError(
    () =>
      runAs(seatAUser, (client) =>
        client.query(
          `insert into departments (tenant_id, parent_id, slug, name)
           values ($1, $2, 'rls-illegal', 'Illegal')`,
          [TENANT, fixtures.childAId],
        ),
      ),
    "42501",
  );
  check("L3 越权创建部门被拒绝", deniedWrite.ok, deniedWrite.error ? `code=${deniedWrite.error.code}` : "未报错");

  // 10. L1 可在可读子树内创建部门（在 childA 下建小组）
  const createdDepartmentId = randomUUID();
  await runAs(ownerUser, (client) =>
    client.query(
      `insert into departments (id, tenant_id, parent_id, slug, name)
       values ($1, $2, $3, 'rls-l1-created', 'L1 Created')`,
      [createdDepartmentId, TENANT, fixtures.childAId],
    ),
  );
  const createdDepartment = await withClient(OWNER_URL, (client) =>
    client.query("select id from departments where id = $1", [createdDepartmentId]),
  );
  check("L1 在子树内创建部门", createdDepartment.rowCount === 1, `rowCount=${createdDepartment.rowCount}`);

  // 11. 删除最后一个 L1 → 事务回滚
  const lastL1 = await expectError(
    () => runAs(ownerUser, (client) => client.query("select app.remove_membership($1)", [fixtures.membershipOfU5])),
    "23514",
  );
  check("删除最后一个 L1 被拒绝", lastL1.ok, lastL1.error ? `code=${lastL1.error.code}` : "未报错");

  // 12. L1 移除 L3 任用 → 成功，且对方立即失效
  await runAs(ownerUser, (client) =>
    client.query("select app.remove_membership($1)", [fixtures.membershipOfU1]),
  );
  const seatAAfterRemoval = await resolveDepartments(fixtures.userIds["u1@rls.test"]);
  check(
    "移除 L3 后 department_ids 为空",
    seatAAfterRemoval.departmentIds.length === 0,
    JSON.stringify(seatAAfterRemoval),
  );

  // 13. 连接角色本身无特权
  const roleInfo = await withClient(APP_URL, (client) =>
    client.query(
      "select current_user as name, (select rolsuper from pg_roles where rolname = current_user) as is_super, (select rolbypassrls from pg_roles where rolname = current_user) as bypass_rls",
    ),
  );
  const info = roleInfo.rows[0];
  check(
    "应用连接为 jxf_app 且非 superuser / 非 bypassrls",
    info.name === process.env.JXF_APP_USER && info.is_super === false && info.bypass_rls === false,
    JSON.stringify(info),
  );

  if (process.env.KEEP_RLS_FIXTURES !== "1") {
    await withClient(OWNER_URL, cleanup);
  }

  console.log(`\n[RLS] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(JSON.stringify({ level: "error", msg: "rls_test_failed", error: String(error) }));
  process.exit(1);
});
