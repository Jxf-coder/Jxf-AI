"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { auditInTx } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { slugifyDepartmentName } from "@/lib/org/slug";

const ACCESS_LEVELS = ["L1", "L2", "L3"] as const;

function readText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function assertName(name: string, label: string): void {
  if (!name || name.length > 80) {
    throw new Error(`${label}必填且不超过 80 字符`);
  }
}

/** 手机号作为唯一主账号标识：去掉空格与中划线后校验 */
function normalizePhone(input: string): string {
  const phone = input.replace(/[\s-]/g, "");
  if (!/^\+?\d{6,20}$/.test(phone)) {
    throw new Error("手机号格式不正确");
  }
  return phone;
}

function normalizeEmail(input: string): string {
  const email = input.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error("邮箱格式不正确");
  }
  return email;
}

/** 同父级下 slug 重名时追加 -2 / -3 … */
async function generateUniqueSlug(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> },
  tenantId: string,
  parentId: string,
  name: string,
): Promise<string> {
  const base = slugifyDepartmentName(name);
  for (let index = 2; index < 100; index += 1) {
    const candidate = index === 2 ? base : `${base}-${index}`;
    const existing = await client.query(
      `select 1 from departments
        where tenant_id = $1 and parent_id = $2 and slug = $3
        limit 1`,
      [tenantId, parentId, candidate],
    );
    if (existing.rows.length === 0) {
      return candidate;
    }
  }
  return `${base}-${Date.now()}`;
}

export async function createDepartment(formData: FormData): Promise<void> {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const name = readText(formData, "name");
  const parentId = readText(formData, "parentId");

  assertName(name, "部门名称");
  if (!parentId) {
    throw new Error("请选择上级部门");
  }

  const departmentId = randomUUID();

  await withUserContext(context, async (client) => {
    // 页面数据过期（例如数据库已重置）时，旧 parentId 会直接触发 RLS 失败，这里先给出可读提示
    const parent = await client.query("select id from departments where id = $1", [parentId]);
    if (parent.rows.length === 0) {
      throw new Error("上级部门已失效，请刷新页面后重试");
    }

    const slug = await generateUniqueSlug(client, context.tenantId, parentId, name);

    // 不使用 RETURNING：新部门尚未进入闭包，RETURNING 会触发 SELECT 策略
    try {
      await client.query(
        `insert into departments (id, tenant_id, parent_id, name, slug)
         values ($1, $2, $3, $4, $5)`,
        [departmentId, context.tenantId, parentId, name, slug],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "42501") {
        throw new Error("无权限在该上级部门下新建部门");
      }
      throw error;
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "department.created",
      targetType: "department",
      targetId: departmentId,
      payload: { name, slug, parentId },
    });
  });

  revalidatePath("/org/positions");
}

export async function updateDepartment(formData: FormData): Promise<void> {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const departmentId = readText(formData, "departmentId");
  const name = readText(formData, "name");

  if (!departmentId) {
    throw new Error("部门 ID 缺失");
  }
  assertName(name, "部门名称");

  await withUserContext(context, async (client) => {
    const target = await client.query<{ parent_id: string | null }>(
      "select parent_id from departments where id = $1",
      [departmentId],
    );
    if (target.rows.length === 0) {
      throw new Error("部门不存在或无权限修改");
    }
    if (target.rows[0].parent_id === null) {
      throw new Error("根节点「老板」是系统控制权入口，不可改名");
    }

    // slug 是内部标识，改名不重建，避免历史引用失效
    const updated = await client.query("update departments set name = $1 where id = $2", [
      name,
      departmentId,
    ]);

    if (updated.rowCount === 0) {
      throw new Error("部门不存在或无权限修改");
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "department.updated",
      targetType: "department",
      targetId: departmentId,
      payload: { name },
    });
  });

  revalidatePath("/org/positions");
}

