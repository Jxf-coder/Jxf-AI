/**
 * M2-A3 知识库验收：RLS 隔离、sha256 去重、批次撤回、确认门槛、混合检索降级。
 *
 * 使用真实 PostgreSQL + jxf_app 角色；所有写入走 owner 连接播种（owner 绕过 RLS），
 * 断言全部通过应用角色 + SET LOCAL 身份执行，确保测的是策略而不是超管权限。
 *
 * 运行：npm run test:knowledge
 */
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";

import { chunkPages } from "../src/lib/knowledge/chunk.ts";
import {
  CardConflictError,
  createManualCard,
  listCardVersions,
  patchCards,
  updateCard,
} from "../src/lib/knowledge/cards.ts";
import { addCardEvidence, removeCardEvidence } from "../src/lib/knowledge/card-evidence.ts";
import { mergeScannedPages, submitOcrText } from "../src/lib/knowledge/ocr.ts";
import { parseDocument } from "../src/lib/knowledge/parse.ts";
import { reviewShare, setShareState } from "../src/lib/knowledge/share.ts";
import { resolveUploadTarget } from "../src/lib/knowledge/upload-target.ts";
import { verifyQuoteInChunk } from "../src/lib/knowledge/evidence.ts";
import { answerQuestion } from "../src/lib/knowledge/qa.ts";
import { runRegression, seedRegressionQuestions } from "../src/lib/knowledge/regression.ts";
import {
  emptyTrash,
  purgeCard,
  purgeDocument,
  restoreCard,
  restoreDocument,
  trashDocument,
} from "../src/lib/knowledge/trash.ts";
import { loadWorkspaceTree, searchWorkspace, setCardVisibility } from "../src/lib/knowledge/workspace.ts";
import { ingestUpload, maxFileBytes } from "../src/lib/knowledge/ingest.ts";
import { enqueueExperience } from "../src/lib/knowledge/experience/capture.ts";

