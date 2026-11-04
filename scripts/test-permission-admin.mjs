/**
 * P6 权限管理写入函数验收：授权覆盖、版本号、L1 限制、模板回滚。
 *
 * 运行：npm run test:permission-admin-db
 */
import { Client } from "pg";

const TENANT = process.env.JXF_TENANT_ID;
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
  const client = new Client({ connectionString: url, application_name: "jxf-permission-admin-test" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function setContext(client, actor) {
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
      actor.level,
      `{${actor.departmentId}}`,
      actor.departmentId,
      actor.membershipId,
    ],
  );
}

async function runAs(actor, fn) {
  return withClient(APP_URL, async (client) => {
    await client.query("begin");
    await setContext(client, actor);
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

async function runAsRollback(actor, fn) {
  return withClient(APP_URL, async (client) => {
    await client.query("begin");
    await setContext(client, actor);
    try {
      return await fn(client);
    } finally {
      await client.query("rollback").catch(() => {});
    }
  });
}

async function cleanup(owner, userId) {
  if (!userId) {
    return;
  }
  await owner.query("delete from user_permission_grants where user_id = $1", [userId]);
  await owner.query("delete from permission_revisions where user_id = $1", [userId]);
  await owner.query("delete from memberships where user_id = $1", [userId]);
  await owner.query("delete from users where id = $1", [userId]);
}

async function main() {
  if (!TENANT || !DB || !process.env.JXF_OWNER_USER || !process.env.JXF_APP_USER) {
    throw new Error("缺少数据库环境变量，请用 npm run test:permission-admin-db 执行");
  }

  const fixtures = await withClient(OWNER_URL, async (owner) => {
    const l1 = await owner.query(
      `select m.user_id, m.id as membership_id, m.department_id
         from memberships m
        where m.tenant_id = $1 and m.status = 'active' and m.access_level = 'L1'
        order by m.created_at
        limit 1`,
      [TENANT],
    );
    if (l1.rows.length === 0) {
      throw new Error("需要至少一位有效 L1 来执行权限管理测试");
    }

    const existing = await owner.query(
      "select id from users where email = 'p6-admin@local.test'",
    );
    if (existing.rows[0]) {
      await cleanup(owner, existing.rows[0].id);
    }

    const user = await owner.query(
      `insert into users (name, email)
       values ('P6 授权测试', 'p6-admin@local.test')
       returning id`,
    );
    const userId = user.rows[0].id;

    const membership = await owner.query(
      `insert into memberships (tenant_id, user_id, department_id, title, access_level)
       values ($1, $2, $3, '测试成员', 'L3')
       returning id`,
      [TENANT, userId, l1.rows[0].department_id],
    );

    return {
      userId,
      membershipId: membership.rows[0].id,
      departmentId: l1.rows[0].department_id,
      l1UserId: l1.rows[0].user_id,
      l1MembershipId: l1.rows[0].membership_id,
    };
  });

  const actorL1 = {
    userId: fixtures.l1UserId,
    level: "L1",
    departmentId: fixtures.departmentId,
    membershipId: fixtures.l1MembershipId,
  };
  const actorL2 = {
    userId: fixtures.l1UserId,
    level: "L2",
    departmentId: fixtures.departmentId,
    membershipId: fixtures.membershipId,
  };

  try {
    // 1. 覆盖成员授权
    const first = await runAs(actorL1, async (client) => {
      const saved = await client.query(
        "select app.save_user_permission_grants($1, $2, $3::jsonb) as version",
        [
          fixtures.userId,
          fixtures.departmentId,
          JSON.stringify([
            { permissionKey: "knowledge:read", scope: "DEPT", effect: "allow" },
          ]),
        ],
      );
      return saved.rows[0].version;
    });
    check("首次保存返回版本 1", Number(first) === 1, String(first));

    const rows1 = await withClient(OWNER_URL, (owner) =>
      owner.query(
        `select permission_key, scope_type, scope_id, effect
           from user_permission_grants where user_id = $1`,
        [fixtures.userId],
      ),
    );
    check("首次保存写入 1 条授权", rows1.rowCount === 1);
    check(
      "DEPT 授权带部门 scope_id",
      rows1.rows[0]?.scope_type === "DEPT" && rows1.rows[0]?.scope_id === fixtures.departmentId,
    );

    // 2. 再次保存必须整体替换
    const second = await runAs(actorL1, async (client) => {
      const saved = await client.query(
        "select app.save_user_permission_grants($1, $2, $3::jsonb) as version",
        [
          fixtures.userId,
          fixtures.departmentId,
          JSON.stringify([{ permissionKey: "member:view", scope: "SELF", effect: "allow" }]),
        ],
      );
      return saved.rows[0].version;
    });
    check("再次保存版本递增到 2", Number(second) === 2, String(second));

    const rows2 = await withClient(OWNER_URL, (owner) =>
      owner.query(
        `select permission_key, scope_type, scope_id
           from user_permission_grants where user_id = $1`,
        [fixtures.userId],
      ),
    );
    check("再次保存替换旧授权", rows2.rowCount === 1 && rows2.rows[0]?.permission_key === "member:view");
    check(
      "SELF 授权 scope_id 为空",
      rows2.rows[0]?.scope_type === "SELF" && rows2.rows[0]?.scope_id === null,
    );

    // 3. 清空回到模板
    const cleared = await runAs(actorL1, async (client) => {
      const saved = await client.query(
        "select app.clear_user_permission_grants($1) as version",
        [fixtures.userId],
      );
      return saved.rows[0].version;
    });
    check("清空后版本递增到 3", Number(cleared) === 3, String(cleared));

    const rows3 = await withClient(OWNER_URL, (owner) =>
      owner.query("select 1 from user_permission_grants where user_id = $1", [fixtures.userId]),
    );
    check("清空后无个人授权行", rows3.rowCount === 0);

    // 4. 非 L1 调用必须被拒绝
    let denied = false;
    try {
      await runAs(actorL2, (client) =>
        client.query("select app.save_user_permission_grants($1, $2, '[]'::jsonb)", [
          fixtures.userId,
          fixtures.departmentId,
        ]),
      );
    } catch (error) {
      denied = error.code === "42501" || /permission denied/.test(error.message);
    }
    check("非 L1 调用写入函数被拒绝", denied);

    // 5. 应用角色不能绕过函数直接写授权表
    let directWriteBlocked = false;
    try {
      await runAs(actorL1, (client) =>
        client.query(
          `insert into user_permission_grants
             (tenant_id, user_id, permission_key, scope_type, effect)
           values ($1, $2, 'member:view', 'SELF', 'allow')`,
          [TENANT, fixtures.userId],
        ),
      );
    } catch (error) {
      directWriteBlocked = error.code === "42501";
    }
    check("jxf_app 不能直接写授权表", directWriteBlocked);

    // 6. 模板替换 + 版本推进，事务回滚不影响真实模板
    const templateResult = await runAsRollback(actorL1, async (client) => {
      const saved = await client.query(
        "select app.save_role_template_grants('l3', $1::jsonb) as count",
        [JSON.stringify([{ permissionKey: "knowledge:read", scope: "DEPT", effect: "allow" }])],
      );
      const rows = await client.query(
        "select permission_key from role_template_grants where template_id = 'l3'",
      );
      return { count: Number(saved.rows[0].count), rows: rows.rows };
    });
    check("模板保存返回 1 项", templateResult.count === 1);
    check(
      "模板在事务内被整体替换",
      templateResult.rows.length === 1 && templateResult.rows[0].permission_key === "knowledge:read",
    );

    let l1TemplateRejected = false;
    try {
      await runAsRollback(actorL1, (client) =>
        client.query("select app.save_role_template_grants('l1', '[]'::jsonb)"),
      );
    } catch (error) {
      l1TemplateRejected = error.code === "22023";
    }
    check("L1 模板不可修改", l1TemplateRejected);

    const l3Count = await withClient(OWNER_URL, (owner) =>
      owner.query("select count(*)::int as count from role_template_grants where template_id = 'l3'"),
    );
    check("回滚后 L3 模板恢复原状", l3Count.rows[0].count === 7, String(l3Count.rows[0].count));
  } finally {
    await withClient(OWNER_URL, (owner) => cleanup(owner, fixtures.userId));
  }

  console.log(`\n[permission-admin] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
