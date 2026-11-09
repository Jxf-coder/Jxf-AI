/**
 * 技能注册表与绑定校验。
 *
 * 会创建临时技能 / 分发任务 / AI 员工绑定，结束后清理；
 * 需要先执行 0030_skills 迁移。
 */
import { Client } from "pg";

import { updateAiEmployee } from "../src/lib/ai-employees.ts";
import {
  buildSkillPrompt,
  createSkill,
  deleteSkill,
  findInvalidSkillKeys,
  listSkillOptions,
  listSkills,
  normalizeSkillKeys,
  setSkillStatus,
  summarizeSkillOutput,
  updateSkill,
  SkillInputError,
} from "../src/lib/skills.ts";
import { buildPlatformCopies, createDistributeAccount, createDistributeGroup, createDistributeJob, runnerClaim, runnerReport, rotateRunnerToken } from "../src/lib/skills/distribute.ts";
import { runMetaRules } from "../src/lib/skills/meta-ads.ts";
import { listLearningSources } from "../src/lib/skills/learning-sources.ts";

const TENANT = process.env.JXF_TENANT_ID;
const HOST = process.env.SEED_DB_HOST ?? "127.0.0.1";
const PORT = process.env.SEED_DB_PORT ?? process.env.POSTGRES_PORT ?? "5432";
const DB = process.env.POSTGRES_DB;
const OWNER_URL = `postgresql://${process.env.JXF_OWNER_USER}:${process.env.JXF_OWNER_PASSWORD}@${HOST}:${PORT}/${DB}`;

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

async function loadActor(client, level) {
  const { rows } = await client.query(
    `select m.user_id, m.id as membership_id, m.department_id, d.name as department_name, m.access_level
       from memberships m
       join departments d on d.id = m.department_id
      where m.tenant_id = $1 and m.status = 'active' and m.access_level = $2
      order by m.created_at limit 1`,
    [TENANT, level],
  );
  return rows[0] ?? null;
}

async function buildContext(client, actor) {
  const version = await client.query("select app.user_permission_version($1) as version", [actor.user_id]);
  return {
    userId: actor.user_id,
    tenantId: TENANT,
    activeMembership: {
      id: actor.membership_id,
      departmentId: actor.department_id,
      departmentName: actor.department_name,
      level: actor.access_level,
      title: "",
    },
    activeMemberships: [],
    activeMembershipId: actor.membership_id,
    activeDepartmentId: actor.department_id,
    activeDepartmentName: actor.department_name,
    membershipDepartmentIds: [actor.department_id],
    departmentIds: [actor.department_id],
    subtreeDepartmentIds: [actor.department_id],
    accessLevel: actor.access_level,
    permissionVersion: Number(version.rows[0]?.version ?? 0),
  };
}

function sampleAds() {
  const now = new Date();
  const learning = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const old = new Date(now.getTime() - 20 * 86_400_000).toISOString();
  return [
    {
      id: "ad-burn",
      name: "烧钱无成果",
      campaignId: "c1",
      campaignName: "活动一",
      status: "ACTIVE",
      dailyBudget: 100,
      createdTime: old,
      spend: 400,
      results: 0,
      impressions: 10000,
      clicks: 100,
    },
    {
      id: "ad-good",
      name: "低成本",
      campaignId: "c1",
      campaignName: "活动一",
      status: "ACTIVE",
      dailyBudget: 100,
      createdTime: old,
      spend: 200,
      results: 10,
      impressions: 10000,
      clicks: 200,
    },
    {
      id: "ad-learning",
      name: "学习中",
      campaignId: "c1",
      campaignName: "活动一",
      status: "ACTIVE",
      dailyBudget: 100,
      createdTime: learning,
      spend: 900,
      results: 0,
      impressions: 10000,
      clicks: 100,
    },
  ];
}

