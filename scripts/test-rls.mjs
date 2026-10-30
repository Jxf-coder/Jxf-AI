/**
 * P1 越权验收（§5.1 十条的可执行版本）。
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
         set_config('app.role_ids', $4, true)`,
      [user.userId, TENANT, user.level ?? "", `{${user.roleIds.join(",")}}`],
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

async function resolveRoles(userId) {
  return withClient(APP_URL, async (client) => {
    const { rows } = await client.query(
      "select app.user_role_ids($1) as role_ids, app.effective_access_level($1) as level",
      [userId],
    );
    return { userId, roleIds: rows[0]?.role_ids ?? [], level: rows[0]?.level ?? null };
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
  await owner.query("delete from role_packs where role_id in (select id from roles where tenant_id = $1)", [TENANT]);
  await owner.query("delete from memberships where tenant_id = $1", [TENANT]);
  await owner.query("delete from roles where tenant_id = $1 and kind = 'seat'", [TENANT]);
  await owner.query("delete from roles where tenant_id = $1 and kind = 'child'", [TENANT]);
  await owner.query("delete from roles where tenant_id = $1", [TENANT]);
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
         ('u1@rls.test', 'Seat A'),
         ('u2@rls.test', 'Seat B'),
         ('u3@rls.test', 'Child Lead'),
         ('u4@rls.test', 'Removed'),
         ('u5@rls.test', 'Root L1')
       returning id, email`,
    );
    const userIds = Object.fromEntries(userRows.rows.map((row) => [row.email, row.id]));

    const root = await owner.query(
      `insert into roles (tenant_id, parent_id, kind, slug, name)
       values ($1, null, 'root', 'rls-root', 'RLS Root') returning id`,
      [TENANT],
    );
    const child = await owner.query(
      `insert into roles (tenant_id, parent_id, kind, slug, name)
       values ($1, $2, 'child', 'rls-child', 'RLS Child') returning id`,
      [TENANT, root.rows[0].id],
    );
    const seatA = await owner.query(
      `insert into roles (tenant_id, parent_id, kind, slug, name)
       values ($1, $2, 'seat', 'rls-seat-a', 'RLS Seat A') returning id`,
      [TENANT, child.rows[0].id],
    );
    const seatB = await owner.query(
      `insert into roles (tenant_id, parent_id, kind, slug, name)
       values ($1, $2, 'seat', 'rls-seat-b', 'RLS Seat B') returning id`,
      [TENANT, child.rows[0].id],
    );

    const memberships = await owner.query(
      `insert into memberships (tenant_id, user_id, role_id, access_level, status, removed_at) values
         ($1, $2, $3, 'L3', 'active', null),
         ($1, $4, $5, 'L3', 'active', null),
         ($1, $6, $7, 'L2', 'active', null),
         ($1, $8, $3, 'L3', 'removed', now()),
         ($1, $9, $10, 'L1', 'active', null)
       returning id, user_id, role_id, status`,
      [
        TENANT,
        userIds["u1@rls.test"],
        seatA.rows[0].id,
        userIds["u2@rls.test"],
        seatB.rows[0].id,
        userIds["u3@rls.test"],
        child.rows[0].id,
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
      childId: child.rows[0].id,
      seatAId: seatA.rows[0].id,
      seatBId: seatB.rows[0].id,
      membershipOfU1: memberships.rows.find((row) => row.user_id === userIds["u1@rls.test"]).id,
      membershipOfU5: memberships.rows.find((row) => row.user_id === userIds["u5@rls.test"]).id,
    };
  });

  const seatAUser = await resolveRoles(fixtures.userIds["u1@rls.test"]);
  const childUser = await resolveRoles(fixtures.userIds["u3@rls.test"]);
  const removedUser = await resolveRoles(fixtures.userIds["u4@rls.test"]);
  const rootUser = await resolveRoles(fixtures.userIds["u5@rls.test"]);

  // 1. seat A 读 seat B → 0 行
  const sibling = await runAs(seatAUser, (client) =>
    client.query("select id from roles where id = $1", [fixtures.seatBId]),
  );
  check("seat A 读 seat B 岗位", sibling.rowCount === 0, `rowCount=${sibling.rowCount}`);

  // 2. child 读自身及下属 seat → 可见
  const descendants = await runAs(childUser, (client) =>
    client.query("select id from roles where id = any($1::uuid[])", [
      [fixtures.seatAId, fixtures.seatBId],
    ]),
  );
  check("child 读下属 seat", descendants.rowCount === 2, `rowCount=${descendants.rowCount}`);

  // 3. seat 读父岗位 → 0 行
  const parent = await runAs(seatAUser, (client) =>
    client.query("select id from roles where id = $1", [fixtures.rootId]),
  );
  check("seat 读父岗位", parent.rowCount === 0, `rowCount=${parent.rowCount}`);

  // 4. 已离岗 → role_ids 为空且读 0 行
  check("离岗用户 role_ids 为空", removedUser.roleIds.length === 0, JSON.stringify(removedUser));
  const removedRead = await runAs(removedUser, (client) => client.query("select id from roles"));
  check("离岗用户读岗位", removedRead.rowCount === 0, `rowCount=${removedRead.rowCount}`);

  // 5. L3 读审计 → 0 行；L1 可见
  const l3Audit = await runAs(seatAUser, (client) =>
    client.query("select id from audit_events"),
  );
  check("L3 读 audit_events", l3Audit.rowCount === 0, `rowCount=${l3Audit.rowCount}`);
  const l1Audit = await runAs(rootUser, (client) => client.query("select id from audit_events"));
  check("L1 读 audit_events", l1Audit.rowCount > 0, `rowCount=${l1Audit.rowCount}`);

  // 6. 显式传他人 role_id（IDOR）→ 0 行
  const idor = await runAs(seatAUser, (client) =>
    client.query("select id from roles where id = any($1::uuid[])", [
      [fixtures.seatBId, fixtures.rootId],
    ]),
  );
  check("IDOR 显式传入他人 role_id", idor.rowCount === 0, `rowCount=${idor.rowCount}`);

  // 7. 未注入 app.user_id → 0 行
  const anon = await withClient(APP_URL, async (client) => {
    await client.query("begin");
    const result = await client.query("select id from roles where tenant_id = $1", [TENANT]);
    await client.query("commit");
    return result;
  });
  check("未注入身份读取", anon.rowCount === 0, `rowCount=${anon.rowCount}`);

  // 8. 越权写入 → RLS 拒绝（42501）
  const deniedWrite = await expectError(
    () =>
      runAs(seatAUser, (client) =>
        client.query(
          `insert into roles (tenant_id, parent_id, kind, slug, name)
           values ($1, $2, 'seat', 'rls-illegal', 'Illegal')`,
          [TENANT, fixtures.childId],
        ),
      ),
    "42501",
  );
  check("seat 越权创建岗位被拒绝", deniedWrite.ok, deniedWrite.error ? `code=${deniedWrite.error.code}` : "未报错");

  // 9. L1 可在可读子树内创建岗位（root L1 在 child 下建 seat）
  const createdRoleId = randomUUID();
  await runAs(rootUser, (client) =>
    client.query(
      `insert into roles (id, tenant_id, parent_id, kind, slug, name)
       values ($1, $2, $3, 'seat', 'rls-l1-created', 'L1 Created')`,
      [createdRoleId, TENANT, fixtures.childId],
    ),
  );
  const createdRole = await withClient(OWNER_URL, (client) =>
    client.query("select id from roles where id = $1", [createdRoleId]),
  );
  check("L1 在子树内创建岗位", createdRole.rowCount === 1, `rowCount=${createdRole.rowCount}`);

  // 10. 删除最后一个 L1 → 事务回滚
  const lastL1 = await expectError(
    () => runAs(rootUser, (client) => client.query("select app.remove_membership($1)", [fixtures.membershipOfU5])),
    "23514",
  );
  check("删除最后一个 L1 被拒绝", lastL1.ok, lastL1.error ? `code=${lastL1.error.code}` : "未报错");

  // 11. L1 移除 L3 任用 → 成功，且对方立即失效
  await runAs(rootUser, (client) =>
    client.query("select app.remove_membership($1)", [fixtures.membershipOfU1]),
  );
  const seatAAfterRemoval = await resolveRoles(fixtures.userIds["u1@rls.test"]);
  check("移除 L3 后 role_ids 为空", seatAAfterRemoval.roleIds.length === 0, JSON.stringify(seatAAfterRemoval));

  // 12. 连接角色本身无特权
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
