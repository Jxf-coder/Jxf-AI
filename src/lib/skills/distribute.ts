/**
 * 多平台分发（Video Distribute）。
 *
 * 复刻老系统的「分组 → 账号 → 发布任务 → 发布机领取/回写」链路：
 * - 账号分组与账号落库，按部门隔离；
 * - 发布任务生成九平台文案副本，支持立即/定时；
 * - 发布机用一次性令牌领取任务（SECURITY DEFINER 函数），业务角色不能直接改任务状态；
 * - 平台登录仍在各发布机本机完成，服务端不保存平台口令。
 */

import { createHash, randomBytes } from "node:crypto";

import { auditInTx } from "@/lib/audit";
import { getPool } from "@/lib/db/pool";
import { withUserContext, type UserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";
import { SkillInputError } from "@/lib/skills";

export const DISTRIBUTE_PLATFORMS = [
  { id: "douyin", label: "抖音", group: "cn" },
  { id: "channels", label: "视频号", group: "cn" },
  { id: "xhs", label: "小红书", group: "cn" },
  { id: "kuaishou", label: "快手", group: "cn" },
  { id: "bilibili", label: "B站", group: "cn" },
  { id: "facebook", label: "Facebook", group: "overseas" },
  { id: "instagram", label: "Instagram", group: "overseas" },
  { id: "tiktok", label: "TikTok", group: "overseas" },
  { id: "youtube", label: "YouTube", group: "overseas" },
] as const;

export type DistributePlatform = (typeof DISTRIBUTE_PLATFORMS)[number]["id"];

const PLATFORM_IDS = new Set<string>(DISTRIBUTE_PLATFORMS.map((platform) => platform.id));

const COPY_RULES: Record<DistributePlatform, { titleMax: number; bodyMax: number; tagMax: number }> = {
  douyin: { titleMax: 55, bodyMax: 1000, tagMax: 5 },
  channels: { titleMax: 22, bodyMax: 1000, tagMax: 3 },
  xhs: { titleMax: 20, bodyMax: 1000, tagMax: 10 },
  kuaishou: { titleMax: 30, bodyMax: 1000, tagMax: 5 },
  bilibili: { titleMax: 80, bodyMax: 2000, tagMax: 10 },
  facebook: { titleMax: 100, bodyMax: 5000, tagMax: 5 },
  instagram: { titleMax: 100, bodyMax: 2200, tagMax: 10 },
  tiktok: { titleMax: 100, bodyMax: 2200, tagMax: 5 },
  youtube: { titleMax: 100, bodyMax: 5000, tagMax: 5 },
};

export interface DistributeGroupView {
  id: string;
  name: string;
  laneCn: string | null;
  laneOverseas: string | null;
  accountCount: number;
}

export interface DistributeAccountView {
  id: string;
  groupId: string;
  platform: string;
  displayName: string;
  hostname: string | null;
  loggedIn: boolean;
}

export interface DistributeJobView {
  id: string;
  title: string;
  body: string;
  tags: string[];
  platforms: string[];
  copies: Record<string, { title: string; body: string; tags: string }>;
  status: string;
  runAt: string | null;
  aiGenerated: boolean;
  results: unknown[];
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface DistributeView {
  groups: DistributeGroupView[];
  accounts: DistributeAccountView[];
  jobs: DistributeJobView[];
  runnerTokenHint: string | null;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(max - 1, 1))}…` : value;
}

export function buildPlatformCopies(
  title: string,
  body: string,
  tags: string[],
  platforms: string[],
): Record<string, { title: string; body: string; tags: string }> {
  const copies: Record<string, { title: string; body: string; tags: string }> = {};
  for (const platform of platforms) {
    if (!PLATFORM_IDS.has(platform)) continue;
    const rule = COPY_RULES[platform as DistributePlatform];
    const tagText = tags
      .slice(0, rule.tagMax)
      .map((tag) => `#${tag.replace(/^#/, "")}`)
      .join(" ");
    copies[platform] = {
      title: truncate(title.trim(), rule.titleMax),
      body: truncate(body.trim(), rule.bodyMax),
      tags: tagText,
    };
  }
  return copies;
}

function departmentPermission(context: UserContext, mode: "read" | "write") {
  return {
    kind: "department" as const,
    id: context.activeDepartmentId ?? undefined,
    departmentId: context.activeDepartmentId,
  };
}

