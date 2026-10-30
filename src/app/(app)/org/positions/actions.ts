"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { auditInTx } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";

const ACCESS_LEVELS = ["L1", "L2", "L3"] as const;

function readText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function assertSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) {
    throw new Error("slug 只能包含小写字母、数字与中划线");
  }
}

function assertName(name: string, label: string): void {
  if (!name || name.length > 80) {
    throw new Error(`${label}必填且不超过 80 字符`);
  }
}

export async function createDepartment(formData: FormData): Promise<void> {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const name = readText(formData, "name");
  const slug = readText(formData, "slug");
  const parentId = readText(formData, "parentId");

  assertName(name, "部门名称");
  assertSlug(slug);
  if (!parentId) {
    throw new Error("请选择上级部门（根部门由初始化种子创建）");
  }

  const departmentId = randomUUID();

  await withUserContext(context, async (client) => {
    // 不使用 RETURNING：新部门尚未进入闭包，RETURNING 会触发 SELECT 策略
    await client.query(
      `insert into departments (id, tenant_id, parent_id, name, slug)
       values ($1, $2, $3, $4, $5)`,
      [departmentId, context.tenantId, parentId, name, slug],
    );

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
  const slug = readText(formData, "slug");

  if (!departmentId) {
    throw new Error("部门 ID 缺失");
  }
  assertName(name, "部门名称");
  assertSlug(slug);

  await withUserContext(context, async (client) => {
    const updated = await client.query(
      "update departments set name = $1, slug = $2 where id = $3",
      [name, slug, departmentId],
    );

    if (updated.rowCount === 0) {
      throw new Error("部门不存在或无权限修改");
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "department.updated",
      targetType: "department",
      targetId: departmentId,
      payload: { name, slug },
    });
  });

  revalidatePath("/org/positions");
}

export async function addMember(formData: FormData): Promise<void> {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const departmentId = readText(formData, "departmentId");
  const email = readText(formData, "email").toLowerCase();
  const title = readText(formData, "title");
  const accessLevel = readText(formData, "accessLevel");

  if (!departmentId) {
    throw new Error("请选择所属部门");
  }
  if (!email) {
    throw new Error("成员邮箱必填");
  }
  if (!title || title.length > 40) {
    throw new Error("业务岗位必填且不超过 40 字符");
  }
  if (!ACCESS_LEVELS.includes(accessLevel as (typeof ACCESS_LEVELS)[number])) {
    throw new Error("权限等级非法");
  }

  await withUserContext(context, async (client) => {
    const user = await client.query<{ id: string }>("select id from users where email = $1", [email]);
    if (user.rows.length === 0) {
      throw new Error("该邮箱尚未注册，请先创建用户");
    }

    let membershipId: string;
    try {
      const inserted = await client.query<{ id: string }>(
        `insert into memberships (tenant_id, user_id, department_id, title, access_level)
         values ($1, $2, $3, $4, $5)
         returning id`,
        [context.tenantId, user.rows[0].id, departmentId, title, accessLevel],
      );
      membershipId = inserted.rows[0].id;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new Error("该用户已在此部门有有效任用");
      }
      throw error;
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "membership.created",
      targetType: "membership",
      targetId: membershipId,
      payload: { departmentId, email, title, accessLevel },
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
