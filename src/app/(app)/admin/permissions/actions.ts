"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { PoolClient } from "pg";

import { auditInTx } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { getPermissionNode, isPermissionKey } from "@/lib/permissions/catalog";
import { canGrant } from "@/lib/permissions/grant";
import { requireProtectedCapability, toPermissionMessage } from "@/lib/permissions/guard";
import { isPermissionScope } from "@/lib/permissions/scope";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { AdminPayloadGrant } from "@/types/permission-admin";
import type { ResolvedPermissions } from "@/types/permission";
import type { AccessLevel } from "@/types/profile";

type ActionResult =
  | { ok: true; message: string; version?: number }
  | { ok: false; message: string };

interface TargetMembership {
  user_id: string;
  department_id: string;
  department_name: string;
  membership_id: string;
  level: AccessLevel;
  name: string | null;
  phone: string | null;
}

function normalizeGrants(
  actor: ResolvedPermissions,
  target: { userId: string; level: AccessLevel },
  grants: unknown,
): AdminPayloadGrant[] {
  if (!Array.isArray(grants)) {
    throw new Error("授权数据格式不正确");
  }

  const seen = new Set<string>();
  const out: AdminPayloadGrant[] = [];

  for (const raw of grants) {
    if (!raw || typeof raw !== "object") {
      throw new Error("授权数据格式不正确");
    }
    const item = raw as { permissionKey?: unknown; scope?: unknown; effect?: unknown };
    if (!isPermissionKey(item.permissionKey)) {
      throw new Error(`未知权限点：${String(item.permissionKey ?? "")}`);
    }
    if (!isPermissionScope(item.scope)) {
      throw new Error(`非法作用域：${String(item.scope ?? "")}`);
    }
    const effect = item.effect === "deny" ? "deny" : "allow";
    const key = item.permissionKey;
    const node = getPermissionNode(key);

    if (!node.grantable) {
      throw new Error(`「${node.nameZh}」是系统保留能力，不能单独授权`);
    }
    if (seen.has(key)) {
      throw new Error(`权限点重复：${key}`);
    }

    const check = canGrant(actor, target, {
      permissionKey: key,
      scope: item.scope,
      effect,
    });
    if (!check.allowed) {
      throw new Error(check.reason);
    }

    seen.add(key);
    out.push({ permissionKey: key, scope: item.scope, effect });
  }

  return out;
}

async function loadTargetMembership(
  client: PoolClient,
  userId: string,
): Promise<TargetMembership> {
  const { rows } = await client.query<TargetMembership>(
    `select m.user_id, m.id as membership_id, m.department_id, m.access_level as level,
            d.name as department_name, u.name, u.phone
       from memberships m
       join departments d on d.id = m.department_id
       join users u on u.id = m.user_id
      where m.user_id = $1
        and m.status = 'active'
      order by m.created_at
      limit 1`,
    [userId],
  );

  const target = rows[0];
  if (!target) {
    throw new Error("目标成员不存在或没有有效任用");
  }
  return target;
}

function refreshPermissionViews(): void {
  revalidatePath("/admin/permissions");
  revalidatePath("/", "layout");
}

export async function saveMemberGrants(input: {
  userId: string;
  grants: unknown;
}): Promise<ActionResult> {
  const session = await requireSession();

  try {
    const userId = String(input?.userId ?? "").trim();
    if (!userId) {
      throw new Error("成员 ID 缺失");
    }

    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const result = await withUserContext(context, async (client) => {
      const actor = await resolveContextPermissions(client, context);
      requireProtectedCapability(actor, "protected:permission_grant");

      const target = await loadTargetMembership(client, userId);
      if (target.level === "L1") {
        throw new Error("L1 默认拥有全部权限，无需配置个人授权");
      }

      const grants = normalizeGrants(
        actor,
        { userId: target.user_id, level: target.level },
        input.grants,
      );

      const saved = await client.query<{ version: string | number }>(
        "select app.save_user_permission_grants($1, $2, $3::jsonb) as version",
        [target.user_id, target.department_id, JSON.stringify(grants)],
      );
      const version = Number(saved.rows[0]?.version ?? 0);

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: target.department_id,
        action: "permission.member_grants_updated",
        targetType: "user",
        targetId: target.user_id,
        payload: {
          targetName: target.name,
          targetPhone: target.phone,
          level: target.level,
          departmentName: target.department_name,
          count: grants.length,
          grants,
          version,
        },
      });

      return { version, count: grants.length };
    });

    refreshPermissionViews();
    return {
      ok: true,
      message: `已保存 ${result.count} 条个人授权`,
      version: result.version,
    };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function resetMemberGrants(input: { userId: string }): Promise<ActionResult> {
  const session = await requireSession();

  try {
    const userId = String(input?.userId ?? "").trim();
    if (!userId) {
      throw new Error("成员 ID 缺失");
    }

    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const result = await withUserContext(context, async (client) => {
      const actor = await resolveContextPermissions(client, context);
      requireProtectedCapability(actor, "protected:permission_grant");

      const target = await loadTargetMembership(client, userId);
      if (target.level === "L1") {
        throw new Error("L1 默认拥有全部权限，无需配置个人授权");
      }

      const saved = await client.query<{ version: string | number }>(
        "select app.clear_user_permission_grants($1) as version",
        [target.user_id],
      );
      const version = Number(saved.rows[0]?.version ?? 0);

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: target.department_id,
        action: "permission.member_grants_reset",
        targetType: "user",
        targetId: target.user_id,
        payload: {
          targetName: target.name,
          targetPhone: target.phone,
          level: target.level,
          departmentName: target.department_name,
          version,
        },
      });

      return { version };
    });

    refreshPermissionViews();
    return { ok: true, message: "已恢复为角色模板默认权限", version: result.version };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function saveTemplateGrants(input: {
  templateId: string;
  grants: unknown;
}): Promise<ActionResult> {
  const session = await requireSession();

  try {
    const templateId = String(input?.templateId ?? "").trim();
    if (!templateId) {
      throw new Error("角色模板 ID 缺失");
    }

    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const result = await withUserContext(context, async (client) => {
      const actor = await resolveContextPermissions(client, context);
      requireProtectedCapability(actor, "protected:permission_grant");

      const templateResult = await client.query<{ id: string; name: string; level: AccessLevel }>(
        "select id, name, level from role_templates where id = $1",
        [templateId],
      );
      const template = templateResult.rows[0];
      if (!template) {
        throw new Error("角色模板不存在");
      }
      if (template.level === "L1") {
        throw new Error("L1 模板是系统隐式全量，不能修改");
      }

      const grants = normalizeGrants(
        actor,
        { userId: context.userId, level: template.level },
        input.grants,
      );

      const saved = await client.query<{ count: number | string }>(
        "select app.save_role_template_grants($1, $2::jsonb) as count",
        [template.id, JSON.stringify(grants)],
      );
      const count = Number(saved.rows[0]?.count ?? 0);

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: context.activeDepartmentId,
        action: "permission.template_updated",
        targetType: "role_template",
        targetId: template.id,
        payload: {
          templateName: template.name,
          level: template.level,
          count,
          grants,
        },
      });

      return { count };
    });

    refreshPermissionViews();
    return { ok: true, message: `已保存角色模板（${result.count} 项）` };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}
