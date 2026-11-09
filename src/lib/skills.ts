/**
 * 技能注册表与执行记录。
 *
 * 约束：
 * - skills 是唯一真相源：内置技能 tenant_id 为 null，租户自建技能按租户隔离；
 * - department_packs.skill_ids 与 ai_employees.skill_keys 写入前必须通过
 *   assertSkillKeys 校验，禁止悬空字符串；
 * - 执行记录（skill_runs）与业务写入同事务落库，失败不伪造成功。
 */

import type { PoolClient } from "pg";

import { chatCompletion } from "@/lib/ai/openai";
import { auditInTx } from "@/lib/audit";
import { withUserContext, type UserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";
import type { PermissionResource } from "@/types/permission";

export type SkillStatus = "active" | "draft" | "retired";
export type SkillOrigin = "builtin" | "tenant";

export interface SkillView {
  id: string;
  key: string;
  name: string;
  icon: string;
  category: string;
  summary: string;
  hint: string;
  status: SkillStatus;
  origin: SkillOrigin;
  version: number;
  updatedAt: string;
}

export interface SkillRunView {
  id: string;
  skillKey: string;
  kind: string;
  status: "running" | "done" | "failed";
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  createdByName: string | null;
}

export interface SkillBindingView {
  departments: { id: string; name: string; skillKeys: string[] }[];
  employees: { id: string; name: string; status: string; skillKeys: string[] }[];
  catalog: { key: string; name: string; category: string }[];
}

/** AI 员工编辑用：当前操作者可分配的 Skill 选项 */
export interface SkillOptionView {
  key: string;
  name: string;
  category: string;
  summary: string;
}

export class SkillInputError extends Error {}

const DEFAULT_CATEGORY = "tool";
const MAX_PROMPT_INPUT = 12_000;

function departmentResource(context: UserContext): PermissionResource {
  const departmentId = context.activeDepartmentId;
  return { kind: "department", id: departmentId ?? undefined, departmentId };
}

function toSkillView(row: Record<string, unknown>): SkillView {
  return {
    id: String(row.id),
    key: String(row.key),
    name: String(row.name),
    icon: String(row.icon ?? "🧩"),
    category: String(row.category ?? DEFAULT_CATEGORY),
    summary: String(row.summary ?? ""),
    hint: String(row.hint ?? ""),
    status: String(row.status ?? "active") as SkillStatus,
    origin: String(row.origin ?? "builtin") as SkillOrigin,
    version: Number(row.version ?? 1),
    updatedAt: (row.updated_at as Date | null)?.toISOString() ?? new Date().toISOString(),
  };
}

function toRunView(row: Record<string, unknown>): SkillRunView {
  return {
    id: String(row.id),
    skillKey: String(row.skill_key),
    kind: String(row.kind),
    status: String(row.status) as SkillRunView["status"],
    input: (row.input as Record<string, unknown>) ?? {},
    output: (row.output as Record<string, unknown>) ?? {},
    error: (row.error as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    finishedAt: (row.finished_at as Date | null)?.toISOString() ?? null,
    createdByName: (row.created_by_name as string | null) ?? null,
  };
}

export function normalizeSkillKeys(keys: unknown): string[] {
  if (!Array.isArray(keys)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of keys) {
    if (typeof raw !== "string") continue;
    const key = raw.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

/** 校验技能 key 是否全部存在且处于 active；返回无效 key */
export async function findInvalidSkillKeys(
  client: PoolClient,
  context: Pick<UserContext, "tenantId">,
  keys: string[],
): Promise<string[]> {
  if (keys.length === 0) {
    return [];
  }
  const { rows } = await client.query<{ key: string }>(
    `select key from skills
      where key = any($1::text[])
        and status = 'active'
        and (tenant_id is null or tenant_id = $2)`,
    [keys, context.tenantId],
  );
  const found = new Set(rows.map((row) => row.key));
  return keys.filter((key) => !found.has(key));
}

async function assertSkillKeys(
  client: PoolClient,
  context: Pick<UserContext, "tenantId">,
  keys: string[],
): Promise<void> {
  const invalid = await findInvalidSkillKeys(client, context, keys);
  if (invalid.length > 0) {
    throw new SkillInputError(`以下技能不存在或已停用：${invalid.join("、")}`);
  }
}

export async function listSkills(context: UserContext): Promise<SkillView[]> {
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", departmentResource(context));
    const { rows } = await client.query(
      `select id, key, name, icon, category, summary, hint, status, origin, version, updated_at
         from skills
        where status <> 'retired'
          and (tenant_id is null or tenant_id = $1)
        order by category, name`,
      [context.tenantId],
    );
    return rows.map(toSkillView);
  });
}

/**
 * AI 员工编辑用的可选 Skill。
 *
 * 受工作台权限开关约束：只有具备 skill:use 的等级才能拿到选项；
 * L1 管理员工时可选全部已注册且 active 的技能。
 */
export async function listSkillOptions(context: UserContext): Promise<SkillOptionView[]> {
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", departmentResource(context));
    const { rows } = await client.query<{
      key: string;
      name: string;
      category: string;
      summary: string;
    }>(
      `select key, name, category, summary
         from skills
        where status = 'active'
          and (tenant_id is null or tenant_id = $1)
        order by category, name`,
      [context.tenantId],
    );
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      category: row.category,
      summary: row.summary,
    }));
  });
}

