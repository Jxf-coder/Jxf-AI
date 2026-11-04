"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { auditInTx } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import {
  groupHandoverAssets,
  listHandoverAssets,
  type HandoverAsset,
} from "@/lib/handover/registry";
import { slugifyDepartmentName } from "@/lib/org/slug";
import { requireContextPermission } from "@/lib/permissions/server";

const ACCESS_LEVELS = ["L1", "L2", "L3"] as const;

interface MemberBlockers {
  open_work: number;
  assets: number;
}

/** 把预检计数拼成可读文案；为空时返回空字符串 */
function describeBlockers(blockers: MemberBlockers): string {
  const parts: string[] = [];
  if (blockers.open_work > 0) {
    parts.push(`${blockers.open_work} 个运行中的工作`);
  }
  if (blockers.assets > 0) {
    parts.push(`${blockers.assets} 项资产`);
  }
  return parts.join("、");
}

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

/** 拖拽类动作由客户端直接调用，需要把数据库错误翻译成可读提示而不是整页报错 */
function toActionMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    if (code === "42501") {
      return "无权限执行该操作";
    }
    if (code === "23505") {
      return "该成员已在目标部门有有效任用";
    }
    if (code === "P0002") {
      return "成员任用不存在或已失效";
    }
    if (code === "23514") {
      return "不能移出最后一位 L1 老板账号";
    }
    return error.message;
  }
  return "操作失败，请稍后重试";
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

    await requireContextPermission(client, context, "org:manage", {
      kind: "department",
      id: parentId,
      departmentId: parentId,
    });

    const slug = await generateUniqueSlug(client, context.tenantId, parentId, name);

    // 不使用 RETURNING：新部门尚未进入闭包，RETURNING 会触发 SELECT 策略
    try {
      await client.query(
        `insert into departments (id, tenant_id, parent_id, name, slug, sort_order)
         values ($1, $2, $3, $4, $5,
                 coalesce((select max(sort_order) + 1 from departments where parent_id = $3), 0))`,
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
      departmentId,
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

    await requireContextPermission(client, context, "org:manage", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

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
      departmentId,
      action: "department.updated",
      targetType: "department",
      targetId: departmentId,
      payload: { name },
    });
  });

  revalidatePath("/org/positions");
}

