"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { PoolClient } from "pg";

import { auditInTx } from "@/lib/audit";
import { verifyPassword } from "@/lib/auth/password";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext, type UserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";
import { computeProfilePermissions, loadPrimaryDepartment, loadTargetMemberships } from "@/lib/profile/access";
import type { UserMembershipSummary } from "@/types/profile";

type ActionResult = { ok: true } | { ok: false; message: string };

interface TargetUserRow {
  id: string;
  name: string | null;
  phone: string | null;
  password_hash: string | null;
}

interface EmailIdentityRow {
  id: string;
  email: string;
  is_primary: boolean;
}

interface MembershipRow {
  id: string;
  user_id: string;
  department_id: string;
  title: string;
  access_level: "L1" | "L2" | "L3";
}

const ACCESS_LEVELS = ["L1", "L2", "L3"] as const;
const AVATAR_PATTERN = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/;
const AVATAR_MAX_CHARS = 400_000;

function readText(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

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

function pgCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function toActionMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = pgCode(error);
    if (code === "42501") {
      return "无权执行该修改";
    }
    if (code === "23505") {
      return "该邮箱或手机号已被其他账号使用";
    }
    if (code === "23514") {
      return "不能把最后一位 L1 老板降级";
    }
    if (code === "22023") {
      return "业务岗位或权限等级不合法";
    }
    if (code === "P0002") {
      return "成员任用不存在或已失效";
    }
    return error.message;
  }
  return "操作失败，请稍后重试";
}

/**
 * 资料写入口统一守卫：
 * - 本人 → profile:edit_self（SELF）
 * - 他人 → member:profile（严格本部门；L2 写子部门会被拒绝）
 * 资源部门必须来自数据库读出的任用行，不能使用表单传入的 departmentId。
 */
async function requireProfileEditPermission(
  client: PoolClient,
  context: UserContext,
  targetUserId: string,
  memberships: UserMembershipSummary[],
): Promise<void> {
  if (targetUserId === context.userId) {
    await requireContextPermission(client, context, "profile:edit_self", {
      kind: "user",
      id: targetUserId,
      departmentId: context.activeDepartmentId,
      ownerUserId: targetUserId,
    });
    return;
  }

  const departmentId =
    memberships.find((membership) => membership.departmentId === context.activeDepartmentId)
      ?.departmentId ??
    memberships[0]?.departmentId ??
    null;

  if (!departmentId) {
    throw new Error("无权修改该成员资料");
  }

  await requireContextPermission(client, context, "member:profile", {
    kind: "user",
    id: targetUserId,
    departmentId,
    ownerUserId: targetUserId,
  });
}

