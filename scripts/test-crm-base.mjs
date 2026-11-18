﻿/**
 * W1 CRM 基座验收（W1-05 ~ W1-07 的可执行版本）。
 *
 * 用真实 PostgreSQL + jxf_app 角色逐条验证：
 *   - 客户 / 联系人的行级可见性（本人、汇报线、部门子树、跨租户、匿名）
 *   - 写入边界（L3 只能写本部门，L2 读子树但只写本部门，L1 全租户）
 *   - 例外授权（data_scope_grants 的 USERS 例外、resource_shares 的单条共享与到期即失效）
 *   - 编号取号（app.next_trade_code 按月按类型独立递增）
 *
 * 运行：npm run test:crm
 */
import { Client } from "pg";

const TENANT = process.env.CRM_TEST_TENANT ?? "22222222-2222-4222-8222-222222222222";
const OTHER_TENANT = "33333333-3333-4333-8333-333333333333";
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

function ids(rows) {
  return rows.map((row) => row.id).sort();
}

async function withClient(url, fn) {
  const client = new Client({ connectionString: url, application_name: "jxf-crm-test" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** 以指定身份在事务内执行；成功即提交（写操作断言需要），失败回滚 */
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
        actor.tenantId ?? TENANT,
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

async function expectError(fn, code) {
  try {
    await fn();
    return { ok: false, error: null };
  } catch (error) {
    return { ok: error.code === code, error };
  }
}

async function cleanup(owner) {
  for (const tenant of [TENANT, OTHER_TENANT]) {
    await owner.query("delete from crm_claim_requests where tenant_id = $1", [tenant]);
    await owner.query("delete from crm_merges where tenant_id = $1", [tenant]);
    await owner.query("delete from crm_interactions where tenant_id = $1", [tenant]);
    await owner.query("delete from crm_assignments where tenant_id = $1", [tenant]);
    await owner.query("delete from crm_holder_caps where tenant_id = $1", [tenant]);
    await owner.query("delete from crm_pool_policies where tenant_id = $1", [tenant]);
    await owner.query("delete from crm_contacts where tenant_id = $1", [tenant]);
    await owner.query("delete from resource_shares where tenant_id = $1", [tenant]);
    await owner.query("delete from data_scope_grants where tenant_id = $1", [tenant]);
    await owner.query("delete from crm_accounts where tenant_id = $1", [tenant]);
    await owner.query("delete from trade_sequences where tenant_id = $1", [tenant]);
  }
  await owner.query("delete from audit_events where tenant_id = any($1::uuid[])", [[TENANT, OTHER_TENANT]]);
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
  await owner.query("delete from departments where tenant_id = $1", [OTHER_TENANT]);
  await owner.query("delete from users where email like '%@crm.test'");
}

async function main() {
  if (!DB || !process.env.JXF_OWNER_USER || !process.env.JXF_APP_USER) {
    throw new Error("缺少数据库环境变量，请用 npm run test:crm 执行");
  }

  const fixtures = await withClient(OWNER_URL, async (owner) => {
    await owner.query("begin");
    await cleanup(owner);

    const userRows = await owner.query(
      `insert into users (email, name) values
         ('a@crm.test', '销售甲'),
         ('b@crm.test', '销售乙'),
         ('lead@crm.test', '主管丙'),
         ('l1@crm.test', '老板丁')
       returning id, email`,
    );
    const userIds = Object.fromEntries(userRows.rows.map((row) => [row.email, row.id]));

    const root = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, null, 'crm-root', 'CRM 总部') returning id`,
      [TENANT],
    );
    const childA = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'crm-a', 'CRM 一组') returning id`,
      [TENANT, root.rows[0].id],
    );
    const childB = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'crm-b', 'CRM 二组') returning id`,
      [TENANT, root.rows[0].id],
    );
    const grandA = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'crm-a1', 'CRM 一组·华东') returning id`,
      [TENANT, childA.rows[0].id],
    );
    const foreignRoot = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, null, 'crm-foreign', '他租户总部') returning id`,
      [OTHER_TENANT],
    );

    const memberships = await owner.query(
      `insert into memberships (tenant_id, user_id, department_id, title, access_level, status) values
         ($1, $2, $3, '销售', 'L3', 'active'),
         ($1, $4, $5, '销售', 'L3', 'active'),
         ($1, $6, $3, '主管', 'L2', 'active'),
         ($1, $7, $8, '创始人', 'L1', 'active')
       returning id, user_id`,
      [
        TENANT,
        userIds["a@crm.test"],
        childA.rows[0].id,
        userIds["b@crm.test"],
        childB.rows[0].id,
        userIds["lead@crm.test"],
        userIds["l1@crm.test"],
        root.rows[0].id,
      ],
    );
    const membershipOf = (email) =>
      memberships.rows.find((row) => row.user_id === userIds[email])?.id ?? null;

    const accounts = await owner.query(
      `insert into crm_accounts (tenant_id, department_id, code, name, name_norm, owner_user_id) values
         ($1, $2, 'C2026010001', '一组客户', '一组客户', $3),
         ($1, $4, 'C2026010002', '华东客户', '华东客户', null),
         ($1, $5, 'C2026010003', '二组客户', '二组客户', $6),
         ($7, $8, 'C2026010001', '他租户客户', '他租户客户', $3)
       returning id, tenant_id, name`,
      [
        TENANT,
        childA.rows[0].id,
        userIds["a@crm.test"],
        grandA.rows[0].id,
        childB.rows[0].id,
        userIds["b@crm.test"],
        OTHER_TENANT,
        foreignRoot.rows[0].id,
      ],
    );
    const accountId = (name) => accounts.rows.find((row) => row.name === name)?.id ?? null;

    await owner.query(
      `insert into crm_contacts (tenant_id, department_id, account_id, name, email) values
         ($1, $2, $3, '一组联系人', 'own@crm.test'),
         ($1, $4, $5, '华东联系人', 'sub@crm.test'),
         ($1, $6, $7, '二组联系人', 'other@crm.test')`,
      [
        TENANT,
        childA.rows[0].id,
        accountId("一组客户"),
        grandA.rows[0].id,
        accountId("华东客户"),
        childB.rows[0].id,
        accountId("二组客户"),
      ],
    );

    // 公共池夹具：一组部门下的公海客户 / 重点候选 / 已确认重点池
    const poolRows = await owner.query(
      `insert into crm_accounts (tenant_id, department_id, code, name, name_norm, owner_user_id, pool_status, icp_score) values
         ($1, $2, 'C2026010005', '公海客户', '公海客户', null, 'public', 60),
         ($1, $2, 'C2026010006', '重点候选客户', '重点候选客户', null, 'key_pending', 92),
         ($1, $2, 'C2026010007', '重点池客户', '重点池客户', null, 'key', 95)
       returning id, name`,
      [TENANT, childA.rows[0].id],
    );
    const poolAccountId = (name) => poolRows.rows.find((row) => row.name === name)?.id ?? null;

    // 部门策略：私海上限 1，用于验证上限拦截与主管分配豁免
    await owner.query(
      `insert into crm_pool_policies
         (tenant_id, department_id, holder_cap, manager_holder_cap, key_grade_threshold, key_pending_ttl_days, claim_mode)
       values ($1, $2, 1, 500, 80, 7, 'self')`,
      [TENANT, childA.rows[0].id],
    );

    await owner.query("commit");

    return {
      userIds,
      rootId: root.rows[0].id,
      childAId: childA.rows[0].id,
      childBId: childB.rows[0].id,
      grandAId: grandA.rows[0].id,
      accounts: {
        ownA: accountId("一组客户"),
        subA: accountId("华东客户"),
        otherB: accountId("二组客户"),
        foreign: accountId("他租户客户"),
      },
      pool: {
        publicA: poolAccountId("公海客户"),
        keyCandidate: poolAccountId("重点候选客户"),
        keyA: poolAccountId("重点池客户"),
      },
      actors: {
        a: {
          userId: userIds["a@crm.test"],
          level: "L3",
          departmentIds: [childA.rows[0].id],
          membershipId: membershipOf("a@crm.test"),
        },
        b: {
          userId: userIds["b@crm.test"],
          level: "L3",
          departmentIds: [childB.rows[0].id],
          membershipId: membershipOf("b@crm.test"),
        },
        lead: {
          userId: userIds["lead@crm.test"],
          level: "L2",
          departmentIds: [childA.rows[0].id],
          membershipId: membershipOf("lead@crm.test"),
        },
        l1: {
          userId: userIds["l1@crm.test"],
          level: "L1",
          departmentIds: [root.rows[0].id, childA.rows[0].id, childB.rows[0].id, grandA.rows[0].id],
          membershipId: membershipOf("l1@crm.test"),
        },
      },
    };
  });

  const { accounts, actors, pool } = fixtures;

  // ---------------------------------------------------------------------------
  // 1. 客户可见性
  // ---------------------------------------------------------------------------
  const l3Own = await runAs(actors.a, (client) =>
    client.query("select id from crm_accounts where archived_at is null"),
  );
  check(
    "L3 只看本人与同部门客户",
    JSON.stringify(ids(l3Own.rows)) === JSON.stringify([accounts.ownA, pool.publicA].sort()),
    `ids=${JSON.stringify(ids(l3Own.rows))}`,
  );

  const l2Subtree = await runAs(actors.lead, (client) =>
    client.query("select id from crm_accounts where archived_at is null"),
  );
  check(
    "L2 读本部门及下级部门客户",
    JSON.stringify(ids(l2Subtree.rows)) ===
      JSON.stringify([accounts.ownA, accounts.subA, pool.publicA, pool.keyCandidate, pool.keyA].sort()),
    `ids=${JSON.stringify(ids(l2Subtree.rows))}`,
  );

  const l1All = await runAs(actors.l1, (client) =>
    client.query("select id from crm_accounts where archived_at is null"),
  );
  check(
    "L1 读全租户但读不到他租户",
    JSON.stringify(ids(l1All.rows)) ===
      JSON.stringify(
        [accounts.ownA, accounts.subA, accounts.otherB, pool.publicA, pool.keyCandidate, pool.keyA].sort(),
      ),
    `ids=${JSON.stringify(ids(l1All.rows))}`,
  );

  const l3Sibling = await runAs(actors.b, (client) =>
    client.query("select id from crm_accounts where id = $1", [accounts.ownA]),
  );
  check("L3 读兄弟部门客户", l3Sibling.rowCount === 0, `rowCount=${l3Sibling.rowCount}`);

  const anon = await withClient(APP_URL, async (client) => {
    await client.query("begin");
    const result = await client.query("select id from crm_accounts");
    await client.query("rollback");
    return result;
  });
  check("未注入身份读客户", anon.rowCount === 0, `rowCount=${anon.rowCount}`);

  // 建档查重：只看得到本部门的 L3 也能发现其他部门的同名客户，但拿不到对方名称
  const duplicateAcrossDept = await runAs(actors.b, (client) =>
    client.query("select app.crm_account_name_exists($1) as duplicated", ["一组客户"]),
  );
  check(
    "跨部门同名可被查重发现",
    duplicateAcrossDept.rows[0]?.duplicated === true,
    `duplicated=${duplicateAcrossDept.rows[0]?.duplicated}`,
  );

  const duplicateCrossTenant = await runAs(actors.b, (client) =>
    client.query("select app.crm_account_name_exists($1) as duplicated", ["他租户客户"]),
  );
  check(
    "查重不跨租户",
    duplicateCrossTenant.rows[0]?.duplicated === false,
    `duplicated=${duplicateCrossTenant.rows[0]?.duplicated}`,
  );

  // ---------------------------------------------------------------------------
  // 2. 联系人跟随客户可见性
  // ---------------------------------------------------------------------------
  const contactsL3 = await runAs(actors.a, (client) => client.query("select id from crm_contacts"));
  check("L3 只看到可见客户下的联系人", contactsL3.rowCount === 1, `rowCount=${contactsL3.rowCount}`);

  const contactsL2 = await runAs(actors.lead, (client) => client.query("select id from crm_contacts"));
  check("L2 看到子树联系人", contactsL2.rowCount === 2, `rowCount=${contactsL2.rowCount}`);

  const contactWriteForeign = await expectError(
    () =>
      runAs(actors.a, (client) =>
        client.query(
          `insert into crm_contacts (tenant_id, department_id, account_id, name)
           values ($1, $2, $3, '越权联系人')`,
          [TENANT, fixtures.childBId, accounts.otherB],
        ),
      ),
    "42501",
  );
  check(
    "L3 不能给他人客户加联系人",
    contactWriteForeign.ok,
    contactWriteForeign.error ? `code=${contactWriteForeign.error.code}` : "未报错",
  );

  const contactWriteOwn = await runAs(actors.a, (client) =>
    client.query(
      `insert into crm_contacts (tenant_id, department_id, account_id, name)
       values ($1, $2, $3, '本人客户联系人')`,
      [TENANT, fixtures.childAId, accounts.ownA],
    ),
  );
  check("L3 可给本人客户加联系人", contactWriteOwn.rowCount === 1, `rowCount=${contactWriteOwn.rowCount}`);

  // ---------------------------------------------------------------------------
  // 3. 客户写入边界
  // ---------------------------------------------------------------------------
  const updateOwn = await runAs(actors.a, (client) =>
    client.query("update crm_accounts set grade = 'A' where id = $1", [accounts.ownA]),
  );
  check("L3 可改本人客户", updateOwn.rowCount === 1, `rowCount=${updateOwn.rowCount}`);

  const updateForeign = await runAs(actors.a, (client) =>
    client.query("update crm_accounts set grade = 'A' where id = $1", [accounts.otherB]),
  );
  check("L3 不能改他人客户", updateForeign.rowCount === 0, `rowCount=${updateForeign.rowCount}`);

  const deleteForeign = await runAs(actors.a, (client) =>
    client.query("delete from crm_accounts where id = $1", [accounts.otherB]),
  );
  check("L3 不能删他人客户", deleteForeign.rowCount === 0, `rowCount=${deleteForeign.rowCount}`);

  const insertSibling = await expectError(
    () =>
      runAs(actors.a, (client) =>
        client.query(
          `insert into crm_accounts (tenant_id, department_id, code, name, name_norm, owner_user_id)
           values ($1, $2, 'C2026010009', '越权建档', '越权建档', $3)`,
          [TENANT, fixtures.childBId, actors.a.userId],
        ),
      ),
    "42501",
  );
  check(
    "L3 不能在他部门建档",
    insertSibling.ok,
    insertSibling.error ? `code=${insertSibling.error.code}` : "未报错",
  );

  const insertOwn = await runAs(actors.a, (client) =>
    client.query(
      `insert into crm_accounts (tenant_id, department_id, code, name, name_norm, owner_user_id)
       values ($1, $2, 'C2026010010', '本人建档', '本人建档', $3)`,
      [TENANT, fixtures.childAId, actors.a.userId],
    ),
  );
  check("L3 可在本部门建档", insertOwn.rowCount === 1, `rowCount=${insertOwn.rowCount}`);

  const insertByL2Subtree = await expectError(
    () =>
      runAs(actors.lead, (client) =>
        client.query(
          `insert into crm_accounts (tenant_id, department_id, code, name, name_norm)
           values ($1, $2, 'C2026010011', '下级部门建档', '下级部门建档')`,
          [TENANT, fixtures.grandAId],
        ),
      ),
    "42501",
  );
  check(
    "L2 读子树但只能写本部门",
    insertByL2Subtree.ok,
    insertByL2Subtree.error ? `code=${insertByL2Subtree.error.code}` : "未报错",
  );

  // ---------------------------------------------------------------------------
  // 4. 例外授权：按人授权 + 到期即失效
  // ---------------------------------------------------------------------------
  const beforeGrant = await runAs(actors.a, (client) =>
    client.query("select id from crm_accounts where id = $1", [accounts.otherB]),
  );
  check("授权前 L3 读不到他人客户", beforeGrant.rowCount === 0, `rowCount=${beforeGrant.rowCount}`);

  const grantRow = await withClient(OWNER_URL, async (owner) => {
    const inserted = await owner.query(
      `insert into data_scope_grants
         (tenant_id, domain, grantee_user_id, scope_type, scope_refs, capability, granted_by, reason, valid_from, valid_until)
       values ($1, 'crm', $2, 'USERS', $3::uuid[], 'read', $4, '交叉协作',
               now() - interval '2 days', now() + interval '1 hour')
       returning id`,
      [TENANT, actors.a.userId, [actors.b.userId], actors.l1.userId],
    );
    return inserted.rows[0].id;
  });

  const afterGrant = await runAs(actors.a, (client) =>
    client.query("select id from crm_accounts where id = $1", [accounts.otherB]),
  );
  check("按人例外授权后可读", afterGrant.rowCount === 1, `rowCount=${afterGrant.rowCount}`);

  const writeStillDenied = await runAs(actors.a, (client) =>
    client.query("update crm_accounts set grade = 'B' where id = $1", [accounts.otherB]),
  );
  check("只读例外不授予写", writeStillDenied.rowCount === 0, `rowCount=${writeStillDenied.rowCount}`);

  // 到期即失效：把 valid_until 拨到过去，下一次查询立刻读不到（不需要定时任务）
  await withClient(OWNER_URL, (owner) =>
    owner.query("update data_scope_grants set valid_until = now() - interval '1 second' where id = $1", [
      grantRow,
    ]),
  );
  const expiredGrant = await runAs(actors.a, (client) =>
    client.query("select id from crm_accounts where id = $1", [accounts.otherB]),
  );
  check("过期例外授权即刻失效", expiredGrant.rowCount === 0, `rowCount=${expiredGrant.rowCount}`);

  // ---------------------------------------------------------------------------
  // 5. 单条资源共享
  // ---------------------------------------------------------------------------
  await withClient(OWNER_URL, (owner) =>
    owner.query(
      `insert into resource_shares (tenant_id, resource_type, resource_id, grantee_user_id, capability, granted_by)
       values ($1, 'crm_account', $2, $3, 'read', $4)`,
      [TENANT, accounts.otherB, actors.a.userId, actors.l1.userId],
    ),
  );
  const shared = await runAs(actors.a, (client) =>
    client.query("select id from crm_accounts where id = $1", [accounts.otherB]),
  );
  check("单条共享后可读", shared.rowCount === 1, `rowCount=${shared.rowCount}`);

  const shareWriteDenied = await runAs(actors.a, (client) =>
    client.query("update crm_accounts set grade = 'C' where id = $1", [accounts.otherB]),
  );
  check("read 共享不授予写", shareWriteDenied.rowCount === 0, `rowCount=${shareWriteDenied.rowCount}`);

  const shareGrantByNonManager = await expectError(
    () =>
      runAs(actors.a, (client) =>
        client.query(
          `insert into resource_shares (tenant_id, resource_type, resource_id, grantee_user_id, capability, granted_by)
           values ($1, 'crm_account', $2, $3, 'write', $4)`,
          [TENANT, accounts.otherB, actors.b.userId, actors.a.userId],
        ),
      ),
    "42501",
  );
  check(
    "非 manage 持有者不能继续授权",
    shareGrantByNonManager.ok,
    shareGrantByNonManager.error ? `code=${shareGrantByNonManager.error.code}` : "未报错",
  );

  // ---------------------------------------------------------------------------
  // 6. 编号取号
  // ---------------------------------------------------------------------------
  const codes = await runAs(actors.a, async (client) => {
    const first = await client.query("select app.next_trade_code($1, 'customer') as code", [TENANT]);
    const second = await client.query("select app.next_trade_code($1, 'customer') as code", [TENANT]);
    return [first.rows[0]?.code ?? "", second.rows[0]?.code ?? ""];
  });
  const [c1, c2] = codes;
  check("客户编号格式为 C + 年月 + 序号", /^C\d{6}\d{4}$/.test(c1), `code=${c1}`);
  check("同类型按月递增", Number(c2.slice(-4)) === Number(c1.slice(-4)) + 1, `c1=${c1} c2=${c2}`);

  // ---------------------------------------------------------------------------
  // 7. 公共池：重点池可见性、三层上限、领用 / 置公 / 分配 / 候选裁决
  // ---------------------------------------------------------------------------
  // 清掉前面建档用例留下的客户，保证私海计数可控
  await withClient(OWNER_URL, (owner) =>
    owner.query("delete from crm_accounts where tenant_id = $1 and code = 'C2026010010'", [TENANT]),
  );

  const candidateL3 = await runAs(actors.a, (client) =>
    client.query("select id from crm_accounts where id = $1", [pool.keyCandidate]),
  );
  check("L3 看不到重点池候选", candidateL3.rowCount === 0, `rowCount=${candidateL3.rowCount}`);

  const keyL3 = await runAs(actors.a, (client) =>
    client.query("select id from crm_accounts where id = $1", [pool.keyA]),
  );
  check("L3 看不到已确认重点池", keyL3.rowCount === 0, `rowCount=${keyL3.rowCount}`);

  const candidateL2 = await runAs(actors.lead, (client) =>
    client.query("select id from crm_accounts where id = $1", [pool.keyCandidate]),
  );
  check("L2 可见重点池候选", candidateL2.rowCount === 1, `rowCount=${candidateL2.rowCount}`);

  const capBefore = await runAs(actors.a, (client) =>
    client.query("select app.crm_effective_holder_cap($1) as cap, app.crm_held_count($1) as held", [
      actors.a.userId,
    ]),
  );
  check("部门策略上限生效", capBefore.rows[0]?.cap === 1, `cap=${capBefore.rows[0]?.cap}`);
  check("持有数按私海统计", capBefore.rows[0]?.held === 1, `held=${capBefore.rows[0]?.held}`);

  const claimBlocked = await expectError(
    () => runAs(actors.a, (client) => client.query("select app.crm_pool_claim($1)", [pool.publicA])),
    "23514",
  );
  check("达上限不能自助领用", claimBlocked.ok, claimBlocked.error ? `code=${claimBlocked.error.code}` : "未报错");

  await withClient(OWNER_URL, (owner) =>
    owner.query(
      `insert into crm_holder_caps (tenant_id, user_id, holder_cap, reason, updated_by, valid_until)
       values ($1, $2, 5, '资深销售', $3, now() + interval '1 hour')`,
      [TENANT, actors.a.userId, actors.l1.userId],
    ),
  );
  const capOverride = await runAs(actors.a, (client) =>
    client.query("select app.crm_effective_holder_cap($1) as cap", [actors.a.userId]),
  );
  check("员工个体上限覆盖部门策略", capOverride.rows[0]?.cap === 5, `cap=${capOverride.rows[0]?.cap}`);

  await withClient(OWNER_URL, (owner) =>
    owner.query(
      "update crm_holder_caps set valid_from = now() - interval '1 day', valid_until = now() - interval '1 second' where tenant_id = $1 and user_id = $2",
      [TENANT, actors.a.userId],
    ),
  );
  const capExpired = await runAs(actors.a, (client) =>
    client.query("select app.crm_effective_holder_cap($1) as cap", [actors.a.userId]),
  );
  check("个体上限到期回落部门策略", capExpired.rows[0]?.cap === 1, `cap=${capExpired.rows[0]?.cap}`);

  // 领用：放开上限后应成功，并写流转流水与保护期
  await withClient(OWNER_URL, (owner) =>
    owner.query("update crm_pool_policies set holder_cap = 2 where tenant_id = $1 and department_id = $2", [
      TENANT,
      fixtures.childAId,
    ]),
  );
  await runAs(actors.a, (client) => client.query("select app.crm_pool_claim($1)", [pool.publicA]));
  const afterClaim = await withClient(OWNER_URL, (owner) =>
    owner.query(
      `select a.pool_status, a.owner_user_id, a.protection_until,
              (select count(*)::int from crm_assignments g
                where g.account_id = a.id and g.action = 'claim') as claims
         from crm_accounts a where a.id = $1`,
      [pool.publicA],
    ),
  );
  check(
    "领用后客户进入本人私海",
    afterClaim.rows[0]?.pool_status === "private" && afterClaim.rows[0]?.owner_user_id === actors.a.userId,
    JSON.stringify(afterClaim.rows[0]),
  );
  check("领用写流转流水", afterClaim.rows[0]?.claims === 1, `claims=${afterClaim.rows[0]?.claims}`);
  check("领用后重新计保护期", afterClaim.rows[0]?.protection_until !== null);

  // 领用申请：L2 / L3 只能申请，由上级审批后才改归属
  const requestAccounts = await withClient(OWNER_URL, (owner) =>
    owner.query(
      `insert into crm_accounts (tenant_id, department_id, code, name, name_norm, owner_user_id, pool_status, icp_score) values
         ($1, $2, 'C2026010008', '公海申请甲', '公海申请甲', null, 'public', 50),
         ($1, $2, 'C2026010009', '公海申请乙', '公海申请乙', null, 'public', 50),
         ($1, $2, 'C2026010011', '公海申请丙', '公海申请丙', null, 'public', 50)
       returning id, name`,
      [TENANT, fixtures.childAId],
    ),
  );
  const requestAccount = (name) =>
    requestAccounts.rows.find((row) => row.name === name)?.id ?? null;
  const requestA = requestAccount("公海申请甲");
  const requestB = requestAccount("公海申请乙");
  const requestC = requestAccount("公海申请丙");

  await withClient(OWNER_URL, (owner) =>
    owner.query("update crm_pool_policies set holder_cap = 5 where tenant_id = $1 and department_id = $2", [
      TENANT,
      fixtures.childAId,
    ]),
  );

  const requestByL3 = await runAs(actors.a, (client) =>
    client.query("select app.crm_pool_request_claim($1) as id", [requestA]),
  );
  const requestAId = requestByL3.rows[0]?.id;
  check("L3 可提交领用申请", Boolean(requestAId), `id=${requestAId}`);

  const afterRequest = await withClient(OWNER_URL, (owner) =>
    owner.query(
      `select a.pool_status, a.owner_user_id,
              (select status from crm_claim_requests r
                where r.account_id = a.id and r.requester_user_id = $2) as request_status
         from crm_accounts a where a.id = $1`,
      [requestA, actors.a.userId],
    ),
  );
  check(
    "领用申请不改客户归属",
    afterRequest.rows[0]?.pool_status === "public" &&
      afterRequest.rows[0]?.owner_user_id === null &&
      afterRequest.rows[0]?.request_status === "pending",
    JSON.stringify(afterRequest.rows[0]),
  );

  const duplicateRequest = await expectError(
    () =>
      runAs(actors.a, (client) =>
        client.query("select app.crm_pool_request_claim($1)", [requestA]),
      ),
    "23514",
  );
  check(
    "同一客户不能重复提交待审批申请",
    duplicateRequest.ok,
    duplicateRequest.error ? `code=${duplicateRequest.error.code}` : "未报错",
  );

  const requestByL3Again = await runAs(actors.a, (client) =>
    client.query("select app.crm_pool_request_claim($1) as id", [requestC]),
  );
  const requestCId = requestByL3Again.rows[0]?.id;

  const approveByL3 = await expectError(
    () =>
      runAs(actors.a, (client) =>
        client.query("select app.crm_pool_decide_claim($1, true, $2)", [requestAId, "自批"]),
      ),
    "42501",
  );
  check("L3 不能审批领用申请", approveByL3.ok, approveByL3.error ? `code=${approveByL3.error.code}` : "未报错");

  const requestByL2 = await runAs(actors.lead, (client) =>
    client.query("select app.crm_pool_request_claim($1) as id", [requestB]),
  );
  const requestBId = requestByL2.rows[0]?.id;
  check("L2 也可提交领用申请", Boolean(requestBId), `id=${requestBId}`);

  const approveSelf = await expectError(
    () =>
      runAs(actors.lead, (client) =>
        client.query("select app.crm_pool_decide_claim($1, true, $2)", [requestBId, "自批"]),
      ),
    "42501",
  );
  check("不能审批自己的申请", approveSelf.ok, approveSelf.error ? `code=${approveSelf.error.code}` : "未报错");

  const approveL3ByL2 = await runAs(actors.lead, (client) =>
    client.query("select app.crm_pool_decide_claim($1, true, $2)", [requestAId, "同意"]),
  );
  const afterApprove = await withClient(OWNER_URL, (owner) =>
    owner.query(
      `select a.pool_status, a.owner_user_id,
              (select status from crm_claim_requests r where r.id = $2) as request_status,
              (select operated_by from crm_assignments g
                where g.account_id = a.id and g.action = 'claim'
                order by g.created_at desc limit 1) as claim_operator
         from crm_accounts a where a.id = $1`,
      [requestA, requestAId],
    ),
  );
  check(
    "L2 审批 L3 申请后进入申请人私海",
    afterApprove.rows[0]?.pool_status === "private" &&
      afterApprove.rows[0]?.owner_user_id === actors.a.userId &&
      afterApprove.rows[0]?.claim_operator === actors.lead.userId,
    JSON.stringify(afterApprove.rows[0]),
  );
  check(
    "审批通过后申请状态为 approved",
    afterApprove.rows[0]?.request_status === "approved",
    `status=${afterApprove.rows[0]?.request_status}`,
  );

  const requestsSeenByOtherL3 = await runAs(actors.b, (client) =>
    client.query("select count(*)::int as n from crm_claim_requests"),
  );
  check("跨部门 L3 看不到申请", requestsSeenByOtherL3.rows[0]?.n === 0, `n=${requestsSeenByOtherL3.rows[0]?.n}`);

  const approveL2ByL1 = await runAs(actors.l1, (client) =>
    client.query("select app.crm_pool_decide_claim($1, true, $2)", [requestBId, "同意"]),
  );
  const afterApproveL2 = await withClient(OWNER_URL, (owner) =>
    owner.query("select pool_status, owner_user_id from crm_accounts where id = $1", [requestB]),
  );
  check(
    "L1 审批 L2 申请后进入申请人私海",
    afterApproveL2.rows[0]?.owner_user_id === actors.lead.userId &&
      afterApproveL2.rows[0]?.pool_status === "private",
    JSON.stringify(afterApproveL2.rows[0]),
  );

  const rejectByL2 = await runAs(actors.lead, (client) =>
    client.query("select app.crm_pool_decide_claim($1, false, $2)", [requestCId, "暂不分配"]),
  );
  const afterReject = await withClient(OWNER_URL, (owner) =>
    owner.query(
      `select a.pool_status, a.owner_user_id,
              (select status from crm_claim_requests r where r.id = $2) as request_status
         from crm_accounts a where a.id = $1`,
      [requestC, requestCId],
    ),
  );
  check(
    "驳回申请后客户仍在公海",
    afterReject.rows[0]?.pool_status === "public" &&
      afterReject.rows[0]?.owner_user_id === null &&
      afterReject.rows[0]?.request_status === "rejected",
    JSON.stringify(afterReject.rows[0]),
  );

  // 客户离开公海（主管分配 / 直接领用）后，其他待审批申请必须自动失效
  const extraAccounts = await withClient(OWNER_URL, (owner) =>
    owner.query(
      `insert into crm_accounts (tenant_id, department_id, code, name, name_norm, owner_user_id, pool_status, icp_score) values
         ($1, $2, 'C2026010013', '公海申请丁', '公海申请丁', null, 'public', 50),
         ($1, $2, 'C2026010014', '公海申请戊', '公海申请戊', null, 'public', 50)
       returning id, name`,
      [TENANT, fixtures.childAId],
    ),
  );
  const extraAccount = (name) => extraAccounts.rows.find((row) => row.name === name)?.id ?? null;
  const assignCancelAccount = extraAccount("公海申请丁");
  const claimCancelAccount = extraAccount("公海申请戊");

  const assignPending = await runAs(actors.a, (client) =>
    client.query("select app.crm_pool_request_claim($1) as id", [assignCancelAccount]),
  );
  await runAs(actors.l1, (client) =>
    client.query("select app.crm_pool_assign($1, $2, $3)", [
      assignCancelAccount,
      actors.lead.userId,
      "主管直接分配",
    ]),
  );
  const afterAssignCancel = await withClient(OWNER_URL, (owner) =>
    owner.query(
      `select a.pool_status, a.owner_user_id,
              (select status from crm_claim_requests r where r.id = $2) as request_status
         from crm_accounts a where a.id = $1`,
      [assignCancelAccount, assignPending.rows[0]?.id],
    ),
  );
  check(
    "定向分配后同客户待审批申请自动取消",
    afterAssignCancel.rows[0]?.request_status === "cancelled" &&
      afterAssignCancel.rows[0]?.owner_user_id === actors.lead.userId,
    JSON.stringify(afterAssignCancel.rows[0]),
  );

  const claimPending = await runAs(actors.a, (client) =>
    client.query("select app.crm_pool_request_claim($1) as id", [claimCancelAccount]),
  );
  await runAs(actors.l1, (client) =>
    client.query("select app.crm_pool_claim($1)", [claimCancelAccount]),
  );
  const afterClaimCancel = await withClient(OWNER_URL, (owner) =>
    owner.query(
      `select a.pool_status, a.owner_user_id,
              (select status from crm_claim_requests r where r.id = $2) as request_status
         from crm_accounts a where a.id = $1`,
      [claimCancelAccount, claimPending.rows[0]?.id],
    ),
  );
  check(
    "直接领用后同客户待审批申请自动取消",
    afterClaimCancel.rows[0]?.request_status === "cancelled" &&
      afterClaimCancel.rows[0]?.owner_user_id === actors.l1.userId,
    JSON.stringify(afterClaimCancel.rows[0]),
  );

  const releaseNoReason = await expectError(
    () =>
      runAs(actors.a, (client) =>
        client.query("select app.crm_pool_release($1, $2)", [accounts.ownA, "   "]),
      ),
    "22023",
  );
  check(
    "置公必须填写原因",
    releaseNoReason.ok,
    releaseNoReason.error ? `code=${releaseNoReason.error.code}` : "未报错",
  );

  await runAs(actors.a, (client) =>
    client.query("select app.crm_pool_release($1, $2)", [accounts.ownA, "长期无跟进"]),
  );
  const afterRelease = await withClient(OWNER_URL, (owner) =>
    owner.query("select pool_status, owner_user_id, released_reason from crm_accounts where id = $1", [
      accounts.ownA,
    ]),
  );
  check(
    "置公后回到公海并记录原因",
    afterRelease.rows[0]?.pool_status === "public" &&
      afterRelease.rows[0]?.owner_user_id === null &&
      afterRelease.rows[0]?.released_reason === "长期无跟进",
    JSON.stringify(afterRelease.rows[0]),
  );

  const assignByL3 = await expectError(
    () =>
      runAs(actors.a, (client) =>
        client.query("select app.crm_pool_assign($1, $2, $3)", [pool.keyA, actors.a.userId, "自取"]),
      ),
    "42501",
  );
  check("L3 不能定向分配", assignByL3.ok, assignByL3.error ? `code=${assignByL3.error.code}` : "未报错");

  const assignNoReason = await expectError(
    () =>
      runAs(actors.lead, (client) =>
        client.query("select app.crm_pool_assign($1, $2, $3)", [pool.keyA, actors.a.userId, ""]),
      ),
    "22023",
  );
  check(
    "重点池分配必须填写原因",
    assignNoReason.ok,
    assignNoReason.error ? `code=${assignNoReason.error.code}` : "未报错",
  );

  const assignOutOfScope = await expectError(
    () =>
      runAs(actors.lead, (client) =>
        client.query("select app.crm_pool_assign($1, $2, $3)", [pool.keyA, actors.b.userId, "跨组"]),
      ),
    "42501",
  );
  check(
    "不能分配到管辖范围外",
    assignOutOfScope.ok,
    assignOutOfScope.error ? `code=${assignOutOfScope.error.code}` : "未报错",
  );

  // 把上限收紧到 1，验证主管分配不受上限约束但会回传超限
  await withClient(OWNER_URL, (owner) =>
    owner.query("update crm_pool_policies set holder_cap = 1 where tenant_id = $1 and department_id = $2", [
      TENANT,
      fixtures.childAId,
    ]),
  );
  const assigned = await runAs(actors.lead, (client) =>
    client.query("select app.crm_pool_assign($1, $2, $3) as exceeded", [
      pool.keyA,
      actors.a.userId,
      "区域对口",
    ]),
  );
  const afterAssign = await withClient(OWNER_URL, (owner) =>
    owner.query("select pool_status, owner_user_id from crm_accounts where id = $1", [pool.keyA]),
  );
  check(
    "重点池可定向分配给下属",
    afterAssign.rows[0]?.owner_user_id === actors.a.userId && afterAssign.rows[0]?.pool_status === "private",
    JSON.stringify(afterAssign.rows[0]),
  );
  check("分配超上限只提示不拦截", assigned.rows[0]?.exceeded === true, `exceeded=${assigned.rows[0]?.exceeded}`);

  const confirmByL3 = await expectError(
    () =>
      runAs(actors.a, (client) =>
        client.query("select app.crm_pool_confirm_key($1, $2, $3)", [pool.keyCandidate, true, null]),
      ),
    "42501",
  );
  check(
    "L3 不能裁决重点池",
    confirmByL3.ok,
    confirmByL3.error ? `code=${confirmByL3.error.code}` : "未报错",
  );

  await runAs(actors.lead, (client) =>
    client.query("select app.crm_pool_confirm_key($1, $2, $3)", [pool.keyCandidate, true, "价值达标"]),
  );
  const afterConfirm = await withClient(OWNER_URL, (owner) =>
    owner.query("select pool_status from crm_accounts where id = $1", [pool.keyCandidate]),
  );
  check("L2 确认后候选进入重点池", afterConfirm.rows[0]?.pool_status === "key", JSON.stringify(afterConfirm.rows[0]));

  // ---------------------------------------------------------------------------
  // 8. 客户合并：仅 L1/L2、软收编、联系人迁移、旧编码留档
  // ---------------------------------------------------------------------------
  const mergeByL3 = await expectError(
    () =>
      runAs(actors.a, (client) =>
        client.query("select app.crm_merge_accounts($1, $2, $3)", [accounts.ownA, pool.publicA, "重复"]),
      ),
    "42501",
  );
  check("L3 不能合并客户", mergeByL3.ok, mergeByL3.error ? `code=${mergeByL3.error.code}` : "未报错");

  const mergeSelf = await expectError(
    () =>
      runAs(actors.lead, (client) =>
        client.query("select app.crm_merge_accounts($1, $2, $3)", [accounts.ownA, accounts.ownA, ""]),
      ),
    "22023",
  );
  check("不能合并到自己", mergeSelf.ok, mergeSelf.error ? `code=${mergeSelf.error.code}` : "未报错");

  const sourceContactCount = await withClient(OWNER_URL, async (owner) => {
    const result = await owner.query("select count(*)::int as n from crm_contacts where account_id = $1", [
      accounts.ownA,
    ]);
    return result.rows[0]?.n ?? 0;
  });

  const mergeResult = await runAs(actors.lead, (client) =>
    client.query("select app.crm_merge_accounts($1, $2, $3) as result", [
      accounts.ownA,
      pool.publicA,
      "同一集团重复建档",
    ]),
  );
  const merged = mergeResult.rows[0]?.result ?? {};
  check("合并返回旧编码", merged.source_code === "C2026010001", `source=${merged.source_code}`);
  check(
    "合并迁移联系人数",
    merged.contacts === sourceContactCount,
    `contacts=${merged.contacts} expected=${sourceContactCount}`,
  );

  const afterMerge = await withClient(OWNER_URL, async (owner) => {
    const source = await owner.query(
      "select archived_at, merged_into_id from crm_accounts where id = $1",
      [accounts.ownA],
    );
    const contacts = await owner.query(
      "select count(*)::int as n from crm_contacts where account_id = $1",
      [pool.publicA],
    );
    const merges = await owner.query(
      "select source_code, target_code, moved_contacts from crm_merges where source_account_id = $1",
      [accounts.ownA],
    );
    return { source: source.rows[0], contacts: contacts.rows[0]?.n ?? 0, merge: merges.rows[0] };
  });
  check(
    "合并后源客户归档并指向目标",
    afterMerge.source?.archived_at !== null && afterMerge.source?.merged_into_id === pool.publicA,
    JSON.stringify(afterMerge.source),
  );
  check(
    "合并后联系人迁到目标客户",
    afterMerge.contacts === sourceContactCount,
    `contacts=${afterMerge.contacts} expected=${sourceContactCount}`,
  );
  check(
    "合并记录保留前后编码与统计",
    afterMerge.merge?.source_code === "C2026010001" &&
      afterMerge.merge?.target_code === "C2026010005" &&
      afterMerge.merge?.moved_contacts === sourceContactCount,
    JSON.stringify(afterMerge.merge),
  );

  const listAfterMerge = await runAs(actors.lead, (client) =>
    client.query("select id from crm_accounts where id = $1 and archived_at is null", [accounts.ownA]),
  );
  check("合并后源客户不再出现在列表", listAfterMerge.rowCount === 0, `rowCount=${listAfterMerge.rowCount}`);

  const mergeArchived = await expectError(
    () =>
      runAs(actors.lead, (client) =>
        client.query("select app.crm_merge_accounts($1, $2, $3)", [accounts.ownA, pool.publicA, "重复"]),
      ),
    "23514",
  );
  check(
    "已归档客户不能再次合并",
    mergeArchived.ok,
    mergeArchived.error ? `code=${mergeArchived.error.code}` : "未报错",
  );

  // ---------------------------------------------------------------------------
  // 9. 联系记录：可见性跟随客户，写入需能改该客户
  // ---------------------------------------------------------------------------
  const createdInteraction = await runAs(actors.a, (client) =>
    client.query(
      `insert into crm_interactions
         (tenant_id, department_id, account_id, owner_user_id, subject, channel, direction, status, next_follow_at)
       values ($1, $2, $3, $4, '首轮跟进', 'mail', 'out', 'pending', now() + interval '3 days')
       returning id`,
      [TENANT, fixtures.childAId, pool.publicA, actors.a.userId],
    ),
  );
  check("L3 可给本人客户写联系记录", createdInteraction.rowCount === 1, `rowCount=${createdInteraction.rowCount}`);

  const interactionL2 = await runAs(actors.lead, (client) =>
    client.query("select id from crm_interactions where account_id = $1", [pool.publicA]),
  );
  check("L2 可见子树客户联系记录", interactionL2.rowCount === 1, `rowCount=${interactionL2.rowCount}`);

  const interactionL3Sibling = await runAs(actors.b, (client) =>
    client.query("select id from crm_interactions where account_id = $1", [pool.publicA]),
  );
  check("L3 读不到兄弟部门客户记录", interactionL3Sibling.rowCount === 0, `rowCount=${interactionL3Sibling.rowCount}`);

  const writeInteractionForeign = await expectError(
    () =>
      runAs(actors.b, (client) =>
        client.query(
          `insert into crm_interactions (tenant_id, department_id, account_id, subject, channel, direction)
           values ($1, $2, $3, '越权记录', 'note', 'out')`,
          [TENANT, fixtures.childBId, pool.publicA],
        ),
      ),
    "42501",
  );
  check(
    "L3 不能给他人客户写记录",
    writeInteractionForeign.ok,
    writeInteractionForeign.error ? `code=${writeInteractionForeign.error.code}` : "未报错",
  );

  // ---------------------------------------------------------------------------
  // 10. 批量导入：导入复用查重函数，确认写入后自动取号并落在本人私海
  // ---------------------------------------------------------------------------
  const archivedNameFree = await runAs(actors.a, (client) =>
    client.query("select app.crm_account_name_exists($1) as duplicated", ["一组客户"]),
  );
  check(
    "合并归档后同名可再次导入",
    archivedNameFree.rows[0]?.duplicated === false,
    `duplicated=${archivedNameFree.rows[0]?.duplicated}`,
  );

  const importRows = ["导入客户甲", "导入客户乙"];
  const importResult = await runAs(actors.a, async (client) => {
    const codes = [];
    for (const name of importRows) {
      const dup = await client.query("select app.crm_account_name_exists($1) as duplicated", [name]);
      if (dup.rows[0]?.duplicated) {
        throw new Error(`导入查重误判：${name}`);
      }
      const codeRow = await client.query("select app.next_trade_code($1, 'customer') as code", [TENANT]);
      const code = codeRow.rows[0]?.code ?? "";
      await client.query(
        `insert into crm_accounts
           (tenant_id, department_id, code, name, name_norm, owner_user_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $6)`,
        [TENANT, fixtures.childAId, code, name, name, actors.a.userId],
      );
      codes.push(code);
    }
    return codes;
  });
  check(
    "导入行按 C + 年月 + 序号取号",
    importResult.length === 2 && importResult.every((code) => /^C\d{6}\d{4}$/.test(code)),
    JSON.stringify(importResult),
  );
  check(
    "同批次编号不重复",
    new Set(importResult).size === importResult.length,
    JSON.stringify(importResult),
  );

  const importedRows = await runAs(actors.a, (client) =>
    client.query(
      "select name, code, pool_status, owner_user_id, department_id from crm_accounts where name = any($1) order by name",
      [importRows],
    ),
  );
  check(
    "导入客户落在本人私海",
    importedRows.rowCount === 2 &&
      importedRows.rows.every(
        (row) =>
          row.pool_status === "private" &&
          row.owner_user_id === actors.a.userId &&
          row.department_id === fixtures.childAId,
      ),
    JSON.stringify(importedRows.rows),
  );

  const reimportBlocked = await runAs(actors.a, (client) =>
    client.query("select app.crm_account_name_exists($1) as duplicated", [importRows[0]]),
  );
  check(
    "重复导入同一批会被查重拦下",
    reimportBlocked.rows[0]?.duplicated === true,
    `duplicated=${reimportBlocked.rows[0]?.duplicated}`,
  );

  // ---------------------------------------------------------------------------
  // 11. 跨部门分配：客户与联系人部门必须随负责人转移，否则新负责人改不动
  // ---------------------------------------------------------------------------
  const crossId = await withClient(OWNER_URL, async (owner) => {
    const row = await owner.query(
      `insert into crm_accounts (tenant_id, department_id, code, name, name_norm, owner_user_id)
       values ($1, $2, 'C2026010020', '跨部门客户', '跨部门客户', $3)
       returning id`,
      [TENANT, fixtures.childAId, actors.a.userId],
    );
    await owner.query(
      `insert into crm_contacts (tenant_id, department_id, account_id, name)
       values ($1, $2, $3, '跨部门联系人')`,
      [TENANT, fixtures.childAId, row.rows[0].id],
    );
    return row.rows[0].id;
  });

  await runAs(actors.l1, (client) =>
    client.query("select app.crm_pool_assign($1, $2, $3)", [crossId, actors.b.userId, "跨部门支援"]),
  );
  const crossState = await withClient(OWNER_URL, async (owner) => {
    const account = await owner.query(
      "select department_id, owner_user_id from crm_accounts where id = $1",
      [crossId],
    );
    const contact = await owner.query("select department_id from crm_contacts where account_id = $1", [
      crossId,
    ]);
    return { account: account.rows[0], contactDept: contact.rows[0]?.department_id };
  });
  check(
    "跨部门分配后客户部门跟随目标成员",
    crossState.account?.department_id === fixtures.childBId &&
      crossState.account?.owner_user_id === actors.b.userId,
    JSON.stringify(crossState.account),
  );
  check(
    "跨部门分配后联系人部门跟随",
    crossState.contactDept === fixtures.childBId,
    `contactDept=${crossState.contactDept}`,
  );

  const crossWrite = await runAs(actors.b, (client) =>
    client.query("update crm_accounts set grade = 'B' where id = $1", [crossId]),
  );
  check("跨部门分配后新负责人可写", crossWrite.rowCount === 1, `rowCount=${crossWrite.rowCount}`);

  const crossOldOwner = await runAs(actors.a, (client) =>
    client.query("select id from crm_accounts where id = $1", [crossId]),
  );
  check("跨部门分配后原负责人读不到", crossOldOwner.rowCount === 0, `rowCount=${crossOldOwner.rowCount}`);

  // 12. 客户文档：可见性跟随客户，跨部门 L3 读不到
  const documentId = await withClient(OWNER_URL, async (owner) => {
    const row = await owner.query(
      `insert into crm_documents (tenant_id, account_id, name, storage_key, mime, size_bytes, uploaded_by)
       values ($1, $2, '报价单.pdf', 'uploads/crm/test/quote.pdf', 'application/pdf', 1024, $3)
       returning id`,
      [TENANT, fixtures.accounts.ownA, actors.a.userId],
    );
    return row.rows[0].id;
  });
  const documentOwn = await runAs(actors.a, (client) =>
    client.query("select id from crm_documents where id = $1", [documentId]),
  );
  const documentOther = await runAs(actors.b, (client) =>
    client.query("select id from crm_documents where id = $1", [documentId]),
  );
  check("文档可见性跟随客户：本人可读", documentOwn.rowCount === 1, `rowCount=${documentOwn.rowCount}`);
  check("文档可见性跟随客户：兄弟部门读不到", documentOther.rowCount === 0, `rowCount=${documentOther.rowCount}`);

  // 13. 编号规则：自定义前缀对之后取号生效
  await runAs(actors.l1, (client) =>
    client.query("select app.save_trade_code_rule('customer', 'K')"),
  );
  const customCode = await runAs(actors.l1, (client) =>
    client.query("select app.next_trade_code($1, 'customer') as code", [TENANT]),
  );
  check(
    "编号规则前缀生效",
    /^K\d{10}$/.test(customCode.rows[0]?.code ?? ""),
    JSON.stringify(customCode.rows[0]),
  );
  const nonL1Rule = await runAs(actors.a, (client) =>
    client.query("select app.save_trade_code_rule('customer', 'Z')"),
  ).then(
    () => "allowed",
    () => "denied",
  );
  check("非 L1 不能改编号规则", nonL1Rule === "denied", `result=${nonL1Rule}`);

  if (process.env.KEEP_CRM_FIXTURES !== "1") {
    await withClient(OWNER_URL, cleanup);
  }

  console.log(`\n[CRM] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(JSON.stringify({ level: "error", msg: "crm_test_failed", error: String(error) }));
  process.exit(1);
});
