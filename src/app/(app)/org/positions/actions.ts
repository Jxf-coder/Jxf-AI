"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { auditInTx } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";

const ROLE_KINDS = ["child", "seat"] as const;
const ACCESS_LEVELS = ["L1", "L2", "L3"] as const;

function readText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function createRole(formData: FormData): Promise<void> {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const kind = readText(formData, "kind");
  const name = readText(formData, "name");
  const slug = readText(formData, "slug");
  const parentId = readText(formData, "parentId");

  if (!ROLE_KINDS.includes(kind as (typeof ROLE_KINDS)[number])) {
    throw new Error("岗位类型非法（根岗位由初始化种子创建）");
  }
  if (!name || name.length > 80) {
    throw new Error("岗位名称必填且不超过 80 字符");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) {
    throw new Error("slug 只能包含小写字母、数字与中划线");
  }
  if (!parentId) {
    throw new Error("非根岗位必须选择上级岗位");
  }

  const roleId = randomUUID();

  await withUserContext(context, async (client) => {
    // 不使用 INSERT ... RETURNING：新岗位尚未进入闭包，RETURNING 会触发 SELECT 策略
    await client.query(
      `insert into roles (id, tenant_id, parent_id, kind, slug, name)
       values ($1, $2, $3, $4, $5, $6)`,
      [roleId, context.tenantId, parentId, kind, slug, name],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "role.created",
      targetType: "role",
      targetId: roleId,
      payload: { kind, slug, name, parentId },
    });
  });

  revalidatePath("/org/positions");
}

export async function addMember(formData: FormData): Promise<void> {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const roleId = readText(formData, "roleId");
  const email = readText(formData, "email").toLowerCase();
  const accessLevel = readText(formData, "accessLevel");

  if (!roleId || !/^[0-9a-f-]{36}$/i.test(roleId)) {
    throw new Error("岗位非法");
  }
  if (!email) {
    throw new Error("成员邮箱必填");
  }
  if (!ACCESS_LEVELS.includes(accessLevel as (typeof ACCESS_LEVELS)[number])) {
    throw new Error("访问等级非法");
  }

  await withUserContext(context, async (client) => {
    const user = await client.query<{ id: string }>("select id from users where email = $1", [email]);
    if (user.rows.length === 0) {
      throw new Error("该邮箱尚未注册，请先创建用户");
    }

    let membershipId: string;
    try {
      const inserted = await client.query<{ id: string }>(
        `insert into memberships (tenant_id, user_id, role_id, access_level)
         values ($1, $2, $3, $4)
         returning id`,
        [context.tenantId, user.rows[0].id, roleId, accessLevel],
      );
      membershipId = inserted.rows[0].id;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new Error("该用户已在此岗位有有效任用");
      }
      throw error;
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "membership.created",
      targetType: "membership",
      targetId: membershipId,
      payload: { roleId, email, accessLevel },
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
