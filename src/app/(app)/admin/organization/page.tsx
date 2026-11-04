import { headers } from "next/headers";
import Link from "next/link";

import { Select } from "@/components/ui/select";
import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { authorize } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { ResolvedPermissions } from "@/types/permission";

import { MembersTab, type MemberTableRow } from "./MembersTab";
import { OrgTree, type OrgDepartment, type OrgMember } from "./OrgTree";
import { createDepartment, updateDepartment } from "./actions";

export const dynamic = "force-dynamic";

type TabKey = "tree" | "members";

interface MemberListRow {
  membership_id: string;
  user_id: string;
  department_id: string;
  department_name: string;
  access_level: "L1" | "L2" | "L3";
  title: string;
  employee_no: string | null;
  hire_date: Date | string | null;
  position: string | null;
  birthday: Date | string | null;
  status: "active" | "removed";
  removed_at: Date | null;
  name: string | null;
  phone: string | null;
  email: string | null;
}

/** pg 的 date 可能以字符串或 Date 返回，统一规范成 YYYY-MM-DD */
function toDateOnly(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export default async function OrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; status?: string; dept?: string; q?: string }>;
}) {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);
  const params = await searchParams;
  const tab: TabKey = params.tab === "members" ? "members" : "tree";

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
        departments: [] as OrgDepartment[],
        activeMembers: [] as OrgMember[],
        memberRows: [] as MemberTableRow[],
      };
    }

    const departments = await client.query<OrgDepartment>(
      "select id, parent_id, name, sort_order from departments order by sort_order, created_at",
    );
    const activeMembers = await client.query<OrgMember>(
      `select m.id, m.user_id, m.department_id, m.access_level, m.title,
              u.email, u.phone, u.name
         from memberships m
         join users u on u.id = m.user_id
        where m.status = 'active'
        order by m.created_at`,
    );

    // 员工管理需要全量数据（含已停用）；仅具备管理成员权限时查询离职账号
    const listRows = canManageMembers
      ? await client.query<MemberListRow>(
          `select m.id as membership_id, m.user_id, m.department_id,
                  d.name as department_name, m.access_level, m.title, m.status, m.removed_at,
                  m.employee_no, m.hire_date, m.position,
                  u.name, u.phone, u.email, u.birthday
             from memberships m
             join departments d on d.id = m.department_id
             join users u on u.id = m.user_id
            where m.status in ('active', 'removed')
            order by (m.status = 'active') desc, d.name, m.created_at`,
        )
      : { rows: [] as MemberListRow[] };

    const memberRows: MemberTableRow[] = listRows.rows.map((row) => ({
      membershipId: row.membership_id,
      userId: row.user_id,
      name: row.name ?? "",
      phone: row.phone ?? "",
      email: row.email,
      departmentId: row.department_id,
      departmentName: row.department_name,
      title: row.title,
      employeeNo: row.employee_no ?? "",
      hireDate: toDateOnly(row.hire_date),
      birthday: toDateOnly(row.birthday),
      position: row.position ?? "",
      level: row.access_level,
      status: row.status,
      removedAt: row.removed_at ? DATE_FORMATTER.format(row.removed_at) : null,
    }));

    return {
      canViewOrg,
      canManageOrg,
      canManageMembers,
      departments: departments.rows,
      activeMembers: activeMembers.rows,
      memberRows,
    };
  });

  const rootDepartments = data.departments.filter(
    (department) =>
      department.parent_id === null ||
      !data.departments.some((candidate) => candidate.id === department.parent_id),
  );
  const defaultParentId = rootDepartments[0]?.id ?? "";
  const orderedDepartments = [
    ...data.departments.filter((department) => department.parent_id === null),
    ...data.departments.filter((department) => department.parent_id !== null),
  ];
  const manageableDepartments = orderedDepartments.filter(
    (department) => department.parent_id !== null,
  );

  const initialStatus: "active" | "removed" | "all" =
    params.status === "removed" || params.status === "all" ? params.status : "active";
  const requestedDepartment = params.dept;
  const initialDepartmentId =
    requestedDepartment && data.departments.some((department) => department.id === requestedDepartment)
      ? requestedDepartment
      : "all";
  const initialSearch = typeof params.q === "string" ? params.q.slice(0, 80) : "";

  return (
    <section>
      <header className="section-header">
        <div>
          <h1 className="section-title">组织架构</h1>
          <p className="section-subtitle">
            部门是数据权限与知识库隔离的物理边界 · 当前身份：{session.email || session.name} ·
            等级 {context.accessLevel ?? "无"} · 当前部门 {context.activeDepartmentName ?? "无"}
          </p>
        </div>
        <Link className="button button-secondary" href="/admin/permissions">
          我的权限
        </Link>
      </header>

      <nav className="perm-tabs" role="tablist" aria-label="组织架构">
        <Link
          href="/admin/organization"
          role="tab"
          aria-selected={tab === "tree"}
          className={`perm-tab${tab === "tree" ? " is-active" : ""}`}
        >
          组织架构
        </Link>
        <Link
          href="/admin/organization?tab=members"
          role="tab"
          aria-selected={tab === "members"}
          className={`perm-tab${tab === "members" ? " is-active" : ""}`}
        >
          员工管理
        </Link>
      </nav>

      <div className="perm-tab-body">
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

        {tab === "members" ? (
          data.canManageMembers ? (
            <MembersTab
              rows={data.memberRows}
              departments={data.departments.map((department) => ({
                id: department.id,
                name: department.name,
              }))}
              canManageMembers={data.canManageMembers}
              defaultDepartmentId={defaultParentId}
              initialStatus={initialStatus}
              initialDepartmentId={initialDepartmentId}
              initialSearch={initialSearch}
            />
          ) : (
            <div className="alert-error">仅具备「管理成员」权限者可进入员工管理。</div>
          )
        ) : (
          <>
            <div className="card">
              <h2 className="card-title">部门与在职员工</h2>
              {data.departments.length === 0 ? (
                <p className="hint">没有可见部门（可能是权限不足，或尚未创建）。</p>
              ) : (
                <OrgTree departments={data.departments} members={data.activeMembers} />
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
                        <Select
                          className="form-select-block"
                          name="parentId"
                          required
                          defaultValue={defaultParentId}
                          options={orderedDepartments.map((department) => ({
                            value: department.id,
                            label: department.name,
                          }))}
                        />
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
                        <Select
                          className="form-select-block"
                          name="departmentId"
                          required
                          options={manageableDepartments.map((department) => ({
                            value: department.id,
                            label: department.name,
                          }))}
                        />
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
            </div>
          </>
        )}
      </div>
    </section>
  );
}
