import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { resolveContextPermissions } from "@/lib/permissions/server";
import { computeProfilePermissionsFromActor, loadTargetMemberships } from "@/lib/profile/access";
import type { ResolvedPermissions } from "@/types/permission";
import type { ProfilePermissions, UserEmailIdentity, UserProfile } from "@/types/profile";

import { ProfileClient } from "./ProfileClient";

export const dynamic = "force-dynamic";

interface UserRow {
  id: string;
  name: string | null;
  phone: string | null;
  image: string | null;
  birthday: Date | string | null;
  created_at: Date;
}

interface EmailRow {
  id: string;
  email: string;
  is_primary: boolean;
  verified_at: Date | null;
  created_at: Date;
}

interface DepartmentOption {
  id: string;
  name: string;
  parentId: string | null;
}

/** pg 的 date 可能以 Date 或字符串返回，统一规范成 YYYY-MM-DD */
function toDateOnly(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return value.slice(0, 10);
}

export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ userId?: string | string[] }>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const rawUserId = Array.isArray(params.userId) ? params.userId[0] : params.userId;
  const targetUserId = rawUserId?.trim() || session.userId;

  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const data = await withUserContext(context, async (client) => {
    const userResult = await client.query<UserRow>(
      "select id, name, phone, image, birthday, created_at from users where id = $1",
      [targetUserId],
    );
    const user = userResult.rows[0];
    if (!user) {
      return null;
    }

    let actor: ResolvedPermissions | null = null;
    try {
      actor = await resolveContextPermissions(client, context);
    } catch {
      actor = null;
    }

    const memberships = await loadTargetMemberships(client, targetUserId);
    const permissions: ProfilePermissions = computeProfilePermissionsFromActor(
      actor,
      targetUserId,
      memberships,
      context.activeDepartmentId,
    );

    let emails: UserEmailIdentity[] = [];
    if (permissions.canView) {
      const emailResult = await client.query<EmailRow>(
        `select id, email, is_primary, verified_at, created_at
           from user_email_identities
          where user_id = $1
          order by is_primary desc, created_at`,
        [targetUserId],
      );
      emails = emailResult.rows.map((row) => ({
        id: row.id,
        email: row.email,
        isPrimary: row.is_primary,
        verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
        createdAt: row.created_at.toISOString(),
      }));
    }

    const departmentResult = await client.query<{
      id: string;
      name: string;
      parent_id: string | null;
    }>("select id, name, parent_id from departments order by sort_order, created_at");

    const profile: UserProfile = {
      id: user.id,
      name: user.name ?? "",
      phone: user.phone,
      avatarUrl: user.image,
      birthday: toDateOnly(user.birthday),
      createdAt: user.created_at.toISOString(),
      emails,
      memberships,
    };

    const departments: DepartmentOption[] = departmentResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
    }));

    return { profile, permissions, departments };
  });

  if (!data) {
    notFound();
  }

  return (
    <section>
      <header className="section-header">
        <div>
          <h1 className="section-title">个人资料</h1>
          <p className="section-subtitle">
            {data.permissions.isSelf
              ? "维护你的核心身份、多邮箱与组织头衔"
              : `正在查看成员「${data.profile.name || data.profile.id}」的资料`}
            {" · "}当前身份等级 {context.accessLevel ?? "无"}
          </p>
        </div>
        {data.permissions.isSelf ? (
          <Link className="button button-secondary" href="/admin/organization">
            返回组织架构
          </Link>
        ) : (
          <Link className="button button-secondary" href="/me/profile">
            返回我的资料
          </Link>
        )}
      </header>

      {!data.permissions.canView ? (
        <div className="alert-error">
          无权查看该成员资料：仅本人、L1 老板与所在部门的上级管理者可以查看。
        </div>
      ) : (
        <ProfileClient
          key={data.profile.id}
          profile={data.profile}
          permissions={data.permissions}
          departments={data.departments}
          activeDepartmentId={context.activeDepartmentId}
        />
      )}
    </section>
  );
}