/** 头像/姓名/手机号：本人或上级可改；本人改手机号需验证当前密码 */
export async function updateCoreProfile(formData: FormData): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const targetUserId = readText(formData, "targetUserId") || context.userId;
    const name = readText(formData, "name");
    const phoneInput = readText(formData, "phone");
    const password = readText(formData, "currentPassword");
    const avatarProvided = formData.has("avatar");
    const avatarRaw = avatarProvided ? readText(formData, "avatar") : "";

    if (!name || name.length > 40) {
      throw new Error("姓名必填且不超过 40 字符");
    }

    await withUserContext(context, async (client) => {
      const memberships = await loadTargetMemberships(client, targetUserId);
      await requireProfileEditPermission(client, context, targetUserId, memberships);

      const permissions = computeProfilePermissions(
        { userId: context.userId, accessLevel: context.accessLevel },
        targetUserId,
        memberships,
      );
      if (!permissions.canView) {
        throw new Error("无权查看该成员资料");
      }
      if (!permissions.canEditCore) {
        throw new Error("无权修改该成员资料");
      }

      // 口令哈希不再直接授予业务角色：仅本人的上下文可通过 SECURITY DEFINER 函数读取
      const targetResult = await client.query<TargetUserRow>(
        "select id, name, phone, app.current_password_hash(id) as password_hash from users where id = $1",
        [targetUserId],
      );
      const target = targetResult.rows[0];
      if (!target) {
        throw new Error("成员不存在");
      }

      // 手机号允许历史账号为空；一旦已有手机号则不允许清空
      let phone = target.phone;
      if (phoneInput) {
        phone = normalizePhone(phoneInput);
      } else if (target.phone) {
        throw new Error("手机号不能为空");
      }

      const phoneChanged = (target.phone ?? "") !== (phone ?? "");
      if (phoneChanged && permissions.isSelf && target.password_hash) {
        if (!password) {
          throw new Error("修改手机号需要验证当前密码");
        }
        const verified = await verifyPassword(password, target.password_hash);
        if (!verified) {
          throw new Error("当前密码不正确");
        }
      }

      let avatar: string | null | undefined;
      if (avatarProvided) {
        if (!avatarRaw) {
          avatar = null;
        } else {
          if (!AVATAR_PATTERN.test(avatarRaw)) {
            throw new Error("头像格式不支持，请上传 PNG / JPEG / WebP");
          }
          if (avatarRaw.length > AVATAR_MAX_CHARS) {
            throw new Error("头像图片过大，请压缩到 300KB 以内");
          }
          avatar = avatarRaw;
        }
      }

      try {
        if (avatar !== undefined) {
          await client.query("update users set name = $1, phone = $2, image = $3 where id = $4", [
            name,
            phone,
            avatar,
            targetUserId,
          ]);
        } else {
          await client.query("update users set name = $1, phone = $2 where id = $3", [
            name,
            phone,
            targetUserId,
          ]);
        }
      } catch (error) {
        if (pgCode(error) === "23505") {
          throw new Error("该手机号已被其他账号使用");
        }
        throw error;
      }

      const department = await loadPrimaryDepartment(client, targetUserId);

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: department?.id ?? null,
        action: "profile.core_updated",
        targetType: "user",
        targetId: targetUserId,
        payload: {
          phoneChanged,
          avatarChanged: avatarProvided,
          nameChanged: (target.name ?? "") !== name,
          departmentName: department?.name ?? null,
        },
      });
    });

    revalidatePath("/me/profile");
    revalidatePath("/admin/organization");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toActionMessage(error) };
  }
}

/** 新增业务/项目邮箱；首个邮箱自动成为默认主邮箱 */
export async function addEmailIdentity(formData: FormData): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const targetUserId = readText(formData, "targetUserId") || context.userId;
    const email = normalizeEmail(readText(formData, "email"));

    await withUserContext(context, async (client) => {
      const memberships = await loadTargetMemberships(client, targetUserId);
      await requireProfileEditPermission(client, context, targetUserId, memberships);

      const permissions = computeProfilePermissions(
        { userId: context.userId, accessLevel: context.accessLevel },
        targetUserId,
        memberships,
      );
      if (!permissions.canEditCore) {
        throw new Error("无权修改该成员的邮箱");
      }

      const countResult = await client.query<{ count: string }>(
        "select count(*)::text as count from user_email_identities where user_id = $1",
        [targetUserId],
      );
      const isFirst = countResult.rows[0]?.count === "0";

      const ownerResult = await client.query<{ id: string }>(
        "select id from users where email = $1 and id <> $2",
        [email, targetUserId],
      );
      if (ownerResult.rows.length > 0) {
        throw new Error("该邮箱已被其他账号使用");
      }

      try {
        await client.query(
          `insert into user_email_identities (tenant_id, user_id, email, is_primary)
           values ($1, $2, $3, $4)`,
          [context.tenantId, targetUserId, email, isFirst],
        );
      } catch (error) {
        if (pgCode(error) === "23505") {
          throw new Error("该邮箱已被其他成员绑定");
        }
        throw error;
      }

      if (isFirst) {
        try {
          await client.query("update users set email = $1 where id = $2", [email, targetUserId]);
        } catch (error) {
          if (pgCode(error) === "23505") {
            throw new Error("该邮箱已被其他账号使用");
          }
          throw error;
        }
      }

      const department = await loadPrimaryDepartment(client, targetUserId);

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: department?.id ?? null,
        action: "profile.email_added",
        targetType: "user",
        targetId: targetUserId,
        payload: {
          email,
          primary: isFirst,
          departmentName: department?.name ?? null,
        },
      });
    });

    revalidatePath("/me/profile");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toActionMessage(error) };
  }
}

