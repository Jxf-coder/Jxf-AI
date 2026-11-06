/**
 * AI 员工目录与使用授权（M2 尾，运行态留给 M3）。
 *
 * 红线：
 * - 可见性完全由 RLS 决定（app.ai_employee_visible）：未授权者连名称与描述都拿不到；
 * - 目录与授权的增删改仅 L1；本阶段不引入 ai:* 权限点，保持与 RLS 一致；
 * - 新建时自动给创建者一条个人 manage 授权，否则草稿连自己都不可见；
 * - AI 员工自身不携带数据权限，运行时继承调用者上下文（M3）。
 */

import type { PoolClient } from "pg";

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { PermissionDeniedError } from "@/lib/permissions/guard";

export type AiEmployeeStatus = "draft" | "active" | "disabled";

const STATUSES: readonly AiEmployeeStatus[] = ["draft", "active", "disabled"];
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export interface AiEmployeeView {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: AiEmployeeStatus;
  createdAt: string;
  createdByName: string | null;
}

export interface AiEmployeeGrantView {
  id: string;
  targetType: "department" | "user";
  targetId: string;
  targetName: string;
  capability: "use" | "manage";
}

export interface AiEmployeeDetail extends AiEmployeeView {
  grants: AiEmployeeGrantView[];
}

export interface AiEmployeeGrantCandidates {
  departments: Array<{ id: string; name: string }>;
  users: Array<{ id: string; name: string; email: string }>;
}

export interface CreateAiEmployeeInput {
  slug: string;
  name: string;
  description?: string | null;
}

function assertCanManage(context: UserContext): void {
  if (context.accessLevel !== "L1") {
    throw new PermissionDeniedError({
      allowed: false,
      reason: "只有 L1 可以管理 AI 员工",
    });
  }
}

export function isAiEmployeeStatus(value: string): value is AiEmployeeStatus {
  return (STATUSES as readonly string[]).includes(value);
}

function normalizeDescription(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length === 0 ? null : trimmed;
}

interface EmployeeRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: AiEmployeeStatus;
  created_at: Date;
  created_by_name: string | null;
}

function toView(row: EmployeeRow): AiEmployeeView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? "",
    status: row.status,
    createdAt: row.created_at.toISOString(),
    createdByName: row.created_by_name,
  };
}

const EMPLOYEE_COLUMNS = `e.id, e.slug, e.name, e.description, e.status, e.created_at,
  (select name from users where id = e.created_by) as created_by_name`;

/** 目录：只返回当前账号可见的 AI 员工（RLS 过滤） */
export async function listAiEmployees(context: UserContext): Promise<AiEmployeeView[]> {
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<EmployeeRow>(
      `select ${EMPLOYEE_COLUMNS}
         from ai_employees e
        order by (e.status = 'active') desc, e.created_at desc
        limit 200`,
    );
    return rows.map(toView);
  });
}

/** 详情：员工本体不可见时返回 null（不泄露存在性） */
export async function loadAiEmployee(
  context: UserContext,
  aiEmployeeId: string,
): Promise<AiEmployeeDetail | null> {
  return withUserContext(context, async (client) => {
    const employee = await client.query<EmployeeRow>(
      `select ${EMPLOYEE_COLUMNS}
         from ai_employees e
        where e.id = $1`,
      [aiEmployeeId],
    );
    const row = employee.rows[0];
    if (!row) {
      return null;
    }

    const grants = await client.query<{
      id: string;
      target_type: "department" | "user";
      target_id: string;
      target_name: string;
      capability: "use" | "manage";
    }>(
      `select g.id,
              case when g.department_id is not null then 'department' else 'user' end as target_type,
              coalesce(g.department_id, g.user_id) as target_id,
              coalesce(d.name, u.name, '已移除') as target_name,
              g.capability
         from ai_employee_grants g
         left join departments d on d.id = g.department_id
         left join users u on u.id = g.user_id
        where g.ai_employee_id = $1
        order by target_type, target_name`,
      [aiEmployeeId],
    );

    return {
      ...toView(row),
      grants: grants.rows.map((grant) => ({
        id: grant.id,
        targetType: grant.target_type,
        targetId: grant.target_id,
        targetName: grant.target_name,
        capability: grant.capability,
      })),
    };
  });
}