export async function getSkill(context: UserContext, key: string): Promise<SkillView | null> {
  const normalized = key.trim().toLowerCase();
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", departmentResource(context));
    const { rows } = await client.query(
      `select id, key, name, icon, category, summary, hint, status, origin, version, updated_at
         from skills
        where key = $1 and status <> 'retired'
          and (tenant_id is null or tenant_id = $2)
        limit 1`,
      [normalized, context.tenantId],
    );
    return rows[0] ? toSkillView(rows[0]) : null;
  });
}

export interface CreateSkillInput {
  key: string;
  name: string;
  icon?: string;
  category?: string;
  summary?: string;
  hint?: string;
  promptBody?: string;
}

export async function createSkill(context: UserContext, input: CreateSkillInput): Promise<SkillView> {
  const key = input.key.trim().toLowerCase();
  const name = input.name.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(key)) {
    throw new SkillInputError("标识符只能使用小写字母、数字与连字符（2–64 位）");
  }
  if (name.length === 0 || name.length > 60) {
    throw new SkillInputError("名称不能为空且不超过 60 字");
  }

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:create", departmentResource(context));
    const existing = await client.query("select 1 from skills where key = $1", [key]);
    if (existing.rows[0]) {
      throw new SkillInputError("该技能标识符已存在");
    }
    const { rows } = await client.query(
      `insert into skills
        (tenant_id, key, name, icon, category, summary, hint, prompt_body, origin, status, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'tenant', 'active', $9)
       returning id, key, name, icon, category, summary, hint, status, origin, version, updated_at`,
      [
        context.tenantId,
        key,
        name,
        (input.icon ?? "🧩").slice(0, 8),
        input.category ?? DEFAULT_CATEGORY,
        (input.summary ?? "").slice(0, 500),
        (input.hint ?? "").slice(0, 500),
        (input.promptBody ?? "").slice(0, MAX_PROMPT_INPUT),
        context.userId,
      ],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "skill.created",
      targetType: "skill",
      targetId: String(rows[0].id),
      departmentId: context.activeDepartmentId,
      payload: { key, name, category: input.category ?? DEFAULT_CATEGORY },
    });
    return toSkillView(rows[0]);
  });
}

export async function updateSkill(
  context: UserContext,
  key: string,
  input: {
    name?: string;
    icon?: string;
    category?: string;
    summary?: string;
    hint?: string;
    promptBody?: string;
  },
): Promise<SkillView> {
  const normalized = key.trim().toLowerCase();
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:edit", departmentResource(context));
    const { rows } = await client.query(
      `update skills
          set name = coalesce($3, name),
              icon = coalesce($4, icon),
              category = coalesce($5, category),
              summary = coalesce($6, summary),
              hint = coalesce($7, hint),
              prompt_body = coalesce($8, prompt_body),
              version = version + 1,
              updated_at = now()
        where key = $1 and tenant_id = $2
        returning id, key, name, icon, category, summary, hint, status, origin, version, updated_at`,
      [
        normalized,
        context.tenantId,
        input.name?.trim() || null,
        input.icon?.slice(0, 8) || null,
        input.category || null,
        input.summary?.slice(0, 500) ?? null,
        input.hint?.slice(0, 500) ?? null,
        input.promptBody?.slice(0, MAX_PROMPT_INPUT) ?? null,
      ],
    );
    const row = rows[0];
    if (!row) {
      throw new SkillInputError("技能不存在，或内置技能不允许在界面修改");
    }
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "skill.updated",
      targetType: "skill",
      targetId: String(row.id),
      departmentId: context.activeDepartmentId,
      payload: { key: normalized },
    });
    return toSkillView(row);
  });
}