async function main() {
  const owner = new Client({ connectionString: OWNER_URL, application_name: "jxf-skills-test" });
  await owner.connect();

  const l1 = await loadActor(owner, "L1");
  const l3 = await loadActor(owner, "L3");
  if (!l1) throw new Error("缺少 L1 测试账号；请先 npm run seed");
  const context = await buildContext(owner, l1);
  const l3Context = l3 ? await buildContext(owner, l3) : null;

  const suffix = Date.now().toString(36);
  const testKey = `test-skill-${suffix}`;
  let employeeId = null;
  let employeeOriginal = [];
  let departmentId = null;
  let departmentOriginal = [];
  let groupId = null;
  let jobId = null;

  try {
    const catalog = await listSkills(context);
    check("内置 5 个技能已注册", catalog.length === 5, `count=${catalog.length}`);
    check(
      "5 个技能 key 完整",
      ["customer-research", "ima-knowledge", "learning-knowledge", "meta-ads-operator", "video-distribute"].every((key) =>
        catalog.some((skill) => skill.key === key),
      ),
    );

    const valid = await findInvalidSkillKeys(owner, context, ["customer-research", "ima-knowledge"]);
    check("合法技能 key 全部通过", valid.length === 0, valid.join(","));
    const invalid = await findInvalidSkillKeys(owner, context, ["ghost-skill"]);
    check("悬空技能 key 被识别", invalid.length === 1 && invalid[0] === "ghost-skill", invalid.join(","));

    check("key 归一化去重", normalizeSkillKeys([" Customer-Research ", "customer-research", "bad key"]).join(",") === "customer-research");

    const prompt = buildSkillPrompt("customer-research", { companyName: "ABC GmbH" });
    check("客户调研提示词包含公司全称", prompt.includes("ABC GmbH"));
    check("输出摘要取首行", summarizeSkillOutput("\n# 报告\n正文").summary === "# 报告");

    const created = await createSkill(context, {
      key: testKey,
      name: "测试技能",
      category: "tool",
      summary: "用于门禁校验",
      promptBody: "你是测试助手",
    });
    check("L1 可注册自建技能", created.key === testKey && created.origin === "tenant");
    const updated = await updateSkill(context, testKey, { name: "测试技能 v2", summary: "已更新" });
    check("自建技能可更新且版本递增", updated.name === "测试技能 v2" && updated.version === 2);
    await setSkillStatus(context, testKey, "retired");
    const afterRetire = await owner.query("select status from skills where key = $1", [testKey]);
    check("自建技能可停用", afterRetire.rows[0]?.status === "retired");
    await deleteSkill(context, testKey);
    const afterDelete = await owner.query("select 1 from skills where key = $1", [testKey]);
    check("自建技能可删除", afterDelete.rowCount === 0);

    if (l3Context) {
      let denied = false;
      try {
        await createSkill(l3Context, { key: `l3-skill-${suffix}`, name: "越权" });
      } catch {
        denied = true;
      }
      check("L3 不能注册技能", denied);
    }

    const options = await listSkillOptions(context);
    check(
      "AI 员工可选 Skill 受权限开关约束",
      options.some((option) => option.key === "customer-research"),
      `count=${options.length}`,
    );

    const employee = await owner.query(
      `select id, name, description, persona, system_prompt, skill_keys, allowed_tools, model_config
         from ai_employees where tenant_id = $1 order by created_at limit 1`,
      [TENANT],
    );
    let employeeBase = {
      name: "门禁测试员工",
      description: "skills test",
      persona: "",
      systemPrompt: "",
      allowedTools: [],
      modelTier: "deep",
      reviewMode: "manual",
      autoMinChars: 120,
    };
    if (employee.rows[0]) {
      const row = employee.rows[0];
      employeeId = row.id;
      employeeOriginal = row.skill_keys ?? [];
      employeeBase = {
        name: row.name,
        description: row.description ?? "",
        persona: row.persona ?? "",
        systemPrompt: row.system_prompt ?? "",
        allowedTools: row.allowed_tools ?? [],
        modelTier: row.model_config?.tier === "fast" ? "fast" : "deep",
        reviewMode: row.model_config?.review?.mode === "auto" ? "auto" : "manual",
        autoMinChars: Number(row.model_config?.review?.minChars ?? 120),
      };
    } else {
      const inserted = await owner.query(
        `insert into ai_employees (tenant_id, slug, name, description, status, created_by)
         values ($1, $2, '门禁测试员工', 'skills test', 'draft', $3) returning id`,
        [TENANT, `skills-test-${suffix}`, l1.user_id],
      );
      employeeId = inserted.rows[0].id;
      employeeOriginal = [];
    }

    let rejected = false;
    try {
      await updateAiEmployee(context, employeeId, {
        ...employeeBase,
        skillKeys: ["customer-research", "ghost-skill"],
      });
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("不存在或已停用");
    }
    check("AI 员工编辑拒绝悬空 Skill Key", rejected);

    await updateAiEmployee(context, employeeId, {
      ...employeeBase,
      skillKeys: ["customer-research", "ima-knowledge"],
    });
    const employeeBound = await owner.query("select skill_keys from ai_employees where id = $1", [employeeId]);
    check(
      "AI 员工编辑可保存有效 Skill",
      (employeeBound.rows[0]?.skill_keys ?? []).includes("customer-research"),
    );

    const plans = runMetaRules(sampleAds(), {
      targetCostPerResult: 80,
      currency: "USD",
      resultLabel: "线索",
      maxRaisePct: 20,
    });
    check("Meta 规则识别烧钱无成果", plans.some((plan) => plan.targetId === "ad-burn" && plan.kind === "pause_ad"));
    check("Meta 规则给低成本广告加预算", plans.some((plan) => plan.targetId === "ad-good" && plan.kind === "set_budget"));
    check("Meta 规则不打扰学习期", !plans.some((plan) => plan.targetId === "ad-learning"));

    const copies = buildPlatformCopies("标题", "正文", ["a", "b"], ["douyin", "xhs"]);
    check("九平台文案按平台裁剪", Boolean(copies.douyin) && copies.xhs.tags.includes("#a"));

    const groupName = `门禁分组-${suffix}`;
    await createDistributeGroup(context, { name: groupName });
    const group = await owner.query(
      "select id from skill_distribute_groups where tenant_id = $1 and name = $2",
      [TENANT, groupName],
    );
    groupId = group.rows[0]?.id ?? null;
    check("分发分组已创建", Boolean(groupId));

    if (groupId) {
      await createDistributeAccount(context, {
        groupId,
        platform: "douyin",
        displayName: "门禁测试号",
        hostname: "test-runner",
      });
      const account = await owner.query("select count(*)::int as count from skill_distribute_accounts where group_id = $1", [groupId]);
      check("分发账号已创建", account.rows[0]?.count === 1);
    }

    const job = await createDistributeJob(context, {
      title: "门禁测试成片",
      body: "一段测试正文",
      tags: ["测试"],
      platforms: ["douyin", "xhs"],
    });
    jobId = job.jobId;
    check("分发任务已入队", Boolean(jobId));

    const rotated = await rotateRunnerToken(context);
    check("发布机令牌为 64 位十六进制", /^[0-9a-f]{64}$/.test(rotated.token));

    const claimed = await runnerClaim(rotated.token);
    check("发布机可领取任务", claimed?.id === jobId, String(claimed?.id ?? "null"));
    if (claimed?.id === jobId) {
      const reported = await runnerReport(rotated.token, jobId, "done", [{ platform: "douyin", status: "ok" }]);
      check("发布机可回写结果", reported);
      const done = await owner.query("select status from skill_distribute_jobs where id = $1", [jobId]);
      check("任务状态收口为完成", done.rows[0]?.status === "done");
    }

    const sources = await listLearningSources();
    check("学习提炼来源可读取", sources.length >= 25, `count=${sources.length}`);
    check("学习来源索引包含 SRC-IMA", sources.some((source) => source.code === "SRC-IMA"));
  } finally {
    if (jobId) await owner.query("delete from skill_distribute_jobs where id = $1", [jobId]).catch(() => undefined);
    if (groupId) await owner.query("delete from skill_distribute_groups where id = $1", [groupId]).catch(() => undefined);
    if (departmentId) {
      await owner
        .query(
          `update department_packs set skill_ids = $2::text[] where department_id = $1`,
          [departmentId, departmentOriginal],
        )
        .catch(() => undefined);
    }
    if (employeeId) {
      await owner
        .query("update ai_employees set skill_keys = $2::text[] where id = $1", [employeeId, employeeOriginal])
        .catch(() => undefined);
    }
    await owner.query("delete from skill_runtime_tokens where tenant_id = $1 and skill_key = 'video-distribute'", [TENANT]).catch(() => undefined);
    await owner.query("delete from skill_runs where skill_key = $1", [testKey]).catch(() => undefined);
    await owner.query("delete from skills where key = $1", [testKey]).catch(() => undefined);
    await owner.end();
  }

  console.log(`[skills] passed=${passed} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