/**
 * 新建：draft 起步，并自动给创建者一条个人 manage 授权。
 * 没有这条授权，草稿按 Fail-Closed 规则连创建者自己也读不到。
 */
export async function createAiEmployee(
  context: UserContext,
  input: CreateAiEmployeeInput,
): Promise<{ id: string; slug: string }> {
  assertCanManage(context);

  const slug = input.slug.trim().toLowerCase();
  const name = input.name.trim();
  const description = normalizeDescription(input.description);

  if (!SLUG_RE.test(slug)) {
    throw new Error("标识只能是小写字母、数字与连字符（2-64 位，且以字母或数字开头）");
  }
  if (name.length === 0 || name.length > 60) {
    throw new Error("名称不能为空且不超过 60 字");
  }
  if (description && description.length > 500) {
    throw new Error("描述不超过 500 字");
  }

  return withUserContext(context, async (client) => {
    let id: string;
    try {
      const inserted = await client.query<{ id: string }>(
        `insert into ai_employees (tenant_id, slug, name, description, status, created_by)
         values ($1, $2, $3, $4, 'draft', $5)
         returning id`,
        [context.tenantId, slug, name, description, context.userId],
      );
      id = inserted.rows[0].id;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new Error("该标识已被占用，请换一个");
      }
      throw error;
    }

    await client.query(
      `insert into ai_employee_grants (tenant_id, ai_employee_id, user_id, capability, created_by)
       values ($1, $2, $3, 'manage', $3)
       on conflict (ai_employee_id, user_id) where user_id is not null do nothing`,
      [context.tenantId, id, context.userId],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "ai_employee.created",
      targetType: "ai_employee",
      targetId: id,
      payload: { slug, name },
    });
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "ai_employee.grant_added",
      targetType: "ai_employee",
      targetId: id,
      payload: { targetType: "user", targetId: context.userId, capability: "manage", reason: "creator" },
    });

    return { id, slug };
  });
}

/** 编辑：只允许改名称与描述；slug 参与对外引用，创建后保持不变 */
export async function updateAiEmployee(
  context: UserContext,
  aiEmployeeId: string,
  input: { name: string; description?: string | null },
): Promise<void> {
  assertCanManage(context);

  const name = input.name.trim();
  const description = normalizeDescription(input.description);
  if (name.length === 0 || name.length > 60) {
    throw new Error("名称不能为空且不超过 60 字");
  }
  if (description && description.length > 500) {
    throw new Error("描述不超过 500 字");
  }

  await withUserContext(context, async (client) => {
    const existing = await client.query<{ id: string }>(
      "select id from ai_employees where id = $1",
      [aiEmployeeId],
    );
    if (!existing.rows[0]) {
      throw new Error("AI 员工不存在或无权操作");
    }

    await client.query(
      "update ai_employees set name = $2, description = $3 where id = $1",
      [aiEmployeeId, name, description],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "ai_employee.updated",
      targetType: "ai_employee",
      targetId: aiEmployeeId,
      payload: { name },
    });
  });
}

/** 状态切换：draft → active → disabled 均可（不提供删除，停用即下线） */
export async function setAiEmployeeStatus(
  context: UserContext,
  aiEmployeeId: string,
  status: AiEmployeeStatus,
): Promise<void> {
  assertCanManage(context);
  if (!isAiEmployeeStatus(status)) {
    throw new Error("状态不合法");
  }

  await withUserContext(context, async (client) => {
    const existing = await client.query<{ id: string }>(
      "select id from ai_employees where id = $1",
      [aiEmployeeId],
    );
    if (!existing.rows[0]) {
      throw new Error("AI 员工不存在或无权操作");
    }

    await client.query("update ai_employees set status = $2 where id = $1", [aiEmployeeId, status]);

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "ai_employee.status_changed",
      targetType: "ai_employee",
      targetId: aiEmployeeId,
      payload: { status },
    });
  });
}

async function ensureEmployeeExists(client: PoolClient, aiEmployeeId: string): Promise<void> {
  const existing = await client.query<{ id: string }>(
    "select id from ai_employees where id = $1",
    [aiEmployeeId],
  );
  if (!existing.rows[0]) {
    throw new Error("AI 员工不存在或无权操作");
  }
}