/** 切换默认主邮箱（同时作为登录邮箱与系统发件地址） */
export async function setPrimaryEmailIdentity(formData: FormData): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const targetUserId = readText(formData, "targetUserId") || context.userId;
    const identityId = readText(formData, "identityId");
    if (!identityId) {
      throw new Error("邮箱标识缺失");
    }

    await withUserContext(context, async (client) => {
      const memberships = await loadTargetMemberships(client, targetUserId);
      await requireProfileEditPermission(client, context, targetUserId, memberships);

      const permissions = computeProfilePermissions(
        { userId: context.userId, accessLevel: context.accessLevel },
        targetUserId,
        memberships,
      );
      if (!permissions.canEditCore) {
        throw new Error("无权修改该成员的邮箱");
      }

      const identityResult = await client.query<EmailIdentityRow>(
        "select id, email, is_primary from user_email_identities where id = $1 and user_id = $2",
        [identityId, targetUserId],
      );
      const identity = identityResult.rows[0];
      if (!identity) {
        throw new Error("邮箱不存在");
      }

      await client.query("update user_email_identities set is_primary = false where user_id = $1", [
        targetUserId,
      ]);
      await client.query("update user_email_identities set is_primary = true where id = $1", [
        identityId,
      ]);

      try {
        await client.query("update users set email = $1 where id = $2", [
          identity.email,
          targetUserId,
        ]);
      } catch (error) {
        if (pgCode(error) === "23505") {
          throw new Error("该邮箱已被其他账号使用");
        }
        throw error;
      }

      const department = await loadPrimaryDepartment(client, targetUserId);

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: department?.id ?? null,
        action: "profile.primary_email_changed",
        targetType: "user",
        targetId: targetUserId,
        payload: {
          email: identity.email,
          departmentName: department?.name ?? null,
        },
      });
    });

    revalidatePath("/me/profile");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toActionMessage(error) };
  }
}

/** 解绑非主邮箱；默认主邮箱需先切换后才能删除 */
export async function removeEmailIdentity(formData: FormData): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const targetUserId = readText(formData, "targetUserId") || context.userId;
    const identityId = readText(formData, "identityId");
    if (!identityId) {
      throw new Error("邮箱标识缺失");
    }

    await withUserContext(context, async (client) => {
      const memberships = await loadTargetMemberships(client, targetUserId);
      await requireProfileEditPermission(client, context, targetUserId, memberships);

      const permissions = computeProfilePermissions(
        { userId: context.userId, accessLevel: context.accessLevel },
        targetUserId,
        memberships,
      );
      if (!permissions.canEditCore) {
        throw new Error("无权修改该成员的邮箱");
      }

      const identityResult = await client.query<EmailIdentityRow>(
        "select id, email, is_primary from user_email_identities where id = $1 and user_id = $2",
        [identityId, targetUserId],
      );
      const identity = identityResult.rows[0];
      if (!identity) {
        throw new Error("邮箱不存在");
      }
      if (identity.is_primary) {
        throw new Error("默认主邮箱不可直接删除，请先切换主邮箱");
      }

      await client.query("delete from user_email_identities where id = $1 and user_id = $2", [
        identityId,
        targetUserId,
      ]);

      const department = await loadPrimaryDepartment(client, targetUserId);

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: department?.id ?? null,
        action: "profile.email_removed",
        targetType: "user",
        targetId: targetUserId,
        payload: {
          email: identity.email,
          departmentName: department?.name ?? null,
        },
      });
    });

    revalidatePath("/me/profile");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toActionMessage(error) };
  }
}

/** 生日自助修改：仅本人；数据库函数再次强制校验 actor = target */
export async function updateSelfBirthday(formData: FormData): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const birthdayInput = readText(formData, "birthday");
    if (birthdayInput && !/^\d{4}-\d{2}-\d{2}$/.test(birthdayInput)) {
      throw new Error("生日格式不正确");
    }

    await withUserContext(context, async (client) => {
      await requireContextPermission(client, context, "profile:edit_self", {
        kind: "user",
        id: context.userId,
        departmentId: context.activeDepartmentId,
        ownerUserId: context.userId,
      });

      await client.query("select app.update_self_birthday($1, $2)", [
        context.userId,
        birthdayInput || null,
      ]);

      const department = await loadPrimaryDepartment(client, context.userId);

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: department?.id ?? null,
        action: "profile.birthday_updated",
        targetType: "user",
        targetId: context.userId,
        payload: {
          birthday: birthdayInput || null,
          departmentName: department?.name ?? null,
        },
      });
    });

    revalidatePath("/me/profile");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toActionMessage(error) };
  }
}