/** 删除部门：由客户端二次确认后调用，删除前仍需保证部门下没有子部门与成员 */
export async function deleteDepartment(
  departmentId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!departmentId) {
    return { ok: false, message: "部门 ID 缺失" };
  }

  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    await withUserContext(context, async (client) => {
      const target = await client.query<{ parent_id: string | null; name: string }>(
        "select parent_id, name from departments where id = $1",
        [departmentId],
      );
      const department = target.rows[0];
      if (!department) {
        throw new Error("部门不存在或无权限删除");
      }

      await requireContextPermission(client, context, "org:manage", {
        kind: "department",
        id: departmentId,
        departmentId,
      });

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
        departmentId,
        action: "department.deleted",
        targetType: "department",
        targetId: departmentId,
        payload: { name: department.name },
      });
    });

    revalidatePath("/org/positions");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toActionMessage(error) };
  }
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
    const department = await client.query<{ id: string; name: string }>(
      "select id, name from departments where id = $1",
      [departmentId],
    );
    if (department.rows.length === 0) {
      throw new Error("所属部门已失效，请刷新页面后重试");
    }
    const departmentName = department.rows[0].name;

    await requireContextPermission(client, context, "member:manage", {
      kind: "membership",
      departmentId,
    });

    // 新增 L1 / L2 属于调整权限等级，必须单独校验（v1 仅 L1 通过）
    if (accessLevel !== "L3") {
      await requireContextPermission(client, context, "member:level", {
        kind: "membership",
        departmentId,
      });
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
        // 首个邮箱自动成为默认主邮箱，保证「默认发件箱」始终有值
        await client.query(
          `insert into user_email_identities (tenant_id, user_id, email, is_primary)
           values ($1, $2, $3,
                   not exists (select 1 from user_email_identities where user_id = $2))
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
      departmentId,
      action: "membership.created",
      targetType: "membership",
      targetId: membershipId,
      payload: { departmentId, departmentName, userId, phone, email, title, accessLevel },
    });
  });

  revalidatePath("/org/positions");
}

/**
 * 移出成员：只做软删除（status = 'removed'），
 * 由数据库函数 app.remove_membership 保证权限、保留最后一位 L1、且绝不物理删除。
 */
export async function removeMember(
  membershipId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!membershipId) {
    return { ok: false, message: "任用 ID 缺失" };
  }

  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    await withUserContext(context, async (client) => {
      const target = await client.query<{ department_id: string }>(
        "select department_id from memberships where id = $1 and status = 'active'",
        [membershipId],
      );
      if (target.rows.length === 0) {
        throw new Error("成员任用不存在或已失效");
      }

      await requireContextPermission(client, context, "member:manage", {
        kind: "membership",
        id: membershipId,
        departmentId: target.rows[0].department_id,
      });

      // 移出前预检：仍有运行中的工作或未改派资产时，走交接审批而不是直接移出
      const blockerRows = await client.query<{ blockers: MemberBlockers }>(
        "select app.membership_blockers($1) as blockers",
        [membershipId],
      );
      const blockers = blockerRows.rows[0]?.blockers;
      if (blockers && (blockers.open_work > 0 || blockers.assets > 0)) {
        throw new Error(
          `该成员还有${describeBlockers(blockers)}未交接，请使用「交接并移出」发起审批`,
        );
      }

      const infoResult = await client.query<{
        department_id: string;
        department_name: string;
        title: string;
        member_name: string | null;
        member_phone: string | null;
      }>(
        `select m.department_id, d.name as department_name, m.title,
                u.name as member_name, u.phone as member_phone
           from memberships m
           join departments d on d.id = m.department_id
           join users u on u.id = m.user_id
          where m.id = $1 and m.status = 'active'`,
        [membershipId],
      );
      const info = infoResult.rows[0];

      await client.query("select app.remove_membership($1)", [membershipId]);
      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: info?.department_id ?? null,
        action: "membership.removed",
        targetType: "membership",
        targetId: membershipId,
        payload: {
          softDelete: true,
          departmentName: info?.department_name ?? null,
          title: info?.title ?? null,
          memberName: info?.member_name ?? null,
          memberPhone: info?.member_phone ?? null,
        },
      });
    });

    revalidatePath("/org/positions");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toActionMessage(error) };
  }
}

/** 交接明细：资产 → 接收人 */
export interface HandoverAssignment {
  assetType: string;
  assetId: string;
  toUserId: string;
}

/**
 * 有资产的成员移出：逐条指定接收人后生成审批单。
 * 提交后成员立即进入 pending_removal（无法登录），由 L1 在审批中心通过后正式停用。
 */
export async function requestMemberRemoval(
  membershipId: string,
  assignments: HandoverAssignment[],
): Promise<{ ok: true; approvalId: string } | { ok: false; message: string }> {
  if (!membershipId) {
    return { ok: false, message: "任用 ID 缺失" };
  }
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return { ok: false, message: "请为需要交接的资产选择接收人" };
  }

  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const approvalId = await withUserContext(context, async (client) => {
      const target = await client.query<{
        department_id: string;
        department_name: string;
        user_id: string;
        member_name: string | null;
      }>(
        `select m.department_id, d.name as department_name, m.user_id, u.name as member_name
           from memberships m
           join departments d on d.id = m.department_id
           join users u on u.id = m.user_id
          where m.id = $1 and m.status = 'active'`,
        [membershipId],
      );
      const info = target.rows[0];
      if (!info) {
        throw new Error("成员任用不存在或已失效");
      }

      await requireContextPermission(client, context, "member:manage", {
        kind: "membership",
        id: membershipId,
        departmentId: info.department_id,
      });

      const assets = await listHandoverAssets(client, info.user_id);
      if (assets.length === 0) {
        throw new Error("该成员没有需要交接的资产，请直接移出");
      }

      const byAssetKey = new Map(
        assets.map((asset) => [`${asset.assetType}:${asset.assetId}`, asset]),
      );
      const normalized = assignments.map((item) => {
        const asset = byAssetKey.get(`${item.assetType}:${item.assetId}`);
        if (!asset) {
          throw new Error("交接资产已变化，请刷新后重试");
        }
        if (!item.toUserId) {
          throw new Error("请为全部资产选择接收人");
        }
        return { assetType: asset.assetType, assetId: asset.assetId, toUserId: item.toUserId };
      });
      if (new Set(normalized.map((item) => `${item.assetType}:${item.assetId}`)).size !== assets.length) {
        throw new Error("请为全部资产选择接收人");
      }

      for (const recipientId of new Set(normalized.map((item) => item.toUserId))) {
        if (recipientId === info.user_id) {
          throw new Error("接收人不能是即将移出的成员");
        }
        const recipient = await client.query<{ id: string }>(
          `select m.id from memberships m
            where m.user_id = $1 and m.status = 'active'
            limit 1`,
          [recipientId],
        );
        if (recipient.rows.length === 0) {
          throw new Error("接收人没有有效任用，请重新选择");
        }
      }

      const created = await client.query<{ approval_id: string }>(
        "select app.create_membership_removal_request($1, $2::jsonb) as approval_id",
        [membershipId, JSON.stringify(normalized)],
      );
      const newApprovalId = created.rows[0]?.approval_id;
      if (!newApprovalId) {
        throw new Error("审批单创建失败，请稍后重试");
      }

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: info.department_id,
        action: "membership.removal_requested",
        targetType: "membership",
        targetId: membershipId,
        payload: {
          approvalId: newApprovalId,
          departmentName: info.department_name,
          memberName: info.member_name,
          assetCount: normalized.length,
        },
      });

      return newApprovalId;
    });

    revalidatePath("/org/positions");
    revalidatePath("/me/approvals");
    return { ok: true, approvalId };
  } catch (error) {
    return { ok: false, message: toActionMessage(error) };
  }
}

/** 移出前预检：返回该成员运行中的工作与按类型分组的待交接资产，供客户端提前拦截并提示改派 */
export async function checkMemberBlockers(
  membershipId: string,
): Promise<
  | {
      ok: true;
      openWork: number;
      assets: number;
      groups: Array<{ assetType: string; label: string; items: HandoverAsset[] }>;
    }
  | { ok: false; message: string }
> {
  if (!membershipId) {
    return { ok: false, message: "任用 ID 缺失" };
  }

  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const result = await withUserContext(context, async (client) => {
      const target = await client.query<{ department_id: string; user_id: string }>(
        "select department_id, user_id from memberships where id = $1",
        [membershipId],
      );
      if (target.rows.length === 0) {
        throw new Error("成员任用不存在或已失效");
      }

      await requireContextPermission(client, context, "member:view", {
        kind: "membership",
        id: membershipId,
        departmentId: target.rows[0].department_id,
        ownerUserId: target.rows[0].user_id,
      });

      const blockerRows = await client.query<{ blockers: MemberBlockers }>(
        "select app.membership_blockers($1) as blockers",
        [membershipId],
      );
      const blockers = blockerRows.rows[0]?.blockers ?? { open_work: 0, assets: 0 };
      const assets = await listHandoverAssets(client, target.rows[0].user_id);
      return { blockers, assets };
    });

    return {
      ok: true,
      openWork: result.blockers.open_work ?? 0,
      assets: result.blockers.assets ?? 0,
      groups: groupHandoverAssets(result.assets),
    };
  } catch (error) {
    return { ok: false, message: toActionMessage(error) };
  }
}

/** 重新激活已停用成员：status 从 removed 恢复为 active，同样不做任何物理删除 */
export async function restoreMember(
  membershipId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!membershipId) {
    return { ok: false, message: "任用 ID 缺失" };
  }

  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    await withUserContext(context, async (client) => {
      const infoResult = await client.query<{
        department_id: string;
        department_name: string;
        title: string;
        member_name: string | null;
      }>(
        `select m.department_id, d.name as department_name, m.title, u.name as member_name
           from memberships m
           join departments d on d.id = m.department_id
           join users u on u.id = m.user_id
          where m.id = $1 and m.status = 'removed'`,
        [membershipId],
      );
      const info = infoResult.rows[0];
      if (!info) {
        throw new Error("成员任用不存在或已失效");
      }

      await requireContextPermission(client, context, "member:manage", {
        kind: "membership",
        id: membershipId,
        departmentId: info.department_id,
      });

      await client.query("select app.restore_membership($1)", [membershipId]);
      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: info?.department_id ?? null,
        action: "membership.restored",
        targetType: "membership",
        targetId: membershipId,
        payload: {
          departmentName: info?.department_name ?? null,
          title: info?.title ?? null,
          memberName: info?.member_name ?? null,
        },
      });
    });

    revalidatePath("/org/positions");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toActionMessage(error) };
  }
}

/**
 * 拖拽排序：把 draggedId 移到同一上级下 targetId 的前面。
 * 只调整同级顺序，不改变上级关系；根节点「老板」不可参与排序。
 */
export async function reorderDepartments(
  draggedId: string,
  targetId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!draggedId || !targetId || draggedId === targetId) {
    return { ok: true };
  }

  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    await withUserContext(context, async (client) => {
      const nodes = await client.query<{ id: string; parent_id: string | null; name: string }>(
        "select id, parent_id, name from departments where id = any($1::uuid[])",
        [[draggedId, targetId]],
      );
      const dragged = nodes.rows.find((row) => row.id === draggedId);
      const target = nodes.rows.find((row) => row.id === targetId);
      if (!dragged || !target) {
        throw new Error("部门不存在或无权限调整");
      }
      if (dragged.parent_id === null) {
        throw new Error("根节点「老板」不可调整顺序");
      }
      if (dragged.parent_id !== target.parent_id) {
        throw new Error("只能在同一上级部门下调整顺序");
      }

      await requireContextPermission(client, context, "org:manage", {
        kind: "department",
        id: draggedId,
        departmentId: draggedId,
      });

      const siblings = await client.query<{ id: string }>(
        `select id from departments
          where parent_id = $1
          order by sort_order, created_at`,
        [dragged.parent_id],
      );
      const currentOrder = siblings.rows.map((row) => row.id);
      const nextOrder = currentOrder.filter((id) => id !== draggedId);
      const targetIndex = nextOrder.indexOf(targetId);
      if (targetIndex < 0) {
        throw new Error("目标部门不在同一上级下");
      }
      nextOrder.splice(targetIndex, 0, draggedId);

      // 只更新位置实际变化的部门，避免无意义的行更新与闭包重建
      const changed = nextOrder
        .map((id, index) => ({ id, order: index }))
        .filter((item) => currentOrder[item.order] !== item.id);
      if (changed.length === 0) {
        return;
      }

      await client.query(
        `update departments d
            set sort_order = v.ord
           from unnest($1::uuid[], $2::int[]) as v(id, ord)
          where d.id = v.id`,
        [changed.map((item) => item.id), changed.map((item) => item.order)],
      );

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: dragged.parent_id,
        action: "department.reordered",
        targetType: "department",
        targetId: draggedId,
        payload: {
          beforeDepartmentId: targetId,
          beforeName: target.name,
          departmentName: dragged.name,
        },
      });
    });

    revalidatePath("/org/positions");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toActionMessage(error) };
  }
}

/** 拖拽换部门：成员任用从原部门移动到目标部门，由数据库函数校验权限 */
export async function moveMember(
  membershipId: string,
  targetDepartmentId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!membershipId || !targetDepartmentId) {
    return { ok: false, message: "成员或目标部门参数缺失" };
  }

  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    await withUserContext(context, async (client) => {
      const current = await client.query<{
        department_id: string;
        department_name: string;
        member_name: string | null;
      }>(
        `select m.department_id, d.name as department_name, u.name as member_name
           from memberships m
           join departments d on d.id = m.department_id
           join users u on u.id = m.user_id
          where m.id = $1 and m.status = 'active'`,
        [membershipId],
      );
      if (current.rows.length === 0) {
        throw new Error("成员任用不存在或已失效");
      }

      const fromDepartmentId = current.rows[0].department_id;
      if (fromDepartmentId === targetDepartmentId) {
        return;
      }

      await requireContextPermission(client, context, "member:manage", {
        kind: "membership",
        id: membershipId,
        departmentId: fromDepartmentId,
      });

      const targetResult = await client.query<{ name: string }>(
        "select name from departments where id = $1",
        [targetDepartmentId],
      );
      const targetName = targetResult.rows[0]?.name ?? null;
      if (!targetName) {
        throw new Error("目标部门不存在或无权访问");
      }

      await requireContextPermission(client, context, "member:manage", {
        kind: "department",
        id: targetDepartmentId,
        departmentId: targetDepartmentId,
      });

      await client.query("select app.move_membership($1, $2)", [
        membershipId,
        targetDepartmentId,
      ]);

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: targetDepartmentId,
        action: "membership.moved",
        targetType: "membership",
        targetId: membershipId,
        payload: {
          fromDepartmentId,
          fromName: current.rows[0].department_name,
          toDepartmentId: targetDepartmentId,
          toName: targetName,
          memberName: current.rows[0].member_name,
        },
      });
    });

    revalidatePath("/org/positions");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toActionMessage(error) };
  }
}
