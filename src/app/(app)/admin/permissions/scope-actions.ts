"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { auditInTx } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { requireProtectedCapability, toPermissionMessage } from "@/lib/permissions/guard";
import { resolveContextPermissions } from "@/lib/permissions/server";

type ActionResult = { ok: true; message: string } | { ok: false; message: string };

const DOMAINS = new Set(["crm", "trade", "mail", "reminder"]);
const SCOPE_TYPES = new Set(["USERS", "DEPARTMENTS", "ALL"]);
const SCOPE_CAPABILITIES = new Set(["read", "write", "manage"]);
const SHARE_CAPABILITIES = new Set(["read", "write", "manage"]);

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

function refresh(): void {
  revalidatePath("/admin/permissions");
}

/** 数据范围例外：给某个成员临时开放跨人 / 跨部门的数据范围 */
export async function saveScopeGrant(input: {
  granteeUserId: string;
  domain: string;
  scopeType: string;
  scopeRefs: unknown;
  capability: string;
  validUntil: string;
  reason: string;
}): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const granteeUserId = text(input.granteeUserId);
    const domain = text(input.domain);
    const scopeType = text(input.scopeType);
    const capability = text(input.capability);
    const refs = uniqueIds(input.scopeRefs);
    const validUntil = text(input.validUntil);
    const reason = text(input.reason);

    if (!granteeUserId) {
      throw new Error("请选择被授权成员");
    }
    if (!DOMAINS.has(domain)) {
      throw new Error("授权域只支持 crm / trade / mail / reminder");
    }
    if (!SCOPE_TYPES.has(scopeType)) {
      throw new Error("范围类型只支持 指定成员 / 指定部门 / 全部");
    }
    if (!SCOPE_CAPABILITIES.has(capability)) {
      throw new Error("能力只支持 read / write / manage");
    }
    if (scopeType === "ALL" && refs.length > 0) {
      throw new Error("「全部」范围不需要选择对象");
    }
    if (scopeType !== "ALL" && refs.length === 0) {
      throw new Error("请选择授权对象");
    }
    if (reason.length > 200) {
      throw new Error("原因不超过 200 字符");
    }

    await withUserContext(context, async (client) => {
      const actor = await resolveContextPermissions(client, context);
      requireProtectedCapability(actor, "protected:permission_grant");

      const grantee = await client.query<{ name: string | null; department_id: string }>(
        `select u.name, m.department_id
           from memberships m
           join users u on u.id = m.user_id
          where m.user_id = $1
            and m.tenant_id = $2
            and m.status = 'active'
          order by m.created_at
          limit 1`,
        [granteeUserId, context.tenantId],
      );
      const target = grantee.rows[0];
      if (!target) {
        throw new Error("被授权成员不存在或没有有效任用");
      }

      if (scopeType === "USERS") {
        const count = await client.query<{ count: number | string }>(
          `select count(*)::int as count
             from users u
             join memberships m on m.user_id = u.id and m.tenant_id = $1 and m.status = 'active'
            where u.id = any($2::uuid[])`,
          [context.tenantId, refs],
        );
        if (Number(count.rows[0]?.count ?? 0) !== refs.length) {
          throw new Error("授权对象里有成员不存在或已离职");
        }
      }
      if (scopeType === "DEPARTMENTS") {
        const count = await client.query<{ count: number | string }>(
          "select count(*)::int as count from departments where tenant_id = $1 and id = any($2::uuid[])",
          [context.tenantId, refs],
        );
        if (Number(count.rows[0]?.count ?? 0) !== refs.length) {
          throw new Error("授权对象里有部门不存在");
        }
      }

      await client.query(
        `insert into data_scope_grants
           (tenant_id, grantee_user_id, domain, scope_type, scope_refs,
            capability, valid_from, valid_until, granted_by, reason)
         values ($1, $2, $3, $4, $5::uuid[], $6, now(), $7::timestamptz, $8, $9)`,
        [
          context.tenantId,
          granteeUserId,
          domain,
          scopeType,
          scopeType === "ALL" ? [] : refs,
          capability,
          validUntil || null,
          context.userId,
          reason || null,
        ],
      );

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: target.department_id,
        action: "permission.scope_grant_created",
        targetType: "user",
        targetId: granteeUserId,
        payload: {
          granteeName: target.name,
          domain,
          scopeType,
          scopeRefs: scopeType === "ALL" ? [] : refs,
          capability,
          validUntil: validUntil || null,
          reason,
        },
      });
    });

    refresh();
    return { ok: true, message: "数据范围例外已生效" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function deleteScopeGrant(input: { id: string }): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);
    const id = text(input.id);
    if (!id) {
      throw new Error("授权 ID 缺失");
    }

    await withUserContext(context, async (client) => {
      const actor = await resolveContextPermissions(client, context);
      requireProtectedCapability(actor, "protected:permission_grant");

      const row = await client.query<{
        grantee_user_id: string;
        domain: string;
        capability: string;
      }>(
        `select grantee_user_id, domain, capability
           from data_scope_grants
          where id = $1 and tenant_id = $2`,
        [id, context.tenantId],
      );
      const grant = row.rows[0];
      if (!grant) {
        throw new Error("授权记录不存在");
      }

      await client.query("delete from data_scope_grants where id = $1", [id]);

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: context.activeDepartmentId,
        action: "permission.scope_grant_revoked",
        targetType: "user",
        targetId: grant.grantee_user_id,
        payload: { domain: grant.domain, capability: grant.capability },
      });
    });

    refresh();
    return { ok: true, message: "已撤销该数据范围例外" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

/** 单条资源共享：把某个客户的读 / 写 / 管理权例外开放给指定成员 */
export async function shareResource(input: {
  resourceType: string;
  resourceId: string;
  granteeUserId: string;
  capability: string;
  validUntil: string;
  reason: string;
}): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const resourceType = text(input.resourceType) || "crm_account";
    const resourceId = text(input.resourceId);
    const granteeUserId = text(input.granteeUserId);
    const capability = text(input.capability);
    const validUntil = text(input.validUntil);
    const reason = text(input.reason);

    if (resourceType !== "crm_account") {
      throw new Error("当前版本仅支持共享客户");
    }
    if (!resourceId) {
      throw new Error("请选择要共享的客户");
    }
    if (!granteeUserId) {
      throw new Error("请选择共享给谁");
    }
    if (!SHARE_CAPABILITIES.has(capability)) {
      throw new Error("共享能力只支持 read / write / manage");
    }
    if (reason.length > 200) {
      throw new Error("原因不超过 200 字符");
    }

    await withUserContext(context, async (client) => {
      const actor = await resolveContextPermissions(client, context);
      requireProtectedCapability(actor, "protected:permission_grant");

      const account = await client.query<{ name: string; department_id: string }>(
        "select name, department_id from crm_accounts where id = $1 and archived_at is null",
        [resourceId],
      );
      const targetAccount = account.rows[0];
      if (!targetAccount) {
        throw new Error("客户不存在或无权访问");
      }

      const grantee = await client.query<{ name: string | null }>(
        `select u.name
           from memberships m
           join users u on u.id = m.user_id
          where m.user_id = $1 and m.tenant_id = $2 and m.status = 'active'
          limit 1`,
        [granteeUserId, context.tenantId],
      );
      if (grantee.rowCount === 0) {
        throw new Error("被共享成员不存在或没有有效任用");
      }

      try {
        await client.query(
          `insert into resource_shares
             (tenant_id, resource_type, resource_id, grantee_user_id,
              capability, valid_from, valid_until, granted_by, reason)
           values ($1, $2, $3, $4, $5, now(), $6::timestamptz, $7, $8)`,
          [
            context.tenantId,
            resourceType,
            resourceId,
            granteeUserId,
            capability,
            validUntil || null,
            context.userId,
            reason || null,
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new Error("该成员已拥有同能力的共享，请先撤销或改选能力");
        }
        throw error;
      }

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: targetAccount.department_id,
        action: "permission.resource_shared",
        targetType: "crm_account",
        targetId: resourceId,
        payload: {
          accountName: targetAccount.name,
          granteeUserId,
          granteeName: grantee.rows[0]?.name ?? null,
          capability,
          validUntil: validUntil || null,
          reason,
        },
      });
    });

    refresh();
    return { ok: true, message: "资源共享已生效" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}

export async function unshareResource(input: { id: string }): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);
    const id = text(input.id);
    if (!id) {
      throw new Error("共享 ID 缺失");
    }

    await withUserContext(context, async (client) => {
      const actor = await resolveContextPermissions(client, context);
      requireProtectedCapability(actor, "protected:permission_grant");

      const row = await client.query<{
        resource_id: string;
        grantee_user_id: string;
        capability: string;
      }>(
        `select resource_id, grantee_user_id, capability
           from resource_shares
          where id = $1 and tenant_id = $2`,
        [id, context.tenantId],
      );
      if (row.rowCount === 0) {
        throw new Error("共享记录不存在");
      }
      await client.query("delete from resource_shares where id = $1", [id]);

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: context.activeDepartmentId,
        action: "permission.resource_unshared",
        targetType: "crm_account",
        targetId: row.rows[0]?.resource_id,
        payload: {
          granteeUserId: row.rows[0]?.grantee_user_id,
          capability: row.rows[0]?.capability,
        },
      });
    });

    refresh();
    return { ok: true, message: "已撤销该资源共享" };
  } catch (error) {
    return { ok: false, message: toPermissionMessage(error) };
  }
}
