import { headers } from "next/headers";
import Link from "next/link";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { authorize } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { ResolvedPermissions } from "@/types/permission";

import { addMember, createDepartment, updateDepartment } from "./actions";
import { OrgTree, type ArchivedMember, type OrgDepartment, type OrgMember } from "./OrgTree";

export const dynamic = "force-dynamic";

type DepartmentRow = OrgDepartment;
type MemberRow = OrgMember;

export default async function OrgPositionsPage() {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const data = await withUserContext(context, async (client) => {
    let actor: ResolvedPermissions | null = null;
    try {
      actor = await resolveContextPermissions(client, context);
    } catch {
      actor = null;
    }

    const canViewOrg = actor ? authorize(actor, "org:view").allowed : false;
    const canManageOrg = actor ? authorize(actor, "org:manage").allowed : false;
    const canManageMembers = actor ? authorize(actor, "member:manage").allowed : false;

    if (!actor || !canViewOrg) {
      return {
        canViewOrg,
        canManageOrg,
        canManageMembers,
        departments: [] as DepartmentRow[],
        members: [] as MemberRow[],
        archived: [] as ArchivedMember[],
      };
    }

    const departments = await client.query<DepartmentRow>(
      "select id, parent_id, name, sort_order from departments order by sort_order, created_at",
    );
    const members = await client.query<MemberRow>(
      `select m.id, m.user_id, m.department_id, m.access_level, m.title,
              u.email, u.phone, u.name
         from memberships m
         join users u on u.id = m.user_id
        where m.status = 'active'
        order by m.created_at`,
    );
    // 已停用（软删除）成员仅具备「管理成员」权限者可见，不会出现在组织架构树中
    const archived = canManageMembers
      ? await client.query<ArchivedMember>(
          `select m.id, m.department_id, m.access_level, m.title, m.removed_at,
                  u.email, u.phone, u.name
             from memberships m
             join users u on u.id = m.user_id
            where m.status = 'removed'
            order by m.removed_at desc nulls last`,
        )
      : { rows: [] as ArchivedMember[] };

    return {
      canViewOrg,
      canManageOrg,
      canManageMembers,
      departments: departments.rows,
      members: members.rows,
      archived: archived.rows,
    };
  });

  const rootDepartments = data.departments.filter(
    (department) =>
      department.parent_id === null ||
      !data.departments.some((candidate) => candidate.id === department.parent_id),
  );
  const defaultParentId = rootDepartments[0]?.id ?? "";
  // 上级部门下拉把根节点「老板」放首位；管理部门只列出可改名的子部门
  const orderedDepartments = [
    ...data.departments.filter((department) => department.parent_id === null),
    ...data.departments.filter((department) => department.parent_id !== null),
  ];
  const manageableDepartments = orderedDepartments.filter(
    (department) => department.parent_id !== null,
  );

  return (
    <section>
      <header className="section-header">
        <div>
          <h1 className="section-title">组织架构</h1>
          <p className="section-subtitle">
            部门是数据权限与知识库隔离的物理边界 · 当前身份：{session.email || session.name} ·
            等级 {context.accessLevel ?? "无"} · 当前部门 {context.activeDepartmentName ?? "无"} ·
            有效任用 {context.activeMemberships.length}
          </p>
        </div>
        <Link className="button button-secondary" href="/me/permissions">
          我的权限
        </Link>
      </header>

      {!context.accessLevel ? (
        <div className="alert-error">
          当前账号没有任何有效任用。按 fail-closed 规则，以下查询结果全部为 0 行。
        </div>
      ) : null}

      {!data.canViewOrg ? (
        <div className="alert-error">
          无权查看组织架构：当前账号缺少「查看组织架构」权限。
        </div>
      ) : null}

      <div className="card">
        <h2 className="card-title">组织架构</h2>
        {data.departments.length === 0 ? (
          <p className="hint">没有可见部门（可能是权限不足，或尚未创建）。</p>
        ) : (
          <OrgTree
            departments={data.departments}
            members={data.members}
            archivedMembers={data.archived}
          />
        )}
      </div>

      <div className="two-column">
        <div className="card">
          <h2 className="card-title">新建部门</h2>
          {!data.canManageOrg ? (
            <p className="hint">需要「管理组织架构」权限。</p>
          ) : (
          <>
          <form action={createDepartment} className="form-grid">
            <label>
              上级部门
              <select name="parentId" required defaultValue={defaultParentId}>
                {orderedDepartments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              部门名称
              <input name="name" required maxLength={80} placeholder="例如：华东交付组" />
            </label>
            <button type="submit" className="button">
              新建部门
            </button>
          </form>

          <div className="card-divider" />

          <h2 className="card-title">管理部门</h2>
          <form action={updateDepartment} className="form-grid">
            <label>
              选择部门
              <select name="departmentId" required>
                {manageableDepartments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              新名称
              <input name="name" required maxLength={80} placeholder="新的部门名称" />
            </label>
            <button type="submit" className="button button-secondary">
              保存修改
            </button>
          </form>
          <p className="hint">
            仅具备「管理组织架构」权限者可新建、改名与删除；根节点「老板」是系统控制权入口，不可改名、不可删除。越权写入会被数据库策略直接拒绝。
          </p>
          </>
          )}
        </div>

        <div className="card">
          <h2 className="card-title">添加成员</h2>
          {!data.canManageMembers ? (
            <p className="hint">需要「管理成员」权限。</p>
          ) : (
          <>
          <form action={addMember} className="form-grid">
            <label>
              所属部门
              <select name="departmentId" required defaultValue={defaultParentId}>
                {orderedDepartments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              姓名
              <input name="name" required maxLength={40} placeholder="真实姓名" />
            </label>
            <label>
              手机号
              <input name="phone" required inputMode="tel" maxLength={20} placeholder="13800000000" />
            </label>
            <label>
              邮箱（选填）
              <input name="email" type="email" maxLength={254} placeholder="user@example.com" />
            </label>
            <label>
              业务岗位
              <input
                name="title"
                required
                maxLength={40}
                placeholder="自由填写，例如：交付经理、架构师、HRBP"
              />
            </label>
            <label>
              权限等级
              <select name="accessLevel" defaultValue="L3">
                <option value="L1">L1 · 老板</option>
                <option value="L2">L2 · 管理者</option>
                <option value="L3">L3 · 普通成员</option>
              </select>
            </label>
            <button type="submit" className="button">
              添加成员
            </button>
          </form>
          <p className="hint">
            手机号是唯一主账号标识，用于员工后续手机号注册自动绑定；邮箱选填，用于系统内邮件收发与
            CRM 消息同步，支持绑定多个。
          </p>
          </>
          )}
        </div>
      </div>
    </section>
  );
}