/** 部门授权：授权父部门即覆盖其整棵子树（由 department_closure 判定） */
export async function grantAiEmployeeToDepartment(
  context: UserContext,
  aiEmployeeId: string,
  departmentId: string,
): Promise<void> {
  assertCanManage(context);

  await withUserContext(context, async (client) => {
    await ensureEmployeeExists(client, aiEmployeeId);

    const department = await client.query<{ id: string; name: string }>(
      "select id, name from departments where id = $1",
      [departmentId],
    );
    if (!department.rows[0]) {
      throw new Error("部门不存在或无权操作");
    }

    await client.query(
      `insert into ai_employee_grants (tenant_id, ai_employee_id, department_id, capability, created_by)
       values ($1, $2, $3, 'use', $4)
       on conflict (ai_employee_id, department_id) where department_id is not null do nothing`,
      [context.tenantId, aiEmployeeId, departmentId, context.userId],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "ai_employee.grant_added",
      targetType: "ai_employee",
      targetId: aiEmployeeId,
      payload: { targetType: "department", targetId: departmentId, capability: "use" },
    });
  });
}

/** 个人授权：部门授权之外的单点例外 */
export async function grantAiEmployeeToUser(
  context: UserContext,
  aiEmployeeId: string,
  userId: string,
): Promise<void> {
  assertCanManage(context);

  await withUserContext(context, async (client) => {
    await ensureEmployeeExists(client, aiEmployeeId);

    const user = await client.query<{ id: string; name: string }>(
      "select id, name from users where id = $1",
      [userId],
    );
    if (!user.rows[0]) {
      throw new Error("成员不存在");
    }

    await client.query(
      `insert into ai_employee_grants (tenant_id, ai_employee_id, user_id, capability, created_by)
       values ($1, $2, $3, 'use', $4)
       on conflict (ai_employee_id, user_id) where user_id is not null do nothing`,
      [context.tenantId, aiEmployeeId, userId, context.userId],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "ai_employee.grant_added",
      targetType: "ai_employee",
      targetId: aiEmployeeId,
      payload: { targetType: "user", targetId: userId, capability: "use" },
    });
  });
}

/** 撤回授权：创建者的 manage 授权不可移除（否则草稿会失去可见入口） */
export async function revokeAiEmployeeGrant(context: UserContext, grantId: string): Promise<void> {
  assertCanManage(context);

  await withUserContext(context, async (client) => {
    const grant = await client.query<{
      id: string;
      ai_employee_id: string;
      user_id: string | null;
      department_id: string | null;
      capability: "use" | "manage";
    }>(
      `select id, ai_employee_id, user_id, department_id, capability
         from ai_employee_grants where id = $1`,
      [grantId],
    );
    const row = grant.rows[0];
    if (!row) {
      throw new Error("授权不存在或无权操作");
    }

    if (row.capability === "manage" && row.user_id) {
      const employee = await client.query<{ created_by: string | null }>(
        "select created_by from ai_employees where id = $1",
        [row.ai_employee_id],
      );
      if (employee.rows[0]?.created_by === row.user_id) {
        throw new Error("创建者的管理授权不可移除");
      }
    }

    await client.query("delete from ai_employee_grants where id = $1", [grantId]);

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "ai_employee.grant_removed",
      targetType: "ai_employee",
      targetId: row.ai_employee_id,
      payload: {
        targetType: row.department_id ? "department" : "user",
        targetId: row.department_id ?? row.user_id,
        capability: row.capability,
      },
    });
  });
}

/** 授权候选：L1 管理面板的部门与成员下拉 */
export async function listAiEmployeeGrantCandidates(
  context: UserContext,
): Promise<AiEmployeeGrantCandidates> {
  assertCanManage(context);

  return withUserContext(context, async (client) => {
    const departments = await client.query<{ id: string; name: string }>(
      "select id, name from departments order by sort_order, name",
    );
    const users = await client.query<{ id: string; name: string; email: string }>(
      `select distinct u.id, u.name, u.email
         from users u
         join memberships m on m.user_id = u.id and m.status = 'active'
        order by u.name
        limit 200`,
    );

    return { departments: departments.rows, users: users.rows };
  });
}