export async function setSkillStatus(
  context: UserContext,
  key: string,
  status: SkillStatus,
): Promise<void> {
  if (!["active", "draft", "retired"].includes(status)) {
    throw new SkillInputError("状态不合法");
  }
  const normalized = key.trim().toLowerCase();
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:edit", departmentResource(context));
    const { rows } = await client.query<{ id: string }>(
      `update skills set status = $3, updated_at = now()
        where key = $1 and tenant_id = $2
        returning id`,
      [normalized, context.tenantId, status],
    );
    const updated = rows[0];
    if (!updated) {
      throw new SkillInputError("技能不存在，或内置技能不允许停用");
    }
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "skill.status_changed",
      targetType: "skill",
      targetId: updated.id,
      departmentId: context.activeDepartmentId,
      payload: { key: normalized, status },
    });
  });
}

export async function deleteSkill(context: UserContext, key: string): Promise<void> {
  if (context.accessLevel !== "L1") {
    throw new SkillInputError("删除技能仅允许 L1");
  }
  const normalized = key.trim().toLowerCase();
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:edit", departmentResource(context));
    const existing = await client.query<{ id: string }>(
      `select id from skills where key = $1 and tenant_id = $2 limit 1`,
      [normalized, context.tenantId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new SkillInputError("技能不存在，或内置技能不允许删除");
    }
    await client.query(`delete from skills where id = $1`, [row.id]);
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "skill.deleted",
      targetType: "skill",
      targetId: row.id,
      departmentId: context.activeDepartmentId,
      payload: { key: normalized },
    });
  });
}

export async function listSkillRuns(
  context: UserContext,
  skillKey?: string,
  limit = 20,
): Promise<SkillRunView[]> {
  const capped = Math.min(Math.max(limit, 1), 50);
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", departmentResource(context));
    const { rows } = await client.query(
      `select r.id, r.skill_key, r.kind, r.status, r.input, r.output, r.error,
              r.created_at, r.finished_at, u.name as created_by_name
         from skill_runs r
         left join users u on u.id = r.created_by
        where r.tenant_id = $1
          and ($2::text is null or r.skill_key = $2)
        order by r.created_at desc
        limit $3`,
      [context.tenantId, skillKey?.trim().toLowerCase() ?? null, capped],
    );
    return rows.map(toRunView);
  });
}

