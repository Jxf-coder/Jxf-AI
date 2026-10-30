import { headers } from "next/headers";
import Link from "next/link";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";

import { addMember, createRole, removeMember } from "./actions";

export const dynamic = "force-dynamic";

interface RoleRow {
  id: string;
  parent_id: string | null;
  kind: "root" | "child" | "seat";
  slug: string;
  name: string;
}

interface MemberRow {
  id: string;
  role_id: string;
  access_level: string;
  email: string;
  name: string | null;
}

interface AuditRow {
  id: number;
  action: string;
  target_type: string | null;
  target_id: string | null;
  created_at: Date;
}

function RoleNodeView({
  role,
  roles,
  members,
  depth,
}: {
  role: RoleRow;
  roles: RoleRow[];
  members: MemberRow[];
  depth: number;
}) {
  const children = roles.filter((child) => child.parent_id === role.id);
  const roleMembers = members.filter((member) => member.role_id === role.id);

  return (
    <li>
      <div className="role-node">
        <span className={`badge badge-kind-${role.kind}`}>{role.kind}</span>
        <strong>{role.name}</strong>
        <span className="mono role-slug">{role.slug}</span>
      </div>
      {roleMembers.length > 0 ? (
        <ul className="member-list">
          {roleMembers.map((member) => (
            <li key={member.id}>
              <span className="mono">{member.access_level}</span>
              <span>{member.email}</span>
              <form action={removeMember}>
                <input type="hidden" name="membershipId" value={member.id} />
                <button type="submit" className="link-danger">
                  移出
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
      {children.length > 0 ? (
        <ul className={`role-tree role-tree-depth-${Math.min(depth + 1, 3)}`}>
          {children.map((child) => (
            <RoleNodeView
              key={child.id}
              role={child}
              roles={roles}
              members={members}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default async function AiEmployeesPage() {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const data = await withUserContext(context, async (client) => {
    const roles = await client.query<RoleRow>(
      "select id, parent_id, kind, slug, name from roles order by created_at",
    );
    const members = await client.query<MemberRow>(
      `select m.id, m.role_id, m.access_level, u.email, u.name
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
      roles: roles.rows,
      members: members.rows,
      audits: audits.rows,
    };
  });

  return (
    <section>
      <header className="section-header">
        <div>
          <h1 className="section-title">AI 员工 · 岗位树</h1>
          <p className="section-subtitle">
            当前身份：{session.email} · 等级 {context.accessLevel ?? "无"} · 岗位数{" "}
            {context.roleIds.length}
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
        <h2 className="card-title">岗位树</h2>
        {data.roles.length === 0 ? (
          <p className="hint">没有可见岗位（可能是权限不足，或尚未创建）。</p>
        ) : (
          <ul className="role-tree">
            {data.roles
              .filter(
                (role) =>
                  role.parent_id === null ||
                  !data.roles.some((candidate) => candidate.id === role.parent_id),
              )
              .map((role) => (
                <RoleNodeView
                  key={role.id}
                  role={role}
                  roles={data.roles}
                  members={data.members}
                  depth={0}
                />
              ))}
          </ul>
        )}
      </div>

      <div className="two-column">
        <div className="card">
          <h2 className="card-title">新建岗位</h2>
          <form action={createRole} className="form-grid">
            <label>
              类型
              <select name="kind" defaultValue="child">
                <option value="child">child</option>
                <option value="seat">seat</option>
              </select>
            </label>
            <label>
              上级岗位
              <select name="parentId" required>
                {data.roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name} · {role.slug}
                  </option>
                ))}
              </select>
            </label>
            <label>
              名称
              <input name="name" required maxLength={80} placeholder="例如：华东交付组" />
            </label>
            <label>
              slug
              <input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,63}" placeholder="east-delivery" />
            </label>
            <button type="submit" className="button">
              新建岗位
            </button>
          </form>
        </div>

        <div className="card">
          <h2 className="card-title">添加成员</h2>
          <form action={addMember} className="form-grid">
            <label>
              岗位
              <select name="roleId" required>
                {data.roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name} · {role.kind}
                  </option>
                ))}
              </select>
            </label>
            <label>
              邮箱
              <input name="email" type="email" required placeholder="user@example.com" />
            </label>
            <label>
              等级
              <select name="accessLevel" defaultValue="L3">
                <option value="L1">L1</option>
                <option value="L2">L2</option>
                <option value="L3">L3</option>
              </select>
            </label>
            <button type="submit" className="button">
              添加成员
            </button>
          </form>
          <p className="hint">只有 L1 能写入；越权写入会被数据库策略直接拒绝。</p>
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