export async function deleteDepartment(formData: FormData): Promise<void> {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const departmentId = readText(formData, "departmentId");
  if (!departmentId) {
    throw new Error("部门 ID 缺失");
  }

  await withUserContext(context, async (client) => {
    const target = await client.query<{ parent_id: string | null; name: string }>(
      "select parent_id, name from departments where id = $1",
      [departmentId],
    );
    const department = target.rows[0];
    if (!department) {
      throw new Error("部门不存在或无权限删除");
    }
    if (department.parent_id === null) {
      throw new Error("根节点为系统控制权入口，不可删除");
    }

    try {
      const deleted = await client.query("delete from departments where id = $1", [departmentId]);
      if (deleted.rowCount === 0) {
        throw new Error("无权限删除该部门");
      }
    } catch (error) {
      if ((error as { code?: string }).code === "23503") {
        throw new Error("该部门下还有子部门或成员，请先清空后再删除");
      }
      throw error;
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "department.deleted",
      targetType: "department",
      targetId: departmentId,
      payload: { name: department.name },
    });
  });

  revalidatePath("/org/positions");
}

export async function addMember(formData: FormData): Promise<void> {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const departmentId = readText(formData, "departmentId");
  const name = readText(formData, "name");
  const phone = normalizePhone(readText(formData, "phone"));
  const emailInput = readText(formData, "email");
  const email = emailInput ? normalizeEmail(emailInput) : null;
  const title = readText(formData, "title");
  const accessLevel = readText(formData, "accessLevel");

  if (!departmentId) {
    throw new Error("请选择所属部门");
  }
  if (!name || name.length > 40) {
    throw new Error("姓名必填且不超过 40 字符");
  }
  if (!title || title.length > 40) {
    throw new Error("业务岗位必填且不超过 40 字符");
  }
  if (!ACCESS_LEVELS.includes(accessLevel as (typeof ACCESS_LEVELS)[number])) {
    throw new Error("权限等级非法");
  }

  await withUserContext(context, async (client) => {
    const department = await client.query("select id from departments where id = $1", [
      departmentId,
    ]);
    if (department.rows.length === 0) {
      throw new Error("所属部门已失效，请刷新页面后重试");
    }

    const existing = await client.query<{ id: string }>(
      "select id from users where phone = $1",
      [phone],
    );

    let userId: string;
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      await client.query("update users set name = $1 where id = $2", [name, userId]);
    } else {
      const created = await client.query<{ id: string }>(
        `insert into users (name, phone, email)
         values ($1, $2, $3)
         returning id`,
        [name, phone, email],
      );
      userId = created.rows[0].id;
    }

    if (email) {
      const identityOwner = await client.query<{ user_id: string }>(
        "select user_id from user_email_identities where tenant_id = $1 and email = $2",
        [context.tenantId, email],
      );
      if (identityOwner.rows.length > 0 && identityOwner.rows[0].user_id !== userId) {
        throw new Error("该邮箱已绑定其他成员");
      }

      const emailOwner = await client.query<{ id: string }>("select id from users where email = $1", [
        email,
      ]);
      if (emailOwner.rows.length > 0 && emailOwner.rows[0].id !== userId) {
        throw new Error("该邮箱已被其他账号使用");
      }

      if (identityOwner.rows.length === 0) {
        await client.query(
          `insert into user_email_identities (tenant_id, user_id, email)
           values ($1, $2, $3)
           on conflict do nothing`,
          [context.tenantId, userId, email],
        );
      }

      await client.query("update users set email = coalesce(email, $1) where id = $2", [
        email,
        userId,
      ]);
    }

    let membershipId: string;
    try {
      const inserted = await client.query<{ id: string }>(
        `insert into memberships (tenant_id, user_id, department_id, title, access_level)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [context.tenantId, userId, departmentId, title, accessLevel],
      );
      membershipId = inserted.rows[0].id;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new Error("该成员已在此部门有有效任用");
      }
      if ((error as { code?: string }).code === "42501") {
        throw new Error("无权限在该部门添加成员");
      }
      throw error;
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "membership.created",
      targetType: "membership",
      targetId: membershipId,
      payload: { departmentId, userId, phone, email, title, accessLevel },
    });
  });

  revalidatePath("/org/positions");
}

export async function removeMember(formData: FormData): Promise<void> {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const membershipId = readText(formData, "membershipId");
  if (!membershipId) {
    throw new Error("任用 ID 缺失");
  }

  await withUserContext(context, async (client) => {
    await client.query("select app.remove_membership($1)", [membershipId]);
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "membership.removed",
      targetType: "membership",
      targetId: membershipId,
    });
  });

  revalidatePath("/org/positions");
}
