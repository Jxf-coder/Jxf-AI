/**
 * M2-A3 知识库验收：RLS 隔离、sha256 去重、批次撤回、确认门槛、混合检索降级。
 *
 * 使用真实 PostgreSQL + jxf_app 角色；所有写入走 owner 连接播种（owner 绕过 RLS），
 * 断言全部通过应用角色 + SET LOCAL 身份执行，确保测的是策略而不是超管权限。
 *
 * 运行：npm run test:knowledge
 */
import { randomUUID } from "node:crypto";

import { Client } from "pg";

import { chunkPages } from "../src/lib/knowledge/chunk.ts";
import { createManualCard } from "../src/lib/knowledge/cards.ts";
import { verifyQuoteInChunk } from "../src/lib/knowledge/evidence.ts";
import { answerQuestion } from "../src/lib/knowledge/qa.ts";
import { runRegression, seedRegressionQuestions } from "../src/lib/knowledge/regression.ts";
import {
  loadWorkspaceTree,
  restoreDocument,
  setCardVisibility,
  trashDocument,
} from "../src/lib/knowledge/workspace.ts";

const TENANT = process.env.KB_TEST_TENANT ?? "22222222-2222-4222-8222-222222222222";
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
  const client = new Client({ connectionString: url, application_name: "jxf-knowledge-test" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** 以 jxf_app + SET LOCAL 身份执行（完全复刻 withUserContext） */
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

async function resolveActor(userId, membershipId) {
  return withClient(APP_URL, async (client) => {
    const { rows } = await client.query(
      "select app.user_department_ids($1) as ids, app.effective_access_level($1) as level",
      [userId],
    );
    const level = rows[0]?.level ?? null;
    const membershipIds = rows[0]?.ids ?? [];
    let departmentIds = membershipIds;
    if (level === "L1") {
      const scope = await client.query("select app.tenant_department_ids($1) as ids", [TENANT]);
      departmentIds = scope.rows[0]?.ids ?? membershipIds;
    }
    return { userId, level, departmentIds, membershipId };
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

/** 1024 维单位向量：index 处为 1，其余为 0（用于确定性最近邻断言） */
function unitVector(index) {
  const values = new Array(1024).fill(0);
  values[index] = 1;
  return `[${values.join(",")}]`;
}

async function cleanup(owner) {
  await owner.query("delete from qa_logs where tenant_id = $1", [TENANT]);
  await owner.query("delete from knowledge_gaps where tenant_id = $1", [TENANT]);
  await owner.query("delete from card_evidence where card_id in (select id from knowledge_cards where tenant_id = $1)", [TENANT]);
  await owner.query("delete from knowledge_cards where tenant_id = $1", [TENANT]);
  await owner.query("delete from regression_items where run_id in (select id from regression_runs where tenant_id = $1)", [TENANT]);
  await owner.query("delete from regression_runs where tenant_id = $1", [TENANT]);
  await owner.query("delete from regression_questions where tenant_id = $1", [TENANT]);
  await owner.query("delete from doc_chunks where tenant_id = $1", [TENANT]);
  await owner.query("delete from documents where tenant_id = $1", [TENANT]);
  await owner.query("delete from ingest_files where run_id in (select id from ingest_runs where tenant_id = $1)", [TENANT]);
  await owner.query("delete from ingest_runs where tenant_id = $1", [TENANT]);
  await owner.query("delete from assets where tenant_id = $1", [TENANT]);
  await owner.query("delete from ai_employee_grants where tenant_id = $1", [TENANT]);
  await owner.query("delete from ai_employees where tenant_id = $1", [TENANT]);
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
  await owner.query("delete from users where email like '%@kb.test'");
}

async function seed() {
  return withClient(OWNER_URL, async (owner) => {
    await owner.query("begin");
    await cleanup(owner);

    const users = await owner.query(
      `insert into users (email, name) values
         ('a1@kb.test', '一组交付'),
         ('a2@kb.test', '一组经理'),
         ('b1@kb.test', '二组顾问'),
         ('boss@kb.test', '知识库 L1')
       returning id, email`,
    );
    const uid = Object.fromEntries(users.rows.map((row) => [row.email, row.id]));

    const root = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, null, 'kb-root', '知识库总部') returning id`,
      [TENANT],
    );
    const groupA = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'kb-group-a', '知识库一组') returning id`,
      [TENANT, root.rows[0].id],
    );
    const groupB = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'kb-group-b', '知识库二组') returning id`,
      [TENANT, root.rows[0].id],
    );
    const teamA1 = await owner.query(
      `insert into departments (tenant_id, parent_id, slug, name)
       values ($1, $2, 'kb-team-a1', '一组华东小队') returning id`,
      [TENANT, groupA.rows[0].id],
    );

    const memberships = await owner.query(
      `insert into memberships (tenant_id, user_id, department_id, title, access_level, status) values
         ($1, $2, $3, '交付顾问', 'L3', 'active'),
         ($1, $4, $3, '一组经理', 'L2', 'active'),
         ($1, $5, $6, '二组顾问', 'L3', 'active'),
         ($1, $7, $8, '创始人', 'L1', 'active')
       returning id, user_id`,
      [
        TENANT,
        uid["a1@kb.test"],
        groupA.rows[0].id,
        uid["a2@kb.test"],
        uid["b1@kb.test"],
        groupB.rows[0].id,
        uid["boss@kb.test"],
        root.rows[0].id,
      ],
    );
    const membershipOf = (email) => memberships.rows.find((row) => row.user_id === uid[email]).id;

    const run = await owner.query(
      `insert into ingest_runs (id, tenant_id, department_id, kind, goal, status, created_by)
       values ($1, $2, $3, 'upload', '知识库验收批次', 'done', $4) returning id`,
      [randomUUID(), TENANT, groupA.rows[0].id, uid["boss@kb.test"]],
    );

    // 两块 sha 相同的资产：同部门必须冲突，跨部门必须允许
    const sha = "7f3c0d9b2a1e4f5c8d6b0a9e8f7c6b5a4d3e2f1c0b9a8d7e6f5a4b3c2d1e0f9a";
    const assetA = await owner.query(
      `insert into assets (tenant_id, department_id, title, storage_key, mime, byte_size, sha256, kind, created_by)
       values ($1, $2, '验收标准.pdf', 'kb/a/verify.pdf', 'application/pdf', 1024, $3, 'document', $4) returning id`,
      [TENANT, groupA.rows[0].id, sha, uid["a1@kb.test"]],
    );

    const docs = await owner.query(
      `insert into documents (id, tenant_id, department_id, asset_id, ingest_run_id, title, mime, page_count, char_count, status, sha256) values
         ($1, $2, $3, $4, $5, '验收标准', 'application/pdf', 3, 40, 'parsed', $6),
         ($7, $2, $8, null, $5, '海外交付说明', 'text/plain', 1, 20, 'parsed', $9),
         ($10, $2, $11, null, null, '二组预算流程', 'text/plain', 1, 20, 'parsed', $12),
         ($13, $2, $3, null, $5, '旧版验收标准', 'application/pdf', 1, 20, 'revoked', $14)
       returning id`,
      [
        randomUUID(),
        TENANT,
        groupA.rows[0].id,
        assetA.rows[0].id,
        run.rows[0].id,
        sha,
        randomUUID(),
        teamA1.rows[0].id,
        "1111111111111111111111111111111111111111111111111111111111111111",
        randomUUID(),
        groupB.rows[0].id,
        "2222222222222222222222222222222222222222222222222222222222222222",
        randomUUID(),
        "3333333333333333333333333333333333333333333333333333333333333333",
      ],
    );
    const [docA, docA1, docB, docRevoked] = docs.rows.map((row) => row.id);

    const chunks = await owner.query(
      `insert into doc_chunks (id, tenant_id, department_id, document_id, ord, page_no, char_start, char_end, text, embedding) values
         ($1, $2, $3, $4, 0, 1, 0, 22, '食品接触材料的迁移量应当符合国家标准限值要求。', $5::vector),
         ($6, $2, $7, $8, 0, 1, 0, 16, '海外客户的交付验收需要提前预约。', $9::vector),
         ($10, $2, $11, $12, 0, 1, 0, 14, '二组独有的预算审批流程说明。', $13::vector),
         ($14, $2, $3, $15, 0, 1, 0, 18, '已撤回批次的旧版迁移量要求。', $16::vector)
       returning id`,
      [
        randomUUID(),
        TENANT,
        groupA.rows[0].id,
        docA,
        unitVector(0),
        randomUUID(),
        teamA1.rows[0].id,
        docA1,
        unitVector(1),
        randomUUID(),
        groupB.rows[0].id,
        docB,
        unitVector(2),
        randomUUID(),
        docRevoked,
        unitVector(3),
      ],
    );
    const [chunkA, chunkA1, chunkB, chunkRevoked] = chunks.rows.map((row) => row.id);

    const cards = await owner.query(
      `insert into knowledge_cards (id, tenant_id, department_id, kind, title, body, status, origin, human_edited, conflict_with, valid_until) values
         ($1, $2, $3, 'fact', '食品接触材料迁移量限值', '迁移量应当符合国家标准限值要求。', 'confirmed', 'manual', true, '{}', null),
         ($4, $2, $3, 'fact', '待确认迁移量口径', '尚未核对证据的迁移量口径。', 'pending', 'distill', false, '{}', null),
         ($5, $2, $3, 'fact', '有证据的迁移量口径', '以证据原文为准的迁移量口径。', 'pending', 'distill', false, '{}', null),
         ($6, $2, $3, 'fact', '存在冲突的迁移量口径', '与既有卡冲突的迁移量口径。', 'pending', 'distill', false, $7, null),
         ($8, $2, $3, 'fact', '已过期的迁移量口径', '有效期已过的迁移量口径。', 'pending', 'distill', false, '{}', current_date - 1),
         ($9, $2, $3, 'fact', '人工修订过的迁移量口径', '人工改过的迁移量口径。', 'pending', 'distill', true, '{}', null),
         ($10, $2, $11, 'fact', '二组迁移量口径', '二组内部的迁移量口径。', 'pending', 'distill', true, '{}', null)
       returning id`,
      [
        randomUUID(),
        TENANT,
        groupA.rows[0].id,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        [],
        randomUUID(),
        randomUUID(),
        randomUUID(),
        groupB.rows[0].id,
      ],
    );
    const [cardConfirmed, cardBare, cardVerified, cardConflict, cardExpired, cardHuman, cardB] =
      cards.rows.map((row) => row.id);

    await owner.query(
      `update knowledge_cards set conflict_with = $1::uuid[] where id = $2`,
      [[cardConfirmed], cardConflict],
    );

    await owner.query(
      `insert into card_evidence (card_id, chunk_id, document_id, page_no, locator, quote, char_start, char_end, verified, verified_at) values
         ($1, $2, $3, 1, '第 1 页', '食品接触材料的迁移量应当符合国家标准限值要求。', 0, 22, true, now()),
         ($4, $2, $3, 1, '第 1 页', '迁移量应当符合国家标准限值要求。', 0, 15, true, now()),
         ($5, $2, $3, 1, '第 1 页', '迁移量应当符合国家标准限值要求。', 0, 15, true, now()),
         ($6, $2, $3, 1, '第 1 页', '迁移量应当符合国家标准限值要求。', 0, 15, true, now())`,
      [cardConfirmed, chunkA, docA, cardVerified, cardConflict, cardExpired],
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
      sha,
      docA,
      docA1,
      docB,
      docRevoked,
      chunkA,
      chunkA1,
      chunkB,
      chunkRevoked,
      cardConfirmed,
      cardBare,
      cardVerified,
      cardConflict,
      cardExpired,
      cardHuman,
      cardB,
    };
  });
}

async function main() {
  if (!DB || !process.env.JXF_OWNER_USER || !process.env.JXF_APP_USER) {
    throw new Error("缺少数据库环境变量，请用 npm run test:knowledge 执行");
  }

  const fx = await seed();

  const memberA = await resolveActor(fx.uid["a1@kb.test"], fx.membershipOf("a1@kb.test"));
  const leadA = await resolveActor(fx.uid["a2@kb.test"], fx.membershipOf("a2@kb.test"));
  const memberB = await resolveActor(fx.uid["b1@kb.test"], fx.membershipOf("b1@kb.test"));
  const boss = await resolveActor(fx.uid["boss@kb.test"], fx.membershipOf("boss@kb.test"));

  // 1. 跨部门读：L3(一组) 看不到二组的文档 / 切片 / 卡片
  const crossDocs = await runAs(memberA, (client) =>
    client.query("select id from documents where department_id = $1", [fx.departments.groupB]),
  );
  check("L3 读兄弟部门文档", crossDocs.rowCount === 0, `rowCount=${crossDocs.rowCount}`);

  const crossChunks = await runAs(memberA, (client) =>
    client.query("select id from doc_chunks where department_id = $1", [fx.departments.groupB]),
  );
  check("L3 读兄弟部门切片", crossChunks.rowCount === 0, `rowCount=${crossChunks.rowCount}`);

  const crossCards = await runAs(memberA, (client) =>
    client.query("select id from knowledge_cards where department_id = $1", [fx.departments.groupB]),
  );
  check("L3 读兄弟部门知识卡", crossCards.rowCount === 0, `rowCount=${crossCards.rowCount}`);

  // 2. 子树可见：L2(一组) 能看到下级小队的切片
  const subtreeChunks = await runAs(leadA, (client) =>
    client.query("select id from doc_chunks where department_id = $1", [fx.departments.teamA1]),
  );
  check("L2 读下级小队切片", subtreeChunks.rowCount === 1, `rowCount=${subtreeChunks.rowCount}`);

  // 3. 未注入身份 → 0 行（fail-closed）
  const anon = await withClient(APP_URL, async (client) => {
    await client.query("begin");
    const result = await client.query("select id from knowledge_cards where tenant_id = $1", [TENANT]);
    await client.query("commit");
    return result;
  });
  check("未注入身份读知识卡", anon.rowCount === 0, `rowCount=${anon.rowCount}`);

  // 4. sha256 去重：同租户 + 同部门重复上传 → 唯一约束拒绝
  const duplicateAsset = await expectError(
    () =>
      runAs(memberA, (client) =>
        client.query(
          `insert into assets (tenant_id, department_id, title, storage_key, mime, byte_size, sha256, kind, created_by)
           values ($1, $2, '重复.pdf', 'kb/a/dup.pdf', 'application/pdf', 1024, $3, 'document', $4)`,
          [TENANT, fx.departments.groupA, fx.sha, memberA.userId],
        ),
      ),
    "23505",
  );
  check("同部门重复 sha256 被拒绝", duplicateAsset.ok, duplicateAsset.error ? `code=${duplicateAsset.error.code}` : "未报错");

  const otherDepartmentAsset = await runAs(boss, (client) =>
    client.query(
      `insert into assets (tenant_id, department_id, title, storage_key, mime, byte_size, sha256, kind, created_by)
       values ($1, $2, '同名文件.pdf', 'kb/b/same.pdf', 'application/pdf', 1024, $3, 'document', $4)
       returning id`,
      [TENANT, fx.departments.groupB, fx.sha, boss.userId],
    ),
  );
  check("跨部门相同 sha256 允许", otherDepartmentAsset.rowCount === 1, `rowCount=${otherDepartmentAsset.rowCount}`);

  // 5. 写边界：L3 不得在兄弟部门造数据
  const crossInsert = await expectError(
    () =>
      runAs(memberA, (client) =>
        client.query(
          `insert into documents (tenant_id, department_id, title, mime, sha256)
           values ($1, $2, '越权文档', 'text/plain', 'deadbeef')`,
          [TENANT, fx.departments.groupB],
        ),
      ),
    "42501",
  );
  check("L3 向兄弟部门写入文档被拒绝", crossInsert.ok, crossInsert.error ? `code=${crossInsert.error.code}` : "未报错");

  const sameDeptInsert = await runAs(memberA, (client) =>
    client.query(
      `insert into documents (tenant_id, department_id, title, mime, sha256)
       values ($1, $2, '本部门新文档', 'text/plain', 'cafebabe')
       returning id`,
      [TENANT, fx.departments.groupA],
    ),
  );
  check("L3 可在本部门写入文档", sameDeptInsert.rowCount === 1, `rowCount=${sameDeptInsert.rowCount}`);

  // 6. 确认门槛：只剩「有证据 / 人工编辑过」两张
  const confirmable = await runAs(leadA, (client) =>
    client.query("select id from v_confirmable_cards where department_id = $1", [fx.departments.groupA]),
  );
  const confirmableIds = new Set(confirmable.rows.map((row) => row.id));
  check("确认门槛：无证据 pending 卡不可确认", !confirmableIds.has(fx.cardBare));
  check("确认门槛：有已核对证据可确认", confirmableIds.has(fx.cardVerified));
  check("确认门槛：人工编辑过可确认", confirmableIds.has(fx.cardHuman));
  check("确认门槛：存在冲突不可确认", !confirmableIds.has(fx.cardConflict));
  check("确认门槛：已过期不可确认", !confirmableIds.has(fx.cardExpired));
  check("确认门槛：已确认卡不再出现在待确认视图", !confirmableIds.has(fx.cardConfirmed));
  check("确认门槛：视图只含本部门", confirmable.rowCount === 2, `rowCount=${confirmable.rowCount}`);

  const crossConfirmable = await runAs(memberA, (client) =>
    client.query("select id from v_confirmable_cards where department_id = $1", [fx.departments.groupB]),
  );
  check("确认门槛视图受 RLS 约束", crossConfirmable.rowCount === 0, `rowCount=${crossConfirmable.rowCount}`);

  // 7. 批次撤回：revoked 文档的切片不参与检索（「旧版」只存在于该切片）
  const revokedHit = await runAs(memberA, (client) =>
    client.query("select * from app.hybrid_search($1, null, 10, 60)", ["旧版"]),
  );
  check(
    "撤回文档不进入关键词召回",
    revokedHit.rowCount === 0 && !revokedHit.rows.some((row) => row.chunk_id === fx.chunkRevoked),
    `hits=${revokedHit.rows.length}`,
  );

  // 8. 纯关键词降级（p_embedding = null）能命中中文词
  const keywordOnly = await runAs(memberA, (client) =>
    client.query("select * from app.hybrid_search($1, null, 10, 60)", ["迁移量 限值"]),
  );
  check(
    "无 embedding 时降级为纯关键词召回",
    keywordOnly.rows.some((row) => row.chunk_id === fx.chunkA),
    `hits=${keywordOnly.rows.map((row) => row.chunk_id).join(",")}`,
  );

  // 9. 关键词通道不跨部门
  check(
    "关键词召回不含兄弟部门切片",
    !keywordOnly.rows.some((row) => row.chunk_id === fx.chunkB),
    `hits=${keywordOnly.rows.map((row) => row.chunk_id).join(",")}`,
  );

  // 10. 子树检索：L2 能检索到下级小队文档
  const subtreeSearch = await runAs(leadA, (client) =>
    client.query("select * from app.hybrid_search($1, null, 10, 60)", ["交付验收 预约"]),
  );
  check(
    "L2 检索覆盖下级小队",
    subtreeSearch.rows.some((row) => row.chunk_id === fx.chunkA1),
    `hits=${subtreeSearch.rows.map((row) => row.chunk_id).join(",")}`,
  );

  // 11. 向量通道：查询向量与 chunkA 同向，应排第一
  const vectorFirst = await runAs(memberA, (client) =>
    client.query("select * from app.hybrid_search($1, $2::vector, 5, 60)", ["", unitVector(0)]),
  );
  check(
    "向量通道最近邻排序正确",
    vectorFirst.rows[0]?.chunk_id === fx.chunkA,
    `top=${vectorFirst.rows[0]?.chunk_id}`,
  );

  // 12. 卡片级召回：只返回 confirmed
  const cardHits = await runAs(memberA, (client) =>
    client.query("select * from app.hybrid_search_cards($1, null, 10, 60)", ["迁移量"]),
  );
  const cardIds = cardHits.rows.map((row) => row.card_id);
  check("卡片召回只返回 confirmed", cardIds.length === 1 && cardIds[0] === fx.cardConfirmed, `ids=${cardIds.join(",")}`);
  check("卡片召回不跨部门", !cardIds.includes(fx.cardB), `ids=${cardIds.join(",")}`);

  // 13. 卡片向量通道：切片 → 证据 → 卡片
  const cardVector = await runAs(memberA, (client) =>
    client.query("select * from app.hybrid_search_cards($1, $2::vector, 5, 60)", ["", unitVector(0)]),
  );
  check(
    "卡片向量通道经证据链命中",
    cardVector.rows[0]?.card_id === fx.cardConfirmed,
    `top=${cardVector.rows[0]?.card_id}`,
  );

  // 14. AI 员工：租户内可读，仅 L1 可写
  const employeeByL3 = await expectError(
    () =>
      runAs(memberA, (client) =>
        client.query(
          `insert into ai_employees (tenant_id, slug, name, created_by) values ($1, 'kb-ai-1', '知识助手', $2)`,
          [TENANT, memberA.userId],
        ),
      ),
    "42501",
  );
  check("L3 创建 AI 员工被拒绝", employeeByL3.ok, employeeByL3.error ? `code=${employeeByL3.error.code}` : "未报错");

  const employeeByL1 = await runAs(boss, (client) =>
    client.query(
      `insert into ai_employees (tenant_id, slug, name, created_by) values ($1, 'kb-ai-1', '知识助手', $2) returning id`,
      [TENANT, boss.userId],
    ),
  );
  check("L1 创建 AI 员工成功", employeeByL1.rowCount === 1, `rowCount=${employeeByL1.rowCount}`);

  const employeeVisible = await runAs(memberB, (client) =>
    client.query("select id from ai_employees where tenant_id = $1", [TENANT]),
  );
  check("AI 员工定义租户内可读", employeeVisible.rowCount === 1, `rowCount=${employeeVisible.rowCount}`);

  // 15. 问答审计：本部门可写，跨部门不可见
  const qaInsert = await runAs(memberA, (client) =>
    client.query(
      `insert into qa_logs (tenant_id, department_id, question, answer, cited_card_ids, invalid_cites, unverified_numbers)
       values ($1, $2, '迁移量限值是多少', '见知识卡', $3::uuid[], '{}', '{}') returning id`,
      [TENANT, fx.departments.groupA, [fx.cardConfirmed]],
    ),
  );
  check("问答审计可写入本部门", qaInsert.rowCount === 1, `rowCount=${qaInsert.rowCount}`);

  const qaCross = await runAs(memberB, (client) =>
    client.query("select id from qa_logs where department_id = $1", [fx.departments.groupA]),
  );
  check("问答审计跨部门不可见", qaCross.rowCount === 0, `rowCount=${qaCross.rowCount}`);

  // 16. 关键词模式切分：中文长句按二元组召回
  const patterns = await withClient(APP_URL, (client) =>
    client.query("select app.keyword_patterns($1) as pats", ["食品接触材料的迁移量要求"]),
  );
  const pats = patterns.rows[0]?.pats ?? [];
  check("中文关键词切分出多个模式", pats.length >= 6, JSON.stringify(pats));
  check("关键词模式为 like 通配", pats.every((pat) => pat.startsWith("%") && pat.endsWith("%")), JSON.stringify(pats));

  // 17. 证据核对：逐字匹配 + 空白/全半角归一化，改写即失败
  const source = "食品接触材料的迁移量应当符合国家标准限值要求。总迁移量不得超过 10 mg/dm²。";
  const exact = verifyQuoteInChunk(source, 1000, "迁移量应当符合国家标准限值要求");
  check("证据：逐字命中并给出原文区间", exact.verified, JSON.stringify(exact));
  check(
    "证据：区间对应原文",
    exact.verified && source.slice(exact.charStart - 1000, exact.charEnd - 1000) === exact.quote,
    JSON.stringify(exact),
  );

  const spaced = verifyQuoteInChunk(source, 0, "总迁移量 不得超过 10mg/dm²");
  check("证据：空白差异仍命中", spaced.verified, JSON.stringify(spaced));

  const ellipsis = verifyQuoteInChunk(source, 0, "食品接触材料…限值要求");
  check("证据：省略号跳过仍命中", ellipsis.verified, JSON.stringify(ellipsis));

  const rewritten = verifyQuoteInChunk(source, 0, "迁移量可以超过国家标准限值");
  check("证据：改写引文不命中", !rewritten.verified, JSON.stringify(rewritten));

  const tooShort = verifyQuoteInChunk(source, 0, "要求");
  check("证据：过短引文不算证据", !tooShort.verified, JSON.stringify(tooShort));

  // 18. 分块：区间与原文严格对齐（证据链高亮依赖该不变量）
  const chunked = chunkPages([
    "第一页内容。" + "迁移量应当符合限值。".repeat(80),
    "第二页内容。" + "验收需要提前预约。".repeat(60),
  ]);
  const aligned = chunked.chunks.every(
    (chunk) => chunked.fullText.slice(chunk.charStart, chunk.charEnd) === chunk.text,
  );
  check("分块区间与全文对齐", aligned, `chunks=${chunked.chunks.length}`);
  check(
    "分块覆盖两页且页码递增",
    chunked.chunks.some((chunk) => chunk.pageNo === 1) && chunked.chunks.some((chunk) => chunk.pageNo === 2),
    JSON.stringify(chunked.chunks.map((chunk) => chunk.pageNo)),
  );

  // 19. 单轮 RAG：无 AI 时退化为检索结果；未命中沉淀知识缺口
  // 门禁不依赖外部 AI：强制关闭生成通道，保证断言可重复、不产生 API 费用
  process.env.JXF_AI_ENABLED = "false";
  process.env.APP_DATABASE_URL = process.env.APP_DATABASE_URL ?? APP_URL;
  process.env.S3_ENDPOINT = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
  process.env.S3_BUCKET = process.env.S3_BUCKET ?? process.env.MINIO_BUCKET ?? "jxf-assets";
  process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY ?? process.env.MINIO_ROOT_USER ?? "jxf";
  process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY ?? process.env.MINIO_ROOT_PASSWORD ?? "jxf";

  const tenantDepartments = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query("select id from departments where tenant_id = $1", [TENANT]);
    return rows.map((row) => row.id);
  });

  const bossContext = {
    userId: fx.uid["boss@kb.test"],
    tenantId: TENANT,
    activeMembership: null,
    activeMemberships: [],
    activeMembershipId: fx.membershipOf("boss@kb.test"),
    activeDepartmentId: fx.departments.groupA,
    activeDepartmentName: "知识库一组",
    membershipDepartmentIds: [fx.departments.root],
    departmentIds: tenantDepartments,
    subtreeDepartmentIds: tenantDepartments,
    accessLevel: "L1",
    permissionVersion: 0,
    requestId: "kb-test",
  };

  const retrieved = await answerQuestion(bossContext, "迁移量限值");
  check("问答：无 AI 时退化为仅检索", retrieved.mode === "retrieval_only", retrieved.mode);
  check(
    "问答：检索命中已确认卡",
    retrieved.citations.some((citation) => citation.cardId === fx.cardConfirmed),
    JSON.stringify(retrieved.citations.map((citation) => citation.cardId)),
  );
  check("问答：合法引用不产生越界记录", retrieved.invalidCites.length === 0, JSON.stringify(retrieved.invalidCites));

  const miss = await answerQuestion(bossContext, "量子计算的退相干时间是多少");
  check("问答：无相关依据时如实未命中", miss.mode === "no_match", miss.mode);
  check("问答：未命中沉淀知识缺口", miss.gapRecorded === true);

  const qaAudit = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      `select question, cited_card_ids, invalid_cites, unverified_numbers, gap_id
         from qa_logs
        where tenant_id = $1
        order by created_at desc
        limit 2`,
      [TENANT],
    );
    return rows;
  });
  check("问答审计写入 qa_logs", qaAudit.length === 2, `rows=${qaAudit.length}`);
  check(
    "未命中的问答带知识缺口外键",
    qaAudit.some((row) => row.gap_id !== null),
    JSON.stringify(qaAudit.map((row) => row.gap_id)),
  );
  check(
    "命中的问答记录引用卡片",
    qaAudit.some((row) => (row.cited_card_ids ?? []).includes(fx.cardConfirmed)),
    JSON.stringify(qaAudit.map((row) => row.cited_card_ids)),
  );

  // 20. 回归门禁：基线题保留率 >= 0.9 才通过
  const seeded = await seedRegressionQuestions(bossContext);
  check("回归：按已确认卡生成基线题", seeded === 1, `created=${seeded}`);

  const passRun = await runRegression(bossContext, "kb-test-pass");
  check(
    "回归：同题召回原卡，保留率 100%",
    passRun.total === 1 && passRun.passed === 1 && passRun.retained === 1,
    JSON.stringify({ total: passRun.total, passed: passRun.passed, retained: passRun.retained }),
  );

  // 追加一道不可能命中的基线题，整体门禁应判失败
  await withClient(OWNER_URL, async (owner) => {
    await owner.query(
      `insert into regression_questions (tenant_id, department_id, q, source, baseline_ids)
       values ($1, $2, '完全不存在的基线题', 'manual', $3::uuid[])`,
      [TENANT, fx.departments.groupA, [randomUUID()]],
    );
  });

  const failRun = await runRegression(bossContext, "kb-test-fail");
  check(
    "回归：存在未通过题目时整体判失败",
    failRun.total === 2 && failRun.passed === 1 && failRun.retained < 0.9,
    JSON.stringify({ total: failRun.total, passed: failRun.passed, retained: failRun.retained }),
  );

  const regressionAudit = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      `select r.total, r.passed, r.retained,
              (select count(*) from regression_items i where i.run_id = r.id)::int as items
         from regression_runs r
        where r.tenant_id = $1
        order by r.created_at desc
        limit 2`,
      [TENANT],
    );
    return rows;
  });
  check(
    "回归：运行与明细均已落库",
    regressionAudit.length === 2 && regressionAudit.every((row) => row.items === row.total),
    JSON.stringify(regressionAudit),
  );

  // 21. 建卡幂等：同一文档反复「保存为待确认卡片」只更新同一张草稿
  const firstSave = await createManualCard(bossContext, {
    kind: "fact",
    title: "幂等验收卡",
    body: "第一版正文",
    source: "文档：验收标准",
    sourceDocumentId: fx.docA,
  });
  const secondSave = await createManualCard(bossContext, {
    kind: "fact",
    title: "幂等验收卡",
    body: "第二版正文",
    source: "文档：验收标准",
    sourceDocumentId: fx.docA,
  });
  check(
    "建卡幂等：首次新建、再次更新",
    firstSave.created === true && secondSave.created === false,
    JSON.stringify({ first: firstSave.created, second: secondSave.created }),
  );
  check("建卡幂等：复用同一张卡", firstSave.id === secondSave.id, `${firstSave.id} / ${secondSave.id}`);

  const idempotentRows = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select id, body, status from knowledge_cards where tenant_id = $1 and source_document_id = $2",
      [TENANT, fx.docA],
    );
    return rows;
  });
  check("建卡幂等：库里只有一条", idempotentRows.length === 1, `count=${idempotentRows.length}`);
  check("建卡幂等：内容为最后一次保存", idempotentRows[0]?.body === "第二版正文", idempotentRows[0]?.body);

  // 22. 已确认的卡不被后续草稿覆盖（避免已采纳知识被悄悄替换）
  await withClient(OWNER_URL, (owner) =>
    owner.query("update knowledge_cards set status = 'confirmed' where id = $1", [firstSave.id]),
  );
  const thirdSave = await createManualCard(bossContext, {
    kind: "fact",
    title: "幂等验收卡",
    body: "第三版正文",
    source: "文档：验收标准",
    sourceDocumentId: fx.docA,
  });
  check("建卡幂等：已确认卡跳过覆盖", thirdSave.skipped === "confirmed", JSON.stringify(thirdSave));

  const keptBody = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query("select body from knowledge_cards where id = $1", [firstSave.id]);
    return rows[0]?.body;
  });
  check("建卡幂等：已确认内容保持不变", keptBody === "第二版正文", keptBody);

  // 23. 卡片共享开关：本部门可开，共享后跨部门可读，非本部门不可改
  await setCardVisibility(bossContext, fx.cardHuman, true);
  const sharedReadable = await runAs(memberB, (client) =>
    client.query("select id, visibility from knowledge_cards where id = $1", [fx.cardHuman]),
  );
  check("卡片共享：共享后跨部门可读", sharedReadable.rowCount === 1, `rowCount=${sharedReadable.rowCount}`);

  let crossShareBlocked = false;
  try {
    await setCardVisibility(memberB, fx.cardHuman, false);
  } catch {
    crossShareBlocked = true;
  }
  check("卡片共享：非本部门不可改", crossShareBlocked);

  await setCardVisibility(bossContext, fx.cardHuman, false);
  const afterRevoke = await runAs(memberB, (client) =>
    client.query("select id from knowledge_cards where id = $1", [fx.cardHuman]),
  );
  check("卡片共享：收回后跨部门不可见", afterRevoke.rowCount === 0, `rowCount=${afterRevoke.rowCount}`);

  // 24. 软删进 99-回收站：退出检索、树中移位、可恢复
  const beforeTrash = await runAs(memberA, (client) =>
    client.query("select * from app.hybrid_search($1, null, 10, 60)", ["迁移量"]),
  );
  check(
    "软删前：关键词召回含该文档切片",
    beforeTrash.rows.some((row) => row.document_id === fx.docA),
    `hits=${beforeTrash.rows.map((row) => row.document_id).join(",")}`,
  );

  await trashDocument(bossContext, fx.docA);

  const afterTrash = await runAs(memberA, (client) =>
    client.query("select * from app.hybrid_search($1, null, 10, 60)", ["迁移量"]),
  );
  check(
    "软删后：关键词召回不再含该文档",
    !afterTrash.rows.some((row) => row.document_id === fx.docA),
    `hits=${afterTrash.rows.map((row) => row.document_id).join(",")}`,
  );

  const trashedTree = await loadWorkspaceTree(bossContext);
  const folders = [
    ...trashedTree.shared.folders,
    ...trashedTree.departments.flatMap((department) => [
      ...department.folders,
      ...department.roles.flatMap((role) => role.folders),
    ]),
  ];
  const trashIds = folders
    .filter((folder) => folder.key === "99-trash")
    .flatMap((folder) => folder.items.map((item) => item.id));
  const liveIds = folders
    .filter((folder) => folder.key !== "99-trash")
    .flatMap((folder) => folder.items.map((item) => item.id));
  check("软删后：树中移入 99-回收站", trashIds.includes(fx.docA), `trash=${trashIds.join(",")}`);
  check("软删后：原目录不再出现", !liveIds.includes(fx.docA), `live=${liveIds.join(",")}`);

  await restoreDocument(bossContext, fx.docA);

  const afterRestore = await runAs(memberA, (client) =>
    client.query("select * from app.hybrid_search($1, null, 10, 60)", ["迁移量"]),
  );
  check(
    "恢复后：关键词召回重新命中",
    afterRestore.rows.some((row) => row.document_id === fx.docA),
    `hits=${afterRestore.rows.map((row) => row.document_id).join(",")}`,
  );

  if (process.env.KEEP_KB_FIXTURES !== "1") {
    await withClient(OWNER_URL, cleanup);
  }

  console.log(`\n[KNOWLEDGE] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(JSON.stringify({ level: "error", msg: "knowledge_test_failed", error: String(error) }));
  process.exit(1);
});