export async function listDistribute(context: UserContext): Promise<DistributeView> {
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", departmentPermission(context, "read"));
    const groups = await client.query<{ id: string; name: string; lane_cn: string | null; lane_overseas: string | null; account_count: string }>(
      `select g.id, g.name, g.lane_cn, g.lane_overseas,
              (select count(*)::text from skill_distribute_accounts a where a.group_id = g.id) as account_count
         from skill_distribute_groups g
        where g.tenant_id = $1 and g.department_id = $2
        order by g.created_at`,
      [context.tenantId, context.activeDepartmentId],
    );
    const accounts = await client.query<{
      id: string;
      group_id: string;
      platform: string;
      display_name: string;
      hostname: string | null;
      logged_in: boolean;
    }>(
      `select id, group_id, platform, display_name, hostname, logged_in
         from skill_distribute_accounts
        where tenant_id = $1 and department_id = $2
        order by created_at`,
      [context.tenantId, context.activeDepartmentId],
    );
    const jobs = await client.query(
      `select id, title, body, tags, platforms, copies, status, run_at, ai_generated,
              results, error, created_at, finished_at
         from skill_distribute_jobs
        where tenant_id = $1 and department_id = $2
        order by created_at desc
        limit 50`,
      [context.tenantId, context.activeDepartmentId],
    );
    const token = await client.query<{ token_hint: string }>(
      `select token_hint from skill_runtime_tokens
        where tenant_id = $1 and skill_key = 'video-distribute'`,
      [context.tenantId],
    );
    return {
      groups: groups.rows.map((row) => ({
        id: row.id,
        name: row.name,
        laneCn: row.lane_cn,
        laneOverseas: row.lane_overseas,
        accountCount: Number(row.account_count),
      })),
      accounts: accounts.rows.map((row) => ({
        id: row.id,
        groupId: row.group_id,
        platform: row.platform,
        displayName: row.display_name,
        hostname: row.hostname,
        loggedIn: row.logged_in,
      })),
      jobs: jobs.rows.map((row) => ({
        id: String(row.id),
        title: String(row.title),
        body: String(row.body ?? ""),
        tags: (row.tags as string[]) ?? [],
        platforms: (row.platforms as string[]) ?? [],
        copies: (row.copies as Record<string, { title: string; body: string; tags: string }>) ?? {},
        status: String(row.status),
        runAt: (row.run_at as Date | null)?.toISOString() ?? null,
        aiGenerated: Boolean(row.ai_generated),
        results: (row.results as unknown[]) ?? [],
        error: (row.error as string | null) ?? null,
        createdAt: (row.created_at as Date).toISOString(),
        finishedAt: (row.finished_at as Date | null)?.toISOString() ?? null,
      })),
      runnerTokenHint: token.rows[0]?.token_hint ?? null,
    };
  });
}

export async function createDistributeGroup(
  context: UserContext,
  input: { name: string; laneCn?: string; laneOverseas?: string },
): Promise<void> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 40) {
    throw new SkillInputError("分组名称不能为空且不超过 40 字");
  }
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", departmentPermission(context, "write"));
    await client.query(
      `insert into skill_distribute_groups
        (tenant_id, department_id, name, lane_cn, lane_overseas, created_by)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (tenant_id, department_id, name) do nothing`,
      [
        context.tenantId,
        context.activeDepartmentId,
        name,
        input.laneCn?.trim() || null,
        input.laneOverseas?.trim() || null,
        context.userId,
      ],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "skill.distribute.group_created",
      targetType: "skill",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: { name },
    });
  });
}

export async function deleteDistributeGroup(context: UserContext, groupId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", departmentPermission(context, "write"));
    const { rowCount } = await client.query(
      `delete from skill_distribute_groups where id = $1 and tenant_id = $2 and department_id = $3`,
      [groupId, context.tenantId, context.activeDepartmentId],
    );
    if (rowCount === 0) {
      throw new SkillInputError("分组不存在");
    }
  });
}

