/**
 * P7 离职交接状态机验收：创建 / 通过 / 驳回 / 撤回 / 幂等 / 唯一 L1。
 *
 * 运行：npm run test:handover
 */
import { Client } from "pg";

const TENANT = process.env.HANDOVER_TEST_TENANT ?? "33333333-3333-4333-8333-333333333333";
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
  const client = new Client({ connectionString: url, application_name: "jxf-handover-test" });
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
         set_config('app.department_ids', $4, true),
         set_config('app.active_department_id', $5, true),
         set_config('app.membership_id', $6, true)`,
      [user.userId, TENANT, user.level, `{${user.departmentId}}`, user.departmentId, user.membershipId],
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
    return { ok: false, reason: "没有抛出异常" };
  } catch (error) {
    return { ok: error.code === code, code: error.code, message: error.message };
  }
}

async function cleanup(owner) {
  await owner.query(
    "delete from handover_items where approval_id in (select id from approval_requests where tenant_id = $1)",
    [TENANT],
  );
  await owner.query("delete from approval_requests where tenant_id = $1", [TENANT]);
  await owner.query("delete from audit_events where tenant_id = $1", [TENANT]);
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
  await owner.query("delete from users where email like '%@handover.test'");
}

async function main() {
  if (!DB || !process.env.JXF_OWNER_USER || !process.env.JXF_APP_USER) {
    throw new Error("缺少数据库环境变量，请用 npm run test:handover 执行");
  }

  const fixtures = await withClient(OWNER_URL, async (owner) => {
    await owner.query("begin");
    await cleanup(owner);

    const users = await owner.query(
      `insert into users (email, name) values
         ('boss@handover.test', '老板'),
         ('leaver1@handover.test', '离职一'),
         ('leaver2@handover.test', '离职二'),
         ('leaver3@handover.test', '离职三'),
         ('recipient@handover.test', '接收人')
       returning id, email`,
    );
    const idOf = (email) => users.rows.find((row) => row.email === email).id;

    const dept = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, null, 'handover-root', '交接测试部') returning id`,
      [TENANT],
    );
    const deptId = dept.rows[0].id;

    const other = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, null, 'handover-other', '交接外部') returning id`,
      [TENANT],
    );
    const otherDeptId = other.rows[0].id;

    const memberships = await owner.query(
      `insert into memberships (tenant_id, user_id, department_id, title, access_level) values
         ($1, $2, $3, '老板', 'L1'),
         ($1, $4, $3, '离职一', 'L3'),
         ($1, $5, $3, '离职二', 'L3'),
         ($1, $6, $3, '离职三', 'L3'),
         ($1, $7, $3, '接收人', 'L3'),
         ($1, $4, $8, '兼任', 'L3')
       returning id, user_id, department_id, access_level`,
      [TENANT, idOf("boss@handover.test"), deptId, idOf("leaver1@handover.test"), idOf("leaver2@handover.test"), idOf("leaver3@handover.test"), idOf("recipient@handover.test"), otherDeptId],
    );
    const membershipOf = (userId, departmentId) =>
      memberships.rows.find((row) => row.user_id === userId && row.department_id === departmentId).id;

    await owner.query("commit");

    return {
      bossId: idOf("boss@handover.test"),
      leaver1Id: idOf("leaver1@handover.test"),
      leaver2Id: idOf("leaver2@handover.test"),
      leaver3Id: idOf("leaver3@handover.test"),
      recipientId: idOf("recipient@handover.test"),
      deptId,
      otherDeptId,
      bossMembershipId: membershipOf(idOf("boss@handover.test"), deptId),
      leaver1MembershipId: membershipOf(idOf("leaver1@handover.test"), deptId),
      leaver1OtherMembershipId: membershipOf(idOf("leaver1@handover.test"), otherDeptId),
      leaver2MembershipId: membershipOf(idOf("leaver2@handover.test"), deptId),
      leaver3MembershipId: membershipOf(idOf("leaver3@handover.test"), deptId),
      recipientMembershipId: membershipOf(idOf("recipient@handover.test"), deptId),
    };
  });

  const boss = {
    userId: fixtures.bossId,
    level: "L1",
    departmentId: fixtures.deptId,
    membershipId: fixtures.bossMembershipId,
  };

  // 1. 创建审批单：任用 pending_removal，账号保持 active（仍有另一条有效任用）
  const created = await runAs(boss, async (client) => {
    const result = await client.query(
      "select app.create_membership_removal_request($1, $2::jsonb) as id",
      [
        fixtures.leaver1MembershipId,
        JSON.stringify([
          {
            assetType: "knowledge",
            assetId: "11111111-1111-4111-8111-111111111111",
            toUserId: fixtures.recipientId,
          },
        ]),
      ],
    );
    return result.rows[0].id;
  });
  check("创建离职交接审批单", typeof created === "string" && created.length === 36);

  const stateAfterCreate = await withClient(OWNER_URL, async (owner) => {
    const membership = await owner.query("select status from memberships where id = $1", [
      fixtures.leaver1MembershipId,
    ]);
    const user = await owner.query("select status from users where id = $1", [fixtures.leaver1Id]);
    const items = await owner.query("select count(*)::int as count from handover_items where approval_id = $1", [
      created,
    ]);
    return { membership: membership.rows[0].status, user: user.rows[0].status, items: items.rows[0].count };
  });
  check("任用变为 pending_removal", stateAfterCreate.membership === "pending_removal", stateAfterCreate.membership);
  check(
    "多任用用户账号保持 active",
    stateAfterCreate.user === "active",
    stateAfterCreate.user,
  );
  check("交接明细写入 1 条", stateAfterCreate.items === 1, `count=${stateAfterCreate.items}`);

  const pendingCount = await runAs(boss, (client) =>
    client.query("select app.pending_approval_count() as count"),
  );
  check("待审批计数为 1", pendingCount.rows[0].count === 1, `count=${pendingCount.rows[0].count}`);

  const countAsMember = await runAs(
    {
      userId: fixtures.recipientId,
      level: "L3",
      departmentId: fixtures.deptId,
      membershipId: fixtures.recipientMembershipId,
    },
    (client) => client.query("select app.pending_approval_count() as count"),
  );
  check("非 L1 待审批计数为 0", countAsMember.rows[0].count === 0);

  // 2. 幂等：同一任用重复创建被拒
  const duplicate = await expectError(
    () =>
      runAs(boss, (client) =>
        client.query("select app.create_membership_removal_request($1, '[]'::jsonb)", [
          fixtures.leaver1MembershipId,
        ]),
      ),
    "23505",
  );
  check("重复申请被拒绝（23505）", duplicate.ok, duplicate.code ?? duplicate.reason);

  // 3. 非 L1 不能发起
  const denied = await expectError(
    () =>
      runAs(
        {
          userId: fixtures.leaver2Id,
          level: "L3",
          departmentId: fixtures.deptId,
          membershipId: fixtures.leaver2MembershipId,
        },
        (client) =>
          client.query("select app.create_membership_removal_request($1, '[]'::jsonb)", [
            fixtures.leaver2MembershipId,
          ]),
      ),
    "42501",
  );
  check("非 L1 不能发起交接（42501）", denied.ok, denied.code ?? denied.reason);

  // 4. 最后一位 L1 不可移出
  const lastL1 = await expectError(
    () =>
      runAs(boss, (client) =>
        client.query("select app.create_membership_removal_request($1, '[]'::jsonb)", [
          fixtures.bossMembershipId,
        ]),
      ),
    "23514",
  );
  check("最后一位 L1 不可移出（23514）", lastL1.ok, lastL1.code ?? lastL1.reason);

  // 5. 审批通过：任用 removed、明细标记已转移、审批 approved
  await runAs(boss, (client) =>
    client.query("select app.approve_membership_removal($1)", [created]),
  );
  const stateAfterApprove = await withClient(OWNER_URL, async (owner) => {
    const membership = await owner.query("select status from memberships where id = $1", [
      fixtures.leaver1MembershipId,
    ]);
    const user = await owner.query("select status from users where id = $1", [fixtures.leaver1Id]);
    const approval = await owner.query(
      "select status, decided_by from approval_requests where id = $1",
      [created],
    );
    const transferred = await owner.query(
      "select count(*)::int as count from handover_items where approval_id = $1 and transferred_at is not null",
      [created],
    );
    return {
      membership: membership.rows[0].status,
      user: user.rows[0].status,
      approval: approval.rows[0].status,
      decidedBy: approval.rows[0].decided_by,
      transferred: transferred.rows[0].count,
    };
  });
  check("任用变为 removed", stateAfterApprove.membership === "removed", stateAfterApprove.membership);
  check(
    "仍有其他任用，账号不被停用",
    stateAfterApprove.user === "active",
    stateAfterApprove.user,
  );
  check("审批单标记 approved", stateAfterApprove.approval === "approved");
  check("审批人记录为当前 L1", stateAfterApprove.decidedBy === fixtures.bossId);
  check("交接明细标记已转移", stateAfterApprove.transferred === 1, `count=${stateAfterApprove.transferred}`);

  const countAfterApprove = await runAs(boss, (client) =>
    client.query("select app.pending_approval_count() as count"),
  );
  check("通过后待审批计数归零", countAfterApprove.rows[0].count === 0);

  // 6. 驳回：还原 active
  const rejectId = await runAs(boss, (client) =>
    client
      .query("select app.create_membership_removal_request($1, '[]'::jsonb) as id", [
        fixtures.leaver2MembershipId,
      ])
      .then((result) => result.rows[0].id),
  );
  await runAs(boss, (client) =>
    client.query("select app.reject_membership_removal($1, $2)", [rejectId, "交接人未到位"]),
  );
  const stateAfterReject = await withClient(OWNER_URL, async (owner) => {
    const membership = await owner.query("select status from memberships where id = $1", [
      fixtures.leaver2MembershipId,
    ]);
    const user = await owner.query("select status from users where id = $1", [fixtures.leaver2Id]);
    const approval = await owner.query("select status, payload from approval_requests where id = $1", [
      rejectId,
    ]);
    return {
      membership: membership.rows[0].status,
      user: user.rows[0].status,
      approval: approval.rows[0].status,
      reason: approval.rows[0].payload?.reason,
    };
  });
  check("驳回后任用恢复 active", stateAfterReject.membership === "active", stateAfterReject.membership);
  check("驳回后账号恢复 active", stateAfterReject.user === "active", stateAfterReject.user);
  check("审批单标记 rejected", stateAfterReject.approval === "rejected");
  check("驳回原因写入 payload", stateAfterReject.reason === "交接人未到位", String(stateAfterReject.reason));

  // 7. 撤回：还原 active
  const cancelId = await runAs(boss, (client) =>
    client
      .query("select app.create_membership_removal_request($1, '[]'::jsonb) as id", [
        fixtures.leaver3MembershipId,
      ])
      .then((result) => result.rows[0].id),
  );
  await runAs(boss, (client) =>
    client.query("select app.cancel_membership_removal($1)", [cancelId]),
  );
  const stateAfterCancel = await withClient(OWNER_URL, async (owner) => {
    const membership = await owner.query("select status from memberships where id = $1", [
      fixtures.leaver3MembershipId,
    ]);
    const approval = await owner.query("select status from approval_requests where id = $1", [cancelId]);
    return { membership: membership.rows[0].status, approval: approval.rows[0].status };
  });
  check("撤回后任用恢复 active", stateAfterCancel.membership === "active", stateAfterCancel.membership);
  check("审批单标记 cancelled", stateAfterCancel.approval === "cancelled");

  // 8. 单任用用户：创建后账号立即冻结
  const soloId = await runAs(boss, (client) =>
    client
      .query("select app.create_membership_removal_request($1, '[]'::jsonb) as id", [
        fixtures.leaver3MembershipId,
      ])
      .then((result) => result.rows[0].id),
  );
  const soloUser = await withClient(OWNER_URL, async (owner) =>
    owner.query("select status from users where id = $1", [fixtures.leaver3Id]),
  );
  check("单任用用户创建审批后账号冻结", soloUser.rows[0].status === "pending_handover", soloUser.rows[0].status);

  const canLogin = await withClient(OWNER_URL, async (owner) =>
    owner.query("select app.user_can_login($1) as ok", [fixtures.leaver3Id]),
  );
  check("交接中账号不可登录", canLogin.rows[0].ok === false);

  await runAs(boss, (client) =>
    client.query("select app.cancel_membership_removal($1)", [soloId]),
  );

  await withClient(OWNER_URL, async (owner) => {
    await owner.query("begin");
    await cleanup(owner);
    await owner.query("commit");
  });

  console.log(`\n[handover] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[handover] 执行失败", error);
  process.exitCode = 1;
});
