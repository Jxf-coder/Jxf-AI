import { headers } from "next/headers";
import Link from "next/link";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";

import {
  addMember,
  createDepartment,
  deleteDepartment,
  removeMember,
  updateDepartment,
} from "./actions";

export const dynamic = "force-dynamic";

interface DepartmentRow {
  id: string;
  parent_id: string | null;
  name: string;
}

interface MemberRow {
  id: string;
  department_id: string;
  access_level: "L1" | "L2" | "L3";
  title: string;
  email: string | null;
  phone: string | null;
  name: string | null;
}

interface AuditRow {
  id: number;
  action: string;
  target_type: string | null;
  target_id: string | null;
  created_at: Date;
}

const TITLE_SUGGESTIONS = ["创始人", "交付经理", "架构师", "HRBP", "顾问", "工程师"];

function LevelBadge({ level }: { level: "L1" | "L2" | "L3" }) {
  return (
    <span className={`badge level-${level.toLowerCase()}`}>{level === "L1" ? "老板" : level}</span>
  );
}

function MemberCard({
  member,
  canRemove,
}: {
  member: MemberRow;
  canRemove: boolean;
}) {
  const displayName = member.name?.trim() || member.phone || member.email || "未命名成员";

  return (
    <li className="member-card">
      <span className="member-identity">
        <LevelBadge level={member.access_level} />
        <strong className="member-name">{displayName}</strong>
        <span className="member-title">· {member.title}</span>
      </span>
      {canRemove ? (
        <form action={removeMember}>
          <input type="hidden" name="membershipId" value={member.id} />
          <button type="submit" className="link-danger">
            移出
          </button>
        </form>
      ) : null}
    </li>
  );
}

function DepartmentNode({
  department,
  departments,
  members,
  depth,
  canManage,
}: {
  department: DepartmentRow;
  departments: DepartmentRow[];
  members: MemberRow[];
  depth: number;
  canManage: boolean;
}) {
  const children = departments.filter((child) => child.parent_id === department.id);
  const departmentMembers = members.filter((member) => member.department_id === department.id);
  const isRoot = department.parent_id === null;

  return (
    <li>
      <div className="dept-node">
        <span className="dept-name">{department.name}</span>
        <span className="dept-count">{departmentMembers.length} 人</span>
        {canManage && !isRoot ? (
          <form action={deleteDepartment}>
            <input type="hidden" name="departmentId" value={department.id} />
            <button type="submit" className="link-danger dept-delete">
              删除部门
            </button>
          </form>
        ) : null}
      </div>

      {departmentMembers.length > 0 ? (
        <ul className="member-cards">
          {departmentMembers.map((member) => (
            <MemberCard
              key={member.id}
              member={member}
              canRemove={member.access_level !== "L1"}
            />
          ))}
        </ul>
      ) : (
        <p className="dept-empty">暂无成员</p>
      )}

      {children.length > 0 ? (
        <ul className={`role-tree role-tree-depth-${Math.min(depth + 1, 3)}`}>
          {children.map((child) => (
            <DepartmentNode
              key={child.id}
              department={child}
              departments={departments}
              members={members}
              depth={depth + 1}
              canManage={canManage}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default async function OrgPositionsPage() {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const data = await withUserContext(context, async (client) => {
    const departments = await client.query<DepartmentRow>(
      "select id, parent_id, name from departments order by created_at",
    );
    const members = await client.query<MemberRow>(
      `select m.id, m.department_id, m.access_level, m.title,
              u.email, u.phone, u.name
         from memberships m
         join users u on u.id = m.user_id
        where m.status = 'active'
        order by m.created_at`,
    );
    const audits = await client.query<AuditRow>(
      `select id, action, target_type, target_id, created_at
         from audit_events
        order by id desc
        limit 10`,
    );

    return {
      departments: departments.rows,
      members: members.rows,
      audits: audits.rows,
    };
  });

  const rootDepartments = data.departments.filter(
    (department) =>
      department.parent_id === null ||
      !data.departments.some((candidate) => candidate.id === department.parent_id),
  );
  const defaultParentId = rootDepartments[0]?.id ?? "";
  const canManage = context.accessLevel === "L1";

  const titleOptions = Array.from(
    new Set([...TITLE_SUGGESTIONS, ...data.members.map((member) => member.title)]),
  );

  return (
    <section>
      <header className="section-header">
        <div>
          <h1 className="section-title">组织架构</h1>
          <p className="section-subtitle">
            部门是数据权限与知识库隔离的物理边界 · 当前身份：{session.email || session.name} ·
            等级 {context.accessLevel ?? "无"} · 我的部门数 {context.departmentIds.length}
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

      <div className="card">
        <h2 className="card-title">组织架构</h2>
        {data.departments.length === 0 ? (
          <p className="hint">没有可见部门（可能是权限不足，或尚未创建）。</p>
        ) : (
          <ul className="role-tree">
            {rootDepartments.map((department) => (
              <DepartmentNode
                key={department.id}
                department={department}
                departments={data.departments}
                members={data.members}
                depth={0}
                canManage={canManage}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="two-column">
        <div className="card">
          <h2 className="card-title">新建部门</h2>
          <form action={createDepartment} className="form-grid">
            <label>
              上级部门
              <select name="parentId" required defaultValue={defaultParentId}>
                {data.departments.map((department) => (
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
                {data.departments.map((department) => (
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
            仅 L1 可新建、改名与删除；根节点为系统控制权入口，不可删除。越权写入会被数据库策略直接拒绝。
          </p>
        </div>

        <div className="card">
          <h2 className="card-title">添加成员</h2>
          <form action={addMember} className="form-grid">
            <label>
              所属部门
              <select name="departmentId" required defaultValue={defaultParentId}>
                {data.departments.map((department) => (
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
                list="title-suggestions"
                placeholder="例如：交付经理、架构师、HRBP"
              />
              <datalist id="title-suggestions">
                {titleOptions.map((title) => (
                  <option key={title} value={title} />
                ))}
              </datalist>
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
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">最近审计（仅 L1 可见）</h2>
        {data.audits.length === 0 ? (
          <p className="hint">没有可见审计记录。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>动作</th>
                <th>对象</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {data.audits.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.id}</td>
                  <td className="mono">{row.action}</td>
                  <td className="mono">
                    {row.target_type ?? "-"} / {row.target_id ?? "-"}
                  </td>
                  <td className="mono">{new Date(row.created_at).toISOString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
