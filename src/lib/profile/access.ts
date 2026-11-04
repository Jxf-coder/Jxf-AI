import type { PoolClient } from "pg";

import { authorize } from "@/lib/permissions/authorize";
import type { PermissionResource, ResolvedPermissions } from "@/types/permission";
import type {
  AccessLevel,
  ProfilePermissions,
  UserMembershipSummary,
} from "@/types/profile";

export interface ProfileActor {
  userId: string;
  accessLevel: AccessLevel | null;
}

const LEVEL_RANK: Record<AccessLevel, number> = { L1: 3, L2: 2, L3: 1 };

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

/**
 * 读取目标成员的有效任用。
 * memberships 受 RLS 约束：L1 可读全租户，L2 可读自己子树，L3 只能读自己。
 * 因此「查得到」本身就等价于「在可管理范围内」。
 */
export async function loadTargetMemberships(
  client: PoolClient,
  userId: string,
): Promise<UserMembershipSummary[]> {
  const { rows } = await client.query<{
    id: string;
    department_id: string;
    department_name: string;
    title: string;
    access_level: AccessLevel;
    employee_no: string | null;
    hire_date: Date | string | null;
    position: string | null;
  }>(
    `select m.id, m.department_id, d.name as department_name, m.title, m.access_level,
            m.employee_no, m.hire_date, m.position
       from memberships m
       join departments d on d.id = m.department_id
      where m.user_id = $1
        and m.status = 'active'
      order by d.sort_order, d.created_at`,
    [userId],
  );

  return rows.map((row) => ({
    id: row.id,
    departmentId: row.department_id,
    departmentName: row.department_name,
    title: row.title,
    accessLevel: row.access_level,
    employeeNo: row.employee_no,
    hireDate: toDateOnly(row.hire_date),
    position: row.position,
  }));
}

export function highestLevel(memberships: UserMembershipSummary[]): AccessLevel | null {
  let best: AccessLevel | null = null;
  for (const membership of memberships) {
    if (!best || LEVEL_RANK[membership.accessLevel] > LEVEL_RANK[best]) {
      best = membership.accessLevel;
    }
  }
  return best;
}

/** 取成员最早的有效任用部门，用于审计事件的部门归属 */
export async function loadPrimaryDepartment(
  client: PoolClient,
  userId: string,
): Promise<{ id: string; name: string } | null> {
  const { rows } = await client.query<{ id: string; name: string }>(
    `select m.department_id as id, d.name
       from memberships m
       join departments d on d.id = m.department_id
      where m.user_id = $1 and m.status = 'active'
      order by m.created_at
      limit 1`,
    [userId],
  );
  return rows[0] ?? null;
}

/**
 * 权限矩阵：
 * - 核心资料（头像/姓名/手机/邮箱）：本人可改；L1 可改所有人；L2 可改下级 L3。
 * - 业务岗位：L1 可改所有人；L2 仅可改下级 L3（不能改自己或同级 L2）；L3 只读。
 * - 所属部门 / 权限等级：仅 L1。
 */
export function computeProfilePermissions(
  actor: ProfileActor,
  targetUserId: string,
  memberships: UserMembershipSummary[],
): ProfilePermissions {
  const isSelf = actor.userId === targetUserId;
  const targetLevel = highestLevel(memberships);
  const inScope = isSelf || memberships.length > 0;

  return {
    isSelf,
    canView: inScope,
    canEditCore:
      isSelf ||
      actor.accessLevel === "L1" ||
      (actor.accessLevel === "L2" && targetLevel === "L3"),
    canEditTitle:
      actor.accessLevel === "L1" ||
      (actor.accessLevel === "L2" && !isSelf && targetLevel === "L3"),
    canEditOrg: actor.accessLevel === "L1",
  };
}

/**
 * 权限模型下的资料派生视图：底层全部走 `authorize()`，保留原有的上下级业务规则。
 * - 本人：profile:view_self / profile:edit_self（SELF）
 * - 他人：member:view / member:profile（严格本部门，L2 不能越过子部门）
 * - 部门与等级：member:level + member:manage（v1 仅 L1）
 */
export function computeProfilePermissionsFromActor(
  actor: ResolvedPermissions | null,
  targetUserId: string,
  memberships: UserMembershipSummary[],
  activeDepartmentId: string | null,
): ProfilePermissions {
  const isSelf = actor?.userId === targetUserId;
  const base = computeProfilePermissions(
    { userId: actor?.userId ?? "", accessLevel: actor?.level ?? null },
    targetUserId,
    memberships,
  );

  if (!actor) {
    return {
      isSelf,
      canView: false,
      canEditCore: false,
      canEditTitle: false,
      canEditOrg: false,
    };
  }

  const ownedResource: PermissionResource = {
    kind: "user",
    id: targetUserId,
    departmentId: activeDepartmentId,
    ownerUserId: targetUserId,
  };

  // 目标部门必须来自数据库读出的任用行；优先取当前上下文部门
  const targetDepartmentId =
    memberships.find((membership) => membership.departmentId === activeDepartmentId)?.departmentId ??
    memberships[0]?.departmentId ??
    null;

  const targetResource: PermissionResource = {
    kind: "user",
    id: targetUserId,
    departmentId: targetDepartmentId,
    ownerUserId: targetUserId,
  };

  const editResource = isSelf ? ownedResource : targetResource;

  const canView = isSelf
    ? authorize(actor, "profile:view_self", ownedResource).allowed
    : authorize(actor, "member:view", targetResource).allowed;

  const canEditCore =
    base.canEditCore &&
    (isSelf
      ? authorize(actor, "profile:edit_self", editResource).allowed
      : authorize(actor, "member:profile", editResource).allowed);

  const canEditTitle =
    !isSelf &&
    base.canEditTitle &&
    authorize(actor, "member:profile", targetResource).allowed;

  const canEditOrg =
    base.canEditOrg &&
    authorize(actor, "member:level", targetResource).allowed &&
    authorize(actor, "member:manage", targetResource).allowed;

  return { isSelf, canView, canEditCore, canEditTitle, canEditOrg };
}