/** 纯函数：把技能输入拼成用户消息，便于测试与复用 */
export function buildSkillPrompt(skillKey: string, input: Record<string, string>): string {
  if (skillKey === "customer-research") {
    const company = (input.companyName ?? "").trim();
    const notes = (input.notes ?? "").trim();
    return [
      `公司全称：${company || "（未填写）"}`,
      notes ? `补充要求：${notes}` : "补充要求：无",
      "请严格按七节结构输出；没有来源的格子留空，价格/信用/纠纷写「未核实」。",
    ].join("\n");
  }
  if (skillKey === "ima-knowledge") {
    return [
      `建库用途：${(input.purpose ?? "").trim() || "（未填写）"}`,
      `资料类型：${(input.materials ?? "").trim() || "（未填写）"}`,
      `权限角色：${(input.roles ?? "").trim() || "（未填写）"}`,
      `主要提问：${(input.question ?? "").trim() || "（未填写）"}`,
      "请输出：建议进哪个库、目录两级怎么放、谁有什么权限、一条可直接用的提问、还没定的缺口。",
    ].join("\n");
  }
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

/** 纯函数：把模型输出收成结构化结果（Markdown 全文 + 摘要） */
export function summarizeSkillOutput(text: string): { text: string; summary: string } {
  const trimmed = text.trim();
  const firstLine = trimmed.split("\n").find((line) => line.trim().length > 0) ?? "";
  return { text: trimmed, summary: firstLine.slice(0, 120) };
}

export async function runPromptSkill(
  context: UserContext,
  key: string,
  input: Record<string, string>,
): Promise<{ runId: string; output: string }> {
  const normalized = key.trim().toLowerCase();
  const payload = buildSkillPrompt(normalized, input);
  if (payload.length > MAX_PROMPT_INPUT) {
    throw new SkillInputError("输入过长，请精简后再试");
  }

  const skill = await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", departmentResource(context));
    const { rows } = await client.query<{ id: string; prompt_body: string; status: string }>(
      `select id, prompt_body, status from skills
        where key = $1 and status = 'active'
          and (tenant_id is null or tenant_id = $2)
        limit 1`,
      [normalized, context.tenantId],
    );
    return rows[0] ?? null;
  });
  if (!skill) {
    throw new SkillInputError("技能不存在或已停用");
  }
  if (!skill.prompt_body.trim()) {
    throw new SkillInputError("该技能没有可执行的提示词");
  }
  if (!context.activeDepartmentId) {
    throw new SkillInputError("当前账号没有有效部门上下文");
  }

  const runId = await withUserContext(context, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into skill_runs
        (tenant_id, department_id, skill_id, skill_key, kind, status, input, created_by)
       values ($1, $2, $3, $4, 'prompt', 'running', $5::jsonb, $6)
       returning id`,
      [context.tenantId, context.activeDepartmentId, skill.id, normalized, JSON.stringify(input), context.userId],
    );
    return rows[0].id;
  });

  const text = await chatCompletion(
    [
      { role: "system", content: skill.prompt_body },
      { role: "user", content: payload },
    ],
    { temperature: 0.2, maxTokens: 2400, tier: "deep" },
  );

  if (!text) {
    await withUserContext(context, async (client) => {
      await client.query(
        `update skill_runs set status = 'failed', error = $2, finished_at = now() where id = $1`,
        [runId, "AI 未启用或调用失败"],
      );
    });
    throw new SkillInputError("AI 未启用或调用失败，请先在设置面配置模型");
  }

  const summary = summarizeSkillOutput(text).summary;
  await withUserContext(context, async (client) => {
    await client.query(
      `update skill_runs
          set status = 'done', output = $2::jsonb, finished_at = now()
        where id = $1`,
      [runId, JSON.stringify({ text, summary })],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "skill.run",
      targetType: "skill",
      targetId: skill.id,
      departmentId: context.activeDepartmentId,
      payload: { key: normalized, runId, summary },
    });
  });

  return { runId, output: text };
}

export async function listSkillBindings(context: UserContext): Promise<SkillBindingView> {
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:edit", departmentResource(context));

    const departments = await client.query<{ id: string; name: string; skill_ids: string[] }>(
      `select d.id, d.name, coalesce(p.skill_ids, '{}'::text[]) as skill_ids
         from departments d
         left join department_packs p on p.department_id = d.id
        where d.tenant_id = $1
        order by d.sort_order, d.name`,
      [context.tenantId],
    );
    const employees = await client.query<{ id: string; name: string; status: string; skill_keys: string[] }>(
      `select id, name, status, skill_keys
         from ai_employees
        where tenant_id = $1
        order by created_at`,
      [context.tenantId],
    );
    const catalog = await client.query<{ key: string; name: string; category: string }>(
      `select key, name, category from skills
        where status = 'active'
          and (tenant_id is null or tenant_id = $1)
        order by category, name`,
      [context.tenantId],
    );

    return {
      departments: departments.rows.map((row) => ({
        id: row.id,
        name: row.name,
        skillKeys: row.skill_ids ?? [],
      })),
      employees: employees.rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        skillKeys: row.skill_keys ?? [],
      })),
      catalog: catalog.rows,
    };
  });
}

export async function setDepartmentSkills(
  context: UserContext,
  departmentId: string,
  keys: string[],
): Promise<void> {
  if (context.accessLevel !== "L1") {
    throw new SkillInputError("部门能力包仅允许 L1 修改");
  }
  const normalized = normalizeSkillKeys(keys);
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:edit", {
      kind: "department",
      id: departmentId,
      departmentId,
    });
    await assertSkillKeys(client, context, normalized);
    await client.query(
      `insert into department_packs (department_id, skill_ids, updated_by, updated_at)
       values ($1, $2::text[], $3, now())
       on conflict (department_id) do update
         set skill_ids = excluded.skill_ids,
             updated_by = excluded.updated_by,
             updated_at = now()`,
      [departmentId, normalized, context.userId],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "department.skills_updated",
      targetType: "department",
      targetId: departmentId,
      departmentId,
      payload: { skillKeys: normalized },
    });
  });
}

export async function setEmployeeSkills(
  context: UserContext,
  employeeId: string,
  keys: string[],
): Promise<void> {
  if (context.accessLevel !== "L1") {
    throw new SkillInputError("AI 员工技能绑定仅允许 L1 修改");
  }
  const normalized = normalizeSkillKeys(keys);
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:edit", departmentResource(context));
    await assertSkillKeys(client, context, normalized);
    const { rowCount } = await client.query(
      `update ai_employees set skill_keys = $2::text[] where id = $1 and tenant_id = $3`,
      [employeeId, normalized, context.tenantId],
    );
    if (rowCount === 0) {
      throw new SkillInputError("AI 员工不存在或无权操作");
    }
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "ai_employee.skills_updated",
      targetType: "ai_employee",
      targetId: employeeId,
      departmentId: context.activeDepartmentId,
      payload: { skillKeys: normalized },
    });
  });
}