export async function createDistributeAccount(
  context: UserContext,
  input: { groupId: string; platform: string; displayName: string; hostname?: string },
): Promise<void> {
  if (!PLATFORM_IDS.has(input.platform)) {
    throw new SkillInputError("平台不支持");
  }
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 60) {
    throw new SkillInputError("账号名称不能为空且不超过 60 字");
  }
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", departmentPermission(context, "write"));
    const group = await client.query(
      `select 1 from skill_distribute_groups
        where id = $1 and tenant_id = $2 and department_id = $3`,
      [input.groupId, context.tenantId, context.activeDepartmentId],
    );
    if (!group.rows[0]) {
      throw new SkillInputError("分组不存在");
    }
    await client.query(
      `insert into skill_distribute_accounts
        (tenant_id, department_id, group_id, platform, display_name, hostname, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        context.tenantId,
        context.activeDepartmentId,
        input.groupId,
        input.platform,
        displayName,
        input.hostname?.trim() || null,
        context.userId,
      ],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "skill.distribute.account_created",
      targetType: "skill",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: { platform: input.platform, displayName },
    });
  });
}

export async function createDistributeJob(
  context: UserContext,
  input: {
    title: string;
    body?: string;
    tags?: string[];
    platforms: string[];
    runAt?: string | null;
    aiGenerated?: boolean;
  },
): Promise<{ jobId: string }> {
  const title = input.title.trim();
  if (title.length === 0 || title.length > 120) {
    throw new SkillInputError("标题不能为空且不超过 120 字");
  }
  const platforms = [...new Set(input.platforms.filter((platform) => PLATFORM_IDS.has(platform)))];
  if (platforms.length === 0) {
    throw new SkillInputError("至少选择一个发布平台");
  }
  const tags = (input.tags ?? []).map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean).slice(0, 10);
  const copies = buildPlatformCopies(title, input.body ?? "", tags, platforms);
  let runAt: Date | null = null;
  if (input.runAt) {
    const parsed = new Date(input.runAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new SkillInputError("定时时间格式不正确");
    }
    runAt = parsed;
  }
  const status = runAt && runAt.getTime() > Date.now() ? "scheduled" : "queued";

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", departmentPermission(context, "write"));
    const { rows } = await client.query<{ id: string }>(
      `insert into skill_distribute_jobs
        (tenant_id, department_id, title, body, tags, platforms, copies, status, run_at, ai_generated, created_by)
       values ($1, $2, $3, $4, $5::text[], $6::text[], $7::jsonb, $8, $9, $10, $11)
       returning id`,
      [
        context.tenantId,
        context.activeDepartmentId,
        title,
        (input.body ?? "").slice(0, 5000),
        tags,
        platforms,
        JSON.stringify(copies),
        status,
        runAt,
        Boolean(input.aiGenerated),
        context.userId,
      ],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "skill.distribute.job_created",
      targetType: "skill",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: { jobId: rows[0].id, platforms, status },
    });
    return { jobId: rows[0].id };
  });
}

export async function retryDistributeJob(context: UserContext, jobId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", departmentPermission(context, "write"));
    const { rowCount } = await client.query(
      `update skill_distribute_jobs
          set status = 'queued', error = null, results = '[]'::jsonb, updated_at = now(), finished_at = null
        where id = $1 and tenant_id = $2 and department_id = $3 and status = 'error'`,
      [jobId, context.tenantId, context.activeDepartmentId],
    );
    if (rowCount === 0) {
      throw new SkillInputError("只能重试失败的任务");
    }
  });
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function rotateRunnerToken(context: UserContext): Promise<{ token: string }> {
  if (context.accessLevel !== "L1") {
    throw new SkillInputError("发布机令牌仅允许 L1 生成");
  }
  const token = randomBytes(32).toString("hex");
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:edit", departmentPermission(context, "write"));
    await client.query(
      `insert into skill_runtime_tokens (tenant_id, skill_key, token_hash, token_hint, updated_by, updated_at)
       values ($1, 'video-distribute', $2, $3, $4, now())
       on conflict (tenant_id, skill_key) do update
         set token_hash = excluded.token_hash,
             token_hint = excluded.token_hint,
             updated_by = excluded.updated_by,
             updated_at = now()`,
      [context.tenantId, hashToken(token), `••••${token.slice(-4)}`, context.userId],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "skill.distribute.runner_token_rotated",
      targetType: "skill",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: {},
    });
  });
  return { token };
}

/** 发布机入口：不受用户上下文约束，由 SECURITY DEFINER 校验令牌 */
export async function runnerClaim(token: string): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  const { rows } = await getPool().query<{ claim: Record<string, unknown> | null }>(
    "select app.distribute_runner_claim($1) as claim",
    [token],
  );
  return rows[0]?.claim ?? null;
}

export async function runnerReport(
  token: string,
  jobId: string,
  status: "done" | "error",
  results: unknown[],
): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    "select app.distribute_runner_report($1, $2, $3, $4::jsonb) as ok",
    [token, jobId, status, JSON.stringify(results ?? [])],
  );
  return Boolean(rows[0]?.ok);
}