/** 业务岗位 / 所属部门 / 权限等级：权限矩阵由应用层预判，数据库函数再次强制校验 */
export async function updateMembershipAssignment(formData: FormData): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const requestId = (await headers()).get("x-request-id") ?? undefined;
    const context = await resolveUserContext(session.userId, requestId);

    const membershipId = readText(formData, "membershipId");
    if (!membershipId) {
      throw new Error("任用 ID 缺失");
    }
    const titleInput = readText(formData, "title");
    const departmentInput = readText(formData, "departmentId");
    const accessLevelInput = readText(formData, "accessLevel");

    await withUserContext(context, async (client) => {
      const membershipResult = await client.query<MembershipRow>(
        `select id, user_id, department_id, title, access_level
           from memberships
          where id = $1 and status = 'active'`,
        [membershipId],
      );
      const membership = membershipResult.rows[0];
      if (!membership) {
        throw new Error("成员任用不存在或无权修改");
      }

      const memberships = await loadTargetMemberships(client, membership.user_id);
      const permissions = computeProfilePermissions(
        { userId: context.userId, accessLevel: context.accessLevel },
        membership.user_id,
        memberships,
      );
      if (!permissions.canEditTitle && !permissions.canEditOrg) {
        throw new Error("无权修改该成员的组织信息");
      }

      if (permissions.canEditTitle) {
        await requireContextPermission(client, context, "member:profile", {
          kind: "membership",
          id: membershipId,
          departmentId: membership.department_id,
          ownerUserId: membership.user_id,
        });
      }

      if (permissions.canEditOrg && departmentInput) {
        await requireContextPermission(client, context, "member:manage", {
          kind: "membership",
          id: membershipId,
          departmentId: membership.department_id,
          ownerUserId: membership.user_id,
        });

        const targetDepartment = await client.query<{ id: string }>(
          "select id from departments where id = $1",
          [departmentInput],
        );
        if (targetDepartment.rows.length === 0) {
          throw new Error("目标部门不存在或无权访问");
        }

        await requireContextPermission(client, context, "member:manage", {
          kind: "department",
          id: departmentInput,
          departmentId: departmentInput,
        });
      }

      if (permissions.canEditOrg && accessLevelInput) {
        await requireContextPermission(client, context, "member:level", {
          kind: "membership",
          id: membershipId,
          departmentId: membership.department_id,
          ownerUserId: membership.user_id,
        });
      }

      let title: string | null = null;
      if (permissions.canEditTitle) {
        if (!titleInput || titleInput.length > 40) {
          throw new Error("业务岗位必填且不超过 40 字符");
        }
        title = titleInput;
      }

      let departmentId: string | null = null;
      let accessLevel: string | null = null;
      if (permissions.canEditOrg) {
        departmentId = departmentInput || null;
        if (accessLevelInput) {
          if (!ACCESS_LEVELS.includes(accessLevelInput as (typeof ACCESS_LEVELS)[number])) {
            throw new Error("权限等级非法");
          }
          accessLevel = accessLevelInput;
        }
      }

      await client.query("select app.update_membership_profile($1, $2, $3, $4)", [
        membershipId,
        title,
        departmentId,
        accessLevel,
      ]);

      const effectiveDepartmentId = departmentId ?? membership.department_id;
      const departmentResult = await client.query<{ name: string }>(
        "select name from departments where id = $1",
        [effectiveDepartmentId],
      );

      await auditInTx(client, context, {
        actorUserId: context.userId,
        departmentId: effectiveDepartmentId,
        action: "profile.membership_updated",
        targetType: "membership",
        targetId: membershipId,
        payload: {
          title: title ?? membership.title,
          previousTitle: membership.title,
          departmentId: effectiveDepartmentId,
          previousDepartmentId: membership.department_id,
          departmentName: departmentResult.rows[0]?.name ?? null,
          accessLevel: accessLevel ?? membership.access_level,
          previousAccessLevel: membership.access_level,
        },
      });
    });

    revalidatePath("/me/profile");
    revalidatePath("/admin/organization");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: toActionMessage(error) };
  }
}