const TENANT = process.env.KB_TEST_TENANT ?? "22222222-2222-4222-8222-222222222222";
const HOST = process.env.SEED_DB_HOST ?? "127.0.0.1";
const PORT = process.env.SEED_DB_PORT ?? process.env.POSTGRES_PORT ?? "5432";
const DB = process.env.POSTGRES_DB;
const OWNER_URL = `postgresql://${process.env.JXF_OWNER_USER}:${process.env.JXF_OWNER_PASSWORD}@${HOST}:${PORT}/${DB}`;
const APP_URL = `postgresql://${process.env.JXF_APP_USER}:${process.env.JXF_APP_PASSWORD}@${HOST}:${PORT}/${DB}`;

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`[PASS] ${name}`);
  } else {
    failed += 1;
    console.error(`[FAIL] ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

/** 语义门禁只在配置了 embedding Key 时执行；缺失时跳过而不是判失败 */
async function embedWithGemini(text) {
  const base = (process.env.JXF_EMBEDDING_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const model = process.env.JXF_EMBEDDING_MODEL ?? "";
  const dim = Number.parseInt(process.env.JXF_EMBEDDING_DIM ?? "1024", 10);
  const response = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.JXF_EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({ model, input: [text], dimensions: dim }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`embedding HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const payload = await response.json();
  return payload.data[0].embedding;
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
  await owner.query("delete from experience_jobs where tenant_id = $1", [TENANT]);
  await owner.query("delete from experience_policies where tenant_id = $1", [TENANT]);
  await owner.query("delete from experience_channel_policies where tenant_id = $1", [TENANT]);
  await owner.query("delete from folder_route_stats_daily where tenant_id = $1", [TENANT]);
  await owner.query("delete from folder_route_feedback where tenant_id = $1", [TENANT]);
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

    // 跨部门共享卡：用于验证 hybrid_search_cards 的 shared 分支
    const sharedCard = await owner.query(
      `insert into knowledge_cards
         (tenant_id, department_id, kind, title, body, status, origin, human_edited, conflict_with, visibility)
       values ($1, $2, 'fact', '全公司共享的预约口径', '共享给全公司的预约口径，跨部门问答也应召回。', 'confirmed', 'manual', true, '{}', 'shared')
       returning id`,
      [TENANT, groupB.rows[0].id],
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
      cardSharedB: sharedCard.rows[0].id,
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
    client.query("select id from knowledge_cards where department_id = $1 and visibility <> 'shared'", [
      fx.departments.groupB,
    ]),
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

  // 12a. 共享卡跨部门召回：visibility='shared' 的卡必须被问答召回
  const sharedCardHits = await runAs(memberA, (client) =>
    client.query("select * from app.hybrid_search_cards($1, null, 10, 60, $2::text[])", [
      "共享的预约口径",
      ["02-cards"],
    ]),
  );
  check(
    "共享卡跨部门可被问答召回",
    sharedCardHits.rows.some((row) => row.card_id === fx.cardSharedB),
    `ids=${sharedCardHits.rows.map((row) => row.card_id).join(",")}`,
  );

  // 12b. 目录白名单：事实问答排除 05/08，经验通道只取 05
  const factFolderHits = await runAs(memberA, (client) =>
    client.query("select * from app.hybrid_search_cards($1, null, 10, 60, $2::text[])", [
      "迁移量",
      ["02-cards", "03-standards", "04-cases", "06-templates", "07-training"],
    ]),
  );
  check(
    "事实问答目录白名单召回普通卡片",
    factFolderHits.rows.some((row) => row.card_id === fx.cardConfirmed),
    `ids=${factFolderHits.rows.map((row) => row.card_id).join(",")}`,
  );
  const experienceFolderHits = await runAs(memberA, (client) =>
    client.query("select * from app.hybrid_search_cards($1, null, 10, 60, $2::text[])", [
      "迁移量",
      ["05-distill"],
    ]),
  );
  check(
    "经验目录白名单不召回普通卡片",
    !experienceFolderHits.rows.some((row) => row.card_id === fx.cardConfirmed),
    `ids=${experienceFolderHits.rows.map((row) => row.card_id).join(",")}`,
  );

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

  const employeeDraftForBoss = await runAs(boss, (client) =>
    client.query("select id from ai_employees where id = $1", [employeeByL1.rows[0].id]),
  );
  check(
    "AI 员工：L1 可见自己的草稿",
    employeeDraftForBoss.rowCount === 1,
    `rowCount=${employeeDraftForBoss.rowCount}`,
  );

  const employeeVisible = await runAs(memberB, (client) =>
    client.query("select id from ai_employees where tenant_id = $1", [TENANT]),
  );
  check(
    "AI 员工：未授权部门 0 行（Fail-Closed）",
    employeeVisible.rowCount === 0,
    `rowCount=${employeeVisible.rowCount}`,
  );

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

  // 23b. 目录预填隔离：L1 任意，L2/普通成员只能本部门；共享区需 L1 审批
  const leadAContext = {
    userId: fx.uid["a2@kb.test"],
    tenantId: TENANT,
    activeMembership: null,
    activeMemberships: [],
    activeMembershipId: fx.membershipOf("a2@kb.test"),
    activeDepartmentId: fx.departments.groupA,
    activeDepartmentName: "知识库一组",
    membershipDepartmentIds: [fx.departments.groupA],
    departmentIds: [fx.departments.groupA],
    subtreeDepartmentIds: [fx.departments.groupA, fx.departments.teamA1],
    accessLevel: "L2",
    permissionVersion: 0,
    requestId: "kb-test",
  };

  const crossPrefill = await resolveUploadTarget(leadAContext, {
    dept: fx.departments.groupB,
    folder: "03-standards",
  });
  check(
    "目录预填：L2 跨部门被拦截",
    crossPrefill.ok === false && crossPrefill.message.includes("无权限"),
    JSON.stringify(crossPrefill),
  );

  const ownPrefill = await resolveUploadTarget(leadAContext, {
    dept: fx.departments.groupA,
    folder: "03-standards",
  });
  check(
    "目录预填：本部门空目录也可选中",
    ownPrefill.ok === true &&
      ownPrefill.folderKey === "03-standards" &&
      ownPrefill.needsApproval === false,
    JSON.stringify(ownPrefill),
  );

  const sharedPrefill = await resolveUploadTarget(leadAContext, {
    folder: "04-cases",
    scope: "shared",
  });
  check(
    "目录预填：共享区需要 L1 审批",
    sharedPrefill.ok === true && sharedPrefill.isShared === true && sharedPrefill.needsApproval === true,
    JSON.stringify(sharedPrefill),
  );

  const l1Prefill = await resolveUploadTarget(bossContext, {
    dept: fx.departments.groupB,
    folder: "03-standards",
  });
  check(
    "目录预填：L1 可跨部门选择",
    l1Prefill.ok === true && l1Prefill.departmentId === fx.departments.groupB,
    JSON.stringify(l1Prefill),
  );

  const fakeRolePrefill = await resolveUploadTarget(leadAContext, {
    dept: fx.departments.groupA,
    role: "不存在的岗位",
  });
  check(
    "目录预填：虚构岗位被拒绝",
    fakeRolePrefill.ok === false,
    JSON.stringify(fakeRolePrefill),
  );

  await withClient(OWNER_URL, async (owner) => {
    await owner.query(`update memberships set position = '一组经理' where id = $1`, [
      fx.membershipOf("a2@kb.test"),
    ]);
  });
  const rolePrefill = await resolveUploadTarget(leadAContext, {
    dept: fx.departments.groupA,
    role: "一组经理",
  });
  check(
    "目录预填：在职岗位可预填",
    rolePrefill.ok === true && rolePrefill.roleKey === "一组经理",
    JSON.stringify(rolePrefill),
  );

  // 23b. 卡片归档：人工建卡按语义路由，文档来源继承目录，批量可改目录
  const caseCard = await createManualCard(bossContext, {
    kind: "case",
    title: "制造业客户交付纪要",
    body: "为制造业客户完成质检流程改造，覆盖排产与验收。",
  });
  const templateCard = await createManualCard(bossContext, {
    kind: "fact",
    title: "报价模板字段说明",
    body: "模板包含单价、税率与交付周期三栏。",
  });
  const plainCard = await createManualCard(bossContext, {
    kind: "fact",
    title: "日常答复口径",
    body: "统一使用简体中文答复。",
  });

  const casesDoc = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      `insert into documents (tenant_id, department_id, title, mime, sha256, folder_key)
       values ($1, $2, '交付说明文档', 'text/plain', $3, '04-cases') returning id`,
      [TENANT, fx.departments.groupA, "5".repeat(64)],
    );
    return rows[0].id;
  });
  const inheritedCard = await createManualCard(bossContext, {
    kind: "fact",
    title: "交付说明卡",
    body: "从来源文档提炼的要点。",
    sourceDocumentId: casesDoc,
  });

  const archived = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select id, folder_key, route_pending from knowledge_cards where id = any($1::uuid[])",
      [[caseCard.id, templateCard.id, plainCard.id, inheritedCard.id]],
    );
    return Object.fromEntries(rows.map((row) => [row.id, row]));
  });
  check(
    "归档：case 卡自动归 04-案例库",
    archived[caseCard.id]?.folder_key === "04-cases" && archived[caseCard.id]?.route_pending === false,
    JSON.stringify(archived[caseCard.id]),
  );
  check(
    "归档：模板卡自动归 06-模板工具",
    archived[templateCard.id]?.folder_key === "06-templates",
    JSON.stringify(archived[templateCard.id]),
  );
  check(
    "归档：无信号卡留在 02-知识卡片",
    archived[plainCard.id]?.folder_key === "02-cards",
    JSON.stringify(archived[plainCard.id]),
  );
  check(
    "归档：文档生成卡片继承文档目录",
    archived[inheritedCard.id]?.folder_key === "04-cases",
    JSON.stringify(archived[inheritedCard.id]),
  );

  const bulkFolder = await patchCards(bossContext, [plainCard.id], { folderKey: "03-standards" });
  const bulkFolderRow = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select folder_key, route_pending from knowledge_cards where id = $1",
      [plainCard.id],
    );
    return rows[0];
  });
  check(
    "归档：批量改目录生效并清除 route_pending",
    bulkFolder.patched === 1 && bulkFolderRow.folder_key === "03-standards" && bulkFolderRow.route_pending === false,
    JSON.stringify({ bulkFolder, bulkFolderRow }),
  );

  // 23c. 公司共享审批：申请期间保持部门隔离，L1 通过后才开放
  const shareRequested = await setShareState(leadAContext, "card", fx.cardHuman, true);
  check(
    "共享审批：L2 申请后进入待审批",
    shareRequested.pending === true && shareRequested.shared === false,
    JSON.stringify(shareRequested),
  );

  const pendingShareRow = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select visibility, share_status, share_requested_by from knowledge_cards where id = $1",
      [fx.cardHuman],
    );
    return rows[0];
  });
  check(
    "共享审批：通过前保持部门隔离",
    pendingShareRow.visibility === "department" && pendingShareRow.share_status === "pending_approval",
    JSON.stringify(pendingShareRow),
  );
  check(
    "共享审批：记录申请人",
    pendingShareRow.share_requested_by === fx.uid["a2@kb.test"],
    String(pendingShareRow.share_requested_by),
  );

  const pendingCrossRead = await runAs(memberB, (client) =>
    client.query("select id from knowledge_cards where id = $1", [fx.cardHuman]),
  );
  check("共享审批：通过前兄弟部门不可读", pendingCrossRead.rowCount === 0, `rowCount=${pendingCrossRead.rowCount}`);

  let crossReviewBlocked = false;
  try {
    await reviewShare(leadAContext, "card", fx.cardHuman, true);
  } catch {
    crossReviewBlocked = true;
  }
  check("共享审批：非 L1 不得审批", crossReviewBlocked);

  const approvedShare = await reviewShare(bossContext, "card", fx.cardHuman, true);
  check("共享审批：L1 通过后进入共享", approvedShare.shared === true, JSON.stringify(approvedShare));

  const approvedShareRow = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select visibility, share_status, share_reviewed_by from knowledge_cards where id = $1",
      [fx.cardHuman],
    );
    return rows[0];
  });
  check(
    "共享审批：通过后 visibility=shared 并记录审批人",
    approvedShareRow.visibility === "shared" &&
      approvedShareRow.share_status === "approved" &&
      approvedShareRow.share_reviewed_by === fx.uid["boss@kb.test"],
    JSON.stringify(approvedShareRow),
  );

  const approvedCrossRead = await runAs(memberB, (client) =>
    client.query("select id from knowledge_cards where id = $1", [fx.cardHuman]),
  );
  check("共享审批：通过后兄弟部门可读", approvedCrossRead.rowCount === 1, `rowCount=${approvedCrossRead.rowCount}`);

  // 收回 → 再次申请 → 驳回：仍然回到部门隔离
  await setShareState(bossContext, "card", fx.cardHuman, false);
  await setShareState(leadAContext, "card", fx.cardHuman, true);
  const rejectedShare = await reviewShare(bossContext, "card", fx.cardHuman, false);
  const rejectedRow = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select visibility, share_status from knowledge_cards where id = $1",
      [fx.cardHuman],
    );
    return rows[0];
  });
  check(
    "共享审批：驳回后保持部门隔离",
    rejectedShare.shared === false &&
      rejectedRow.visibility === "department" &&
      rejectedRow.share_status === "rejected",
    JSON.stringify({ rejectedShare, rejectedRow }),
  );
  const rejectedCrossRead = await runAs(memberB, (client) =>
    client.query("select id from knowledge_cards where id = $1", [fx.cardHuman]),
  );
  check("共享审批：驳回后兄弟部门不可读", rejectedCrossRead.rowCount === 0, `rowCount=${rejectedCrossRead.rowCount}`);

  const shareAudit = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      `select action, count(*)::int as count from audit_events
        where tenant_id = $1 and action in
          ('knowledge.share_requested', 'knowledge.share_approved', 'knowledge.share_rejected')
        group by action`,
      [TENANT],
    );
    return Object.fromEntries(rows.map((row) => [row.action, row.count]));
  });
  check(
    "共享审批：申请/通过/驳回均留痕",
    shareAudit["knowledge.share_requested"] >= 2 &&
      shareAudit["knowledge.share_approved"] >= 1 &&
      shareAudit["knowledge.share_rejected"] >= 1,
    JSON.stringify(shareAudit),
  );


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

  // 25. 目录搜索：服务端检索绕开上限，且不跨部门
  // 注意：不能用 resolveUserContext——它读 JXF_TENANT_ID（生产租户），
  // 与验收数据所在的 KB_TEST_TENANT 不同，会被 RLS 全部过滤。
  const memberAContext = {
    userId: fx.uid["a1@kb.test"],
    tenantId: TENANT,
    activeMembership: null,
    activeMemberships: [],
    activeMembershipId: fx.membershipOf("a1@kb.test"),
    activeDepartmentId: fx.departments.groupA,
    activeDepartmentName: "知识库一组",
    membershipDepartmentIds: [fx.departments.groupA],
    departmentIds: [fx.departments.groupA],
    subtreeDepartmentIds: [fx.departments.groupA, fx.departments.teamA1],
    accessLevel: "L3",
    permissionVersion: 0,
    requestId: "kb-test",
  };
  const foundDocs = await searchWorkspace(memberAContext, "验收");
  check(
    "目录搜索：命中本部门文档",
    foundDocs.some((item) => item.id === fx.docA),
    `hits=${foundDocs.map((item) => item.id).join(",")}`,
  );
  const crossSearch = await searchWorkspace(memberAContext, "二组预算");
  check(
    "目录搜索：不返回兄弟部门条目",
    !crossSearch.some((item) => item.id === fx.docB),
    `hits=${crossSearch.map((item) => item.id).join(",")}`,
  );
  check("目录树：未达上限时不提示截断", trashedTree.totals.truncated === false);

  // 25b. 并发编辑：乐观锁拒绝静默覆盖，版本历史逐次留痕
  const concurrencyDoc = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      `insert into documents (tenant_id, department_id, title, mime, sha256)
       values ($1, $2, '并发验收文档', 'text/plain', $3) returning id`,
      [TENANT, fx.departments.groupA, "4".repeat(64)],
    );
    return rows[0].id;
  });

  const firstWrite = await createManualCard(bossContext, {
    kind: "fact",
    title: "并发验收卡",
    body: "第一版正文",
    sourceDocumentId: concurrencyDoc,
    expectedRev: 0,
  });
  check(
    "乐观锁：以 rev 0 建卡得到 v1",
    firstWrite.created === true && firstWrite.rev === 1,
    JSON.stringify(firstWrite),
  );

  const secondWrite = await createManualCard(bossContext, {
    kind: "fact",
    title: "并发验收卡",
    body: "第二版正文",
    sourceDocumentId: concurrencyDoc,
    expectedRev: 1,
  });
  check(
    "乐观锁：基线匹配时更新并推进版本",
    secondWrite.created === false && secondWrite.rev === 2,
    JSON.stringify(secondWrite),
  );

  let staleCreate = null;
  try {
    await createManualCard(bossContext, {
      kind: "fact",
      title: "并发验收卡",
      body: "第三版（过期）",
      sourceDocumentId: concurrencyDoc,
      expectedRev: 1,
    });
  } catch (error) {
    staleCreate = error;
  }
  check("乐观锁：过期基线的保存被拒绝", staleCreate instanceof CardConflictError, String(staleCreate));
  check(
    "乐观锁：冲突返回最新版本内容",
    staleCreate?.current?.rev === 2 && staleCreate.current.body === "第二版正文",
    JSON.stringify(staleCreate?.current),
  );

  const staleBody = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select body, rev from knowledge_cards where source_document_id = $1",
      [concurrencyDoc],
    );
    return rows[0];
  });
  check(
    "乐观锁：冲突时不写入任何内容",
    staleBody?.body === "第二版正文" && staleBody?.rev === 2,
    JSON.stringify(staleBody),
  );

  const editableCard = await createManualCard(bossContext, {
    kind: "fact",
    title: "版本验收卡",
    body: "初版正文",
  });
  const editOnce = await updateCard(
    bossContext,
    editableCard.id,
    { title: "版本验收卡", body: "第二稿" },
    { expectedRev: editableCard.rev },
  );
  check("版本历史：保存推进到 v2", editOnce.rev === editableCard.rev + 1, JSON.stringify(editOnce));

  let staleEdit = null;
  try {
    await updateCard(
      bossContext,
      editableCard.id,
      { title: "版本验收卡", body: "过期覆盖" },
      { expectedRev: editableCard.rev },
    );
  } catch (error) {
    staleEdit = error;
  }
  check(
    "版本历史：过期基线编辑被拒绝",
    staleEdit instanceof CardConflictError && staleEdit.current.rev === editOnce.rev,
    String(staleEdit),
  );

  const versions = await listCardVersions(bossContext, editableCard.id, 10);
  check(
    "版本历史：每次保存都留痕",
    versions.length === 2 && versions[0].rev === 2 && versions[1].rev === 1,
    JSON.stringify(versions.map((version) => version.rev)),
  );
  check(
    "版本历史：记录编辑人与内容",
    versions[0].editedByName === "知识库 L1" && versions[0].body === "第二稿",
    JSON.stringify(versions[0]),
  );

  const crossVersions = await runAs(memberB, (client) =>
    client.query("select count(*)::int as count from knowledge_card_versions where card_id = $1", [
      editableCard.id,
    ]),
  );
  check(
    "版本历史：兄弟部门不可见",
    crossVersions.rows[0]?.count === 0,
    `count=${crossVersions.rows[0]?.count}`,
  );

  // 25c. 证据链编辑：逐字命中才落库，跨部门不可写
  const addedEvidence = await addCardEvidence(bossContext, fx.cardBare, {
    chunkId: fx.chunkA,
    quote: "迁移量应当符合国家标准限值要求",
  });
  check("证据链：逐字命中后落库并标记已核对", addedEvidence.verified === true, JSON.stringify(addedEvidence));
  check(
    "证据链：记录来源文档与页码",
    addedEvidence.documentId === fx.docA && addedEvidence.pageNo === 1,
    JSON.stringify(addedEvidence),
  );

  const evidenceRows = await runAs(memberA, (client) =>
    client.query("select id, verified, quote from card_evidence where card_id = $1", [fx.cardBare]),
  );
  check(
    "证据链：同部门可读已挂证据",
    evidenceRows.rowCount === 1 && evidenceRows.rows[0].verified === true,
    `rows=${evidenceRows.rowCount}`,
  );

  let badQuoteRejected = false;
  try {
    await addCardEvidence(bossContext, fx.cardBare, {
      chunkId: fx.chunkA,
      quote: "这句话在原文里根本不存在",
    });
  } catch {
    badQuoteRejected = true;
  }
  check("证据链：对不上原文的引文被拒绝", badQuoteRejected);

  const afterBadQuote = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select count(*)::int as count from card_evidence where card_id = $1",
      [fx.cardBare],
    );
    return rows[0].count;
  });
  check("证据链：拒绝时不产生脏数据", afterBadQuote === 1, `count=${afterBadQuote}`);

  let crossEvidenceBlocked = false;
  try {
    await addCardEvidence(memberB, fx.cardBare, {
      chunkId: fx.chunkA,
      quote: "迁移量应当符合国家标准限值要求",
    });
  } catch {
    crossEvidenceBlocked = true;
  }
  check("证据链：兄弟部门不可写", crossEvidenceBlocked);

  await removeCardEvidence(bossContext, addedEvidence.id);
  const afterEvidenceRemove = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      "select count(*)::int as count from card_evidence where card_id = $1",
      [fx.cardBare],
    );
    return rows[0].count;
  });
  check("证据链：移除后行已消失", afterEvidenceRemove === 0, `count=${afterEvidenceRemove}`);

  // 25d. 中文同义改写召回：关键词完全不重叠，命中必须来自向量通道
  const semanticText = "差旅费用应在返回后十个工作日内报销。";
  if (!process.env.JXF_EMBEDDING_API_KEY) {
    skipped += 1;
    console.log("[SKIP] 同义改写召回：未配置 JXF_EMBEDDING_API_KEY");
  } else {
    const semanticDoc = await withClient(OWNER_URL, async (owner) => {
      const { rows } = await owner.query(
        `insert into documents (tenant_id, department_id, title, mime, sha256)
         values ($1, $2, '语义召回验收文档', 'text/plain', $3) returning id`,
        [TENANT, fx.departments.groupA, "5".repeat(64)],
      );
      const docId = rows[0].id;
      await owner.query(
        `insert into doc_chunks
           (tenant_id, department_id, document_id, ord, page_no, char_start, char_end, text)
         values ($1, $2, $3, 0, 1, 0, $4, $5)`,
        [TENANT, fx.departments.groupA, docId, semanticText.length, semanticText],
      );
      const vector = await embedWithGemini(semanticText);
      await owner.query("update doc_chunks set embedding = $1::vector where document_id = $2", [
        `[${vector.join(",")}]`,
        docId,
      ]);
      return docId;
    });

    const paraphrase = "出差回来多久能把花销报掉";
    const queryVector = await embedWithGemini(paraphrase);

    const keywordOnly = await runAs(memberA, (client) =>
      client.query("select document_id, vector_rank from app.hybrid_search($1, null, 10, 60)", [
        paraphrase,
      ]),
    );
    check(
      "同义改写：纯关键词对改写句不命中",
      !keywordOnly.rows.some((row) => row.document_id === semanticDoc),
      `hits=${keywordOnly.rows.map((row) => row.document_id).join(",")}`,
    );

    const hybrid = await runAs(memberA, (client) =>
      client.query("select document_id, vector_rank from app.hybrid_search($1, $2::vector, 10, 60)", [
        paraphrase,
        `[${queryVector.join(",")}]`,
      ]),
    );
    const semanticHit = hybrid.rows.find((row) => row.document_id === semanticDoc);
    check(
      "同义改写：向量召回命中语义等价切片",
      Boolean(semanticHit),
      `hits=${hybrid.rows.map((row) => row.document_id).join(",")}`,
    );
    check(
      "同义改写：命中来自向量通道",
      semanticHit?.vector_rank !== null && semanticHit?.vector_rank !== undefined,
      JSON.stringify(semanticHit),
    );
  }

  // 25e. OCR 补录：扫描件补录后重建切片、立即可检索、已解析不可覆盖
  const ocrDoc = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      `insert into documents (tenant_id, department_id, title, mime, page_count, char_count, status, sha256)
       values ($1, $2, '扫描件验收样本', 'application/pdf', 2, 0, 'needs_ocr', $3) returning id`,
      [TENANT, fx.departments.groupA, "6".repeat(64)],
    );
    return rows[0].id;
  });

  const ocrText =
    "【第 1 页】\n设备点检必须在开机前完成，并记录压力值。\n【第 2 页】\n点检记录保存三年，异常需当天上报。";
  const ocrResult = await submitOcrText(bossContext, ocrDoc, { text: ocrText });
  check(
    "OCR 补录：按标记切出两页",
    ocrResult.pages === 2 && ocrResult.chunks >= 2,
    JSON.stringify(ocrResult),
  );

  const ocrState = await withClient(OWNER_URL, async (owner) => {
    const doc = await owner.query(
      "select status, char_count, page_count from documents where id = $1",
      [ocrDoc],
    );
    const chunks = await owner.query(
      "select page_no from doc_chunks where document_id = $1 order by ord",
      [ocrDoc],
    );
    return { doc: doc.rows[0], pages: chunks.rows.map((row) => row.page_no) };
  });
  check(
    "OCR 补录：文档转为已解析",
    ocrState.doc?.status === "parsed" && ocrState.doc.char_count > 0,
    JSON.stringify(ocrState.doc),
  );
  check(
    "OCR 补录：切片页码与标记一致",
    ocrState.pages.includes(1) && ocrState.pages.includes(2),
    JSON.stringify(ocrState.pages),
  );

  const ocrRecall = await runAs(memberA, (client) =>
    client.query("select document_id from app.hybrid_search($1, null, 10, 60)", ["点检记录保存三年"]),
  );
  check(
    "OCR 补录：补录正文立即可检索",
    ocrRecall.rows.some((row) => row.document_id === ocrDoc),
    `hits=${ocrRecall.rows.map((row) => row.document_id).join(",")}`,
  );

  let ocrCrossBlocked = false;
  try {
    await submitOcrText(memberB, ocrDoc, { text: "越权补录" });
  } catch {
    ocrCrossBlocked = true;
  }
  check("OCR 补录：兄弟部门不可写", ocrCrossBlocked);

  let ocrEmptyRejected = false;
  try {
    await submitOcrText(bossContext, ocrDoc, { text: "   " });
  } catch {
    ocrEmptyRejected = true;
  }
  check("OCR 补录：空正文被拒绝", ocrEmptyRejected);

  let ocrParsedGuard = false;
  try {
    await submitOcrText(bossContext, ocrDoc, { text: "重复补录会覆盖切片" });
  } catch {
    ocrParsedGuard = true;
  }
  check("OCR 补录：已解析文档不可覆盖", ocrParsedGuard);

  const ocrAudit = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      `select count(*)::int as count from audit_events
        where tenant_id = $1 and action = 'knowledge.document_ocr_completed' and target_id = $2`,
      [TENANT, ocrDoc],
    );
    return rows[0].count;
  });
  check("OCR 补录：审计已落库", ocrAudit === 1, `count=${ocrAudit}`);

  // 25f. 自动 OCR：图片解析与「识别结果 / 回落待补录」的入库决策（纯函数，不依赖外网）
  const parsedImage = await parseDocument(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png", "scan.png");
  check(
    "自动 OCR：图片不产生文本层，交给识别通道",
    parsedImage.pages.length === 0 && parsedImage.hasText === false,
    JSON.stringify(parsedImage),
  );

  const mergedNative = mergeScannedPages(
    { pages: ["原生文本层正文"], hasText: true },
    { text: "【第 1 页】\n模型改写后的正文", model: "gemini-test" },
  );
  check(
    "自动 OCR：有文本层时不采用识别结果",
    mergedNative.pages.length === 1 &&
      mergedNative.pages[0] === "原生文本层正文" &&
      mergedNative.ocrModel === null,
    JSON.stringify(mergedNative),
  );

  const mergedScan = mergeScannedPages(
    { pages: [], hasText: false },
    {
      text: "【第 1 页】\n设备点检必须在开机前完成。\n【第 2 页】\n点检记录保存三年。",
      model: "gemini-test",
    },
  );
  check(
    "自动 OCR：识别成功后按页入库并记录模型",
    mergedScan.pages.length === 2 && mergedScan.ocrModel === "gemini-test",
    JSON.stringify(mergedScan),
  );

  const mergedFailed = mergeScannedPages({ pages: [], hasText: false }, null);
  check(
    "自动 OCR：识别失败回落待补录（不生成正文）",
    mergedFailed.pages.length === 0 && mergedFailed.ocrModel === null,
    JSON.stringify(mergedFailed),
  );

  const mergedEmpty = mergeScannedPages(
    { pages: [], hasText: false },
    { text: "   ", model: "gemini-test" },
  );
  check(
    "自动 OCR：识别结果为空不写入正文",
    mergedEmpty.pages.length === 0 && mergedEmpty.ocrModel === null,
    JSON.stringify(mergedEmpty),
  );

  const mergedSingle = mergeScannedPages(
    { pages: [], hasText: false },
    { text: "没有分页标记的整篇正文", model: "gemini-test" },
  );
  check(
    "自动 OCR：无分页标记时整篇记一页",
    mergedSingle.pages.length === 1 && mergedSingle.ocrModel === "gemini-test",
    JSON.stringify(mergedSingle),
  );

  const ocrColumn = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      `select data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'ingest_files' and column_name = 'ocr_model'`,
    );
    return rows[0]?.data_type ?? "";
  });
  check("自动 OCR：批次明细可记录识别模型", ocrColumn === "text", `type=${ocrColumn || "missing"}`);

  // 26. 卡片回收站：作废进 99-回收站、可恢复、可彻底删除
  const collectTrashIds = (workspace) =>
    [
      ...workspace.shared.folders,
      ...workspace.departments.flatMap((department) => [
        ...department.folders,
        ...department.roles.flatMap((role) => role.folders),
      ]),
    ]
      .filter((folder) => folder.key === "99-trash")
      .flatMap((folder) => folder.items.map((item) => item.id));

  await withClient(OWNER_URL, (owner) =>
    owner.query("update knowledge_cards set status = 'dropped' where id = $1", [fx.cardBare]),
  );
  const cardTrashTree = await loadWorkspaceTree(bossContext);
  check(
    "卡片作废：进入 99-回收站",
    collectTrashIds(cardTrashTree).includes(fx.cardBare),
    `trash=${collectTrashIds(cardTrashTree).join(",")}`,
  );

  await restoreCard(bossContext, fx.cardBare);
  const restoredCardStatus = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query("select status from knowledge_cards where id = $1", [
      fx.cardBare,
    ]);
    return rows[0]?.status;
  });
  check("卡片恢复：回到待确认", restoredCardStatus === "pending", restoredCardStatus);

  await withClient(OWNER_URL, (owner) =>
    owner.query("update knowledge_cards set status = 'dropped' where id = $1", [fx.cardBare]),
  );
  await purgeCard(bossContext, fx.cardBare);
  const purgedCardRows = await withClient(OWNER_URL, async (owner) => {
    const { rowCount } = await owner.query("select 1 from knowledge_cards where id = $1", [fx.cardBare]);
    return rowCount;
  });
  check("卡片彻底删除：行已消失", purgedCardRows === 0, `rows=${purgedCardRows}`);

  // 27. 文档彻底删除与清空回收站
  await trashDocument(bossContext, fx.docA);
  await purgeDocument(bossContext, fx.docA);
  const purgedDocRows = await withClient(OWNER_URL, async (owner) => {
    const { rowCount } = await owner.query("select 1 from documents where id = $1", [fx.docA]);
    return rowCount;
  });
  check("文档彻底删除：行已消失", purgedDocRows === 0, `rows=${purgedDocRows}`);

  await withClient(OWNER_URL, (owner) =>
    owner.query("update documents set deleted_at = now() where id = $1", [fx.docRevoked]),
  );
  await withClient(OWNER_URL, (owner) =>
    owner.query("update knowledge_cards set status = 'dropped' where id = $1", [fx.cardHuman]),
  );
  const emptied = await emptyTrash(bossContext, fx.departments.groupA);
  check(
    "清空回收站：文档与卡片一并删除",
    emptied.documents >= 1 && emptied.cards >= 1,
    JSON.stringify(emptied),
  );

  // 28. 入库格式与大小上限：.doc 可解析可入库，超限如实跳过
  const docFixturePath = path.join(process.cwd(), "scripts", "fixtures", "knowledge-sample.doc");
  const docBytes = new Uint8Array(await readFile(docFixturePath));
  const parsedDoc = await parseDocument(docBytes, "application/msword", "knowledge-sample.doc");
  check(
    "DOC 解析：旧二进制格式取到正文",
    parsedDoc.hasText && parsedDoc.pages.length === 1 && parsedDoc.pages[0].includes("耐候等级"),
    JSON.stringify({ pages: parsedDoc.pages.length, hasText: parsedDoc.hasText }),
  );

  const docIngest = await ingestUpload(
    bossContext,
    [{ name: "knowledge-sample.doc", mime: "application/msword", bytes: docBytes }],
    "doc 解析回归",
  );
  check(
    "DOC 入库：扩展名在白名单内并切出切片",
    docIngest.files[0]?.decision === "rule_keep" && (docIngest.files[0]?.chunkCount ?? 0) >= 1,
    JSON.stringify(docIngest.files[0] ?? {}),
  );

  const sizeLimit = maxFileBytes();
  check(
    "大小上限：生效值来自 env 且不低于 50MB",
    sizeLimit === Number(process.env.JXF_KNOWLEDGE_MAX_FILE_BYTES ?? 50 * 1024 * 1024) &&
      sizeLimit >= 50 * 1024 * 1024,
    `limit=${sizeLimit}`,
  );

  const oversized = await ingestUpload(
    bossContext,
    [{ name: "too-large.pdf", mime: "application/pdf", bytes: new Uint8Array(sizeLimit + 1) }],
    "上限回归",
  );
  check(
    "大小上限：超限文件被跳过并提示压缩或拆分",
    oversized.files[0]?.decision === "rule_skip" &&
      /超过.*请压缩或拆分/.test(oversized.files[0]?.reason ?? ""),
    JSON.stringify(oversized.files[0] ?? {}),
  );

  // 入库会写 public/uploads：清掉本次测试产生的原件，避免污染工作区
  const uploadedKeys = await withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query("select storage_key from assets where tenant_id = $1", [TENANT]);
    return rows.map((row) => row.storage_key);
  });
  for (const key of uploadedKeys) {
    if (typeof key === "string" && key.startsWith("uploads/")) {
      await unlink(path.join(process.cwd(), "public", key)).catch(() => {});
    }
  }

  // 29. 目录纠偏日聚合：只能由重算函数写、只对 L1 可见
  await withClient(OWNER_URL, async (owner) => {
    await owner.query("delete from folder_route_stats_daily where tenant_id = $1", [TENANT]);
    await owner.query("delete from folder_route_feedback where tenant_id = $1", [TENANT]);
    await owner.query(
      `insert into folder_route_feedback
         (tenant_id, department_id, card_id, channel, action, suggested_folder, chosen_folder, route_confidence)
       values
         ($1, $2, gen_random_uuid(), 'pipeline', 'accepted', '03-standards', '03-standards', 0.90),
         ($1, $2, gen_random_uuid(), 'pipeline', 'overridden', '03-standards', '04-cases', 0.60),
         ($1, $2, gen_random_uuid(), 'retro', 'overridden', null, '08-retro', 0.40)`,
      [TENANT, fx.departments.groupA],
    );
  });

  const rollup = await runAs(boss, (client) =>
    client.query("select app.rollup_folder_route_stats(30) as rows"),
  );
  check("纠偏统计：重算函数写入聚合行", rollup.rows[0]?.rows === 3, JSON.stringify(rollup.rows[0]));

  const rerollup = await runAs(boss, (client) =>
    client.query("select app.rollup_folder_route_stats(30) as rows"),
  );
  const statsRows = await runAs(boss, (client) =>
    client.query(
      `select action, suggested_folder, chosen_folder, total
         from folder_route_stats_daily
        where tenant_id = $1
        order by action, chosen_folder`,
      [TENANT],
    ),
  );
  check(
    "纠偏统计：重复重算幂等（空建议目录不重复成行）",
    rerollup.rows[0]?.rows === 3 && statsRows.rows.length === 3,
    `rows=${statsRows.rows.length} ${JSON.stringify(statsRows.rows)}`,
  );

  const memberStats = await runAs(memberA, (client) =>
    client.query("select count(*)::int as count from folder_route_stats_daily"),
  );
  check("纠偏统计：非 L1 读不到聚合行", memberStats.rows[0].count === 0, `count=${memberStats.rows[0].count}`);

  let rollupDenied = false;
  try {
    await runAs(memberA, (client) => client.query("select app.rollup_folder_route_stats(30)"));
  } catch {
    rollupDenied = true;
  }
  check("纠偏统计：非 L1 不能重算", rollupDenied);

  // 30. 经验沉淀策略：默认值、L1 可写、非 L1 拒绝、越界拒绝、采集按策略生效
  await withClient(OWNER_URL, (owner) =>
    owner.query("delete from experience_policies where tenant_id = $1", [TENANT]),
  );

  const policyDefaults = await runAs(boss, (client) =>
    client.query("select * from app.experience_policy()"),
  );
  check(
    "经验策略：缺行返回默认阈值",
    policyDefaults.rows[0]?.min_source_chars === 200 &&
      policyDefaults.rows[0]?.max_source_chars === 12000 &&
      policyDefaults.rows[0]?.hourly_job_limit === 20 &&
      policyDefaults.rows[0]?.daily_card_limit === 50 &&
      policyDefaults.rows[0]?.max_candidates === 3 &&
      policyDefaults.rows[0]?.cooldown_minutes === 60 &&
      policyDefaults.rows[0]?.dedupe_window_hours === 24 &&
      policyDefaults.rows[0]?.min_signal_level === 1 &&
      policyDefaults.rows[0]?.auto_capture_success === false &&
      policyDefaults.rows[0]?.model_tier === "fast",
    JSON.stringify(policyDefaults.rows[0]),
  );

  await runAs(boss, (client) =>
    client.query(
      "select app.save_experience_policy(120, 6000, 5, 30, 2, 30, 12, 2, true, 'pro')",
    ),
  );
  const policySaved = await runAs(boss, (client) =>
    client.query("select * from app.experience_policy()"),
  );
  check(
    "经验策略：L1 保存后立即生效",
    policySaved.rows[0]?.min_source_chars === 120 &&
      policySaved.rows[0]?.max_source_chars === 6000 &&
      policySaved.rows[0]?.hourly_job_limit === 5 &&
      policySaved.rows[0]?.daily_card_limit === 30 &&
      policySaved.rows[0]?.max_candidates === 2 &&
      policySaved.rows[0]?.cooldown_minutes === 30 &&
      policySaved.rows[0]?.dedupe_window_hours === 12 &&
      policySaved.rows[0]?.min_signal_level === 2 &&
      policySaved.rows[0]?.auto_capture_success === true &&
      policySaved.rows[0]?.model_tier === "pro",
    JSON.stringify(policySaved.rows[0]),
  );

  let policyDenied = false;
  try {
    await runAs(memberA, (client) =>
      client.query(
        "select app.save_experience_policy(200, 12000, 20, 50, 3, 60, 24, 1, false, 'fast')",
      ),
    );
  } catch (error) {
    policyDenied = error.code === "42501";
  }
  check("经验策略：非 L1 不能保存", policyDenied);

  let policyRangeDenied = false;
  try {
    await runAs(boss, (client) =>
      client.query(
        "select app.save_experience_policy(10, 500, 20, 50, 3, 60, 24, 1, false, 'fast')",
      ),
    );
  } catch (error) {
    policyRangeDenied = error.code === "23514";
  }
  check("经验策略：越界被表约束拒绝", policyRangeDenied);

  const policyTooShort = await runAs(memberA, (client) =>
    enqueueExperience(client, {
      tenantId: TENANT,
      departmentId: fx.departments.groupA,
      channel: "manual",
      sourceType: "manual_test",
      sourceId: randomUUID(),
      sourceVersion: "v1",
      title: "策略阈值回归",
      text: "经".repeat(100),
      manual: true,
    }),
  );
  check(
    "经验策略：低于最短字数的来源不入队",
    policyTooShort.jobId === null,
    JSON.stringify(policyTooShort),
  );

  const policyLongEnough = await runAs(memberA, (client) =>
    enqueueExperience(client, {
      tenantId: TENANT,
      departmentId: fx.departments.groupA,
      channel: "manual",
      sourceType: "manual_test",
      sourceId: randomUUID(),
      sourceVersion: "v1",
      title: "策略阈值回归",
      text: "经".repeat(150),
      manual: true,
    }),
  );
  check(
    "经验策略：达到阈值后正常入队",
    typeof policyLongEnough.jobId === "string",
    JSON.stringify(policyLongEnough),
  );

  // 部门 × 通道开关与最小信号等级
  const channelDefault = await runAs(boss, (client) =>
    client.query("select app.experience_channel_enabled($1, 'pipeline') as enabled", [
      fx.departments.groupA,
    ]),
  );
  check("经验通道：无配置时默认启用", channelDefault.rows[0]?.enabled === true);

  await runAs(boss, (client) =>
    client.query("select app.save_experience_channel_policy($1, 'pipeline', false)", [
      fx.departments.groupA,
    ]),
  );
  const channelDisabled = await runAs(memberA, (client) =>
    enqueueExperience(client, {
      tenantId: TENANT,
      departmentId: fx.departments.groupA,
      channel: "pipeline",
      sourceType: "manual_test",
      sourceId: randomUUID(),
      sourceVersion: "v1",
      title: "通道关闭回归",
      text: "经".repeat(150),
      manual: true,
      signalLevel: 3,
    }),
  );
  check(
    "经验通道：关闭后不入队",
    channelDisabled.jobId === null && /关闭/.test(channelDisabled.reason ?? ""),
    JSON.stringify(channelDisabled),
  );

  let channelDenied = false;
  try {
    await runAs(memberA, (client) =>
      client.query("select app.save_experience_channel_policy($1, 'pipeline', true)", [
        fx.departments.groupA,
      ]),
    );
  } catch (error) {
    channelDenied = error.code === "42501";
  }
  check("经验通道：非 L1 不能改开关", channelDenied);

  await runAs(boss, (client) =>
    client.query("select app.save_experience_channel_policy($1, 'pipeline', true)", [
      fx.departments.groupA,
    ]),
  );
  const channelEnabled = await runAs(memberA, (client) =>
    enqueueExperience(client, {
      tenantId: TENANT,
      departmentId: fx.departments.groupA,
      channel: "pipeline",
      sourceType: "manual_test",
      sourceId: randomUUID(),
      sourceVersion: "v1",
      title: "通道恢复回归",
      text: "经".repeat(150),
      manual: true,
      signalLevel: 3,
    }),
  );
  check(
    "经验通道：恢复后正常入队",
    typeof channelEnabled.jobId === "string",
    JSON.stringify(channelEnabled),
  );

  const lowSignal = await runAs(memberA, (client) =>
    enqueueExperience(client, {
      tenantId: TENANT,
      departmentId: fx.departments.groupA,
      channel: "retro",
      sourceType: "manual_test",
      sourceId: randomUUID(),
      sourceVersion: "v1",
      title: "信号等级回归",
      text: "经".repeat(150),
      signalLevel: 1,
    }),
  );
  check(
    "经验策略：低于最小信号等级不入队",
    lowSignal.jobId === null && /信号等级/.test(lowSignal.reason ?? ""),
    JSON.stringify(lowSignal),
  );

  const okSignal = await runAs(memberA, (client) =>
    enqueueExperience(client, {
      tenantId: TENANT,
      departmentId: fx.departments.groupA,
      channel: "retro",
      sourceType: "manual_test",
      sourceId: randomUUID(),
      sourceVersion: "v1",
      title: "信号等级回归",
      text: "经".repeat(150),
      signalLevel: 2,
    }),
  );
  check(
    "经验策略：达到信号等级后入队",
    typeof okSignal.jobId === "string",
    JSON.stringify(okSignal),
  );

  if (process.env.KEEP_KB_FIXTURES !== "1") {
    await withClient(OWNER_URL, cleanup);
  }

  console.log(`\n[KNOWLEDGE] passed=${passed} failed=${failed} skipped=${skipped}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(JSON.stringify({ level: "error", msg: "knowledge_test_failed", error: String(error) }));
  process.exit(1);
});
