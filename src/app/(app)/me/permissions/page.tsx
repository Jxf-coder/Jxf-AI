import { headers } from "next/headers";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";

export const dynamic = "force-dynamic";

interface RoleRow {
  id: string;
  kind: string;
  slug: string;
  name: string;
}

interface AuditRow {
  id: number;
  action: string;
  created_at: Date;
}

export default async function PermissionsPage() {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const data = await withUserContext(context, async (client) => {
    const roles = await client.query<RoleRow>(
      "select id, kind, slug, name from roles order by created_at",
    );
    const audits = await client.query<AuditRow>(
      "select id, action, created_at from audit_events order by id desc limit 10",
    );
    return { roles: roles.rows, audits: audits.rows };
  });

  return (
    <section>
      <header className="section-header">
        <div>
          <h1 className="section-title">我的权限</h1>
          <p className="section-subtitle">P1 验收入口：数据库是授权唯一权威，不在前端做判断</p>
        </div>
        <span className={`badge ${context.accessLevel ? "badge-ok" : "badge-error"}`}>
          {context.accessLevel ?? "NO ACCESS"}
        </span>
      </header>

      <div className="card">
        <h2 className="card-title">请求上下文（SET LOCAL 注入值）</h2>
        <dl className="meta-grid">
          <div>
            <div className="meta-label">user_id</div>
            <div className="meta-value">{context.userId}</div>
          </div>
          <div>
            <div className="meta-label">tenant_id</div>
            <div className="meta-value">{context.tenantId}</div>
          </div>
          <div>
            <div className="meta-label">access_level</div>
            <div className="meta-value">{context.accessLevel ?? "(empty)"}</div>
          </div>
          <div>
            <div className="meta-label">role_ids</div>
            <div className="meta-value">{context.roleIds.length > 0 ? context.roleIds.join(", ") : "(empty)"}</div>
          </div>
          <div>
            <div className="meta-label">request_id</div>
            <div className="meta-value">{requestId ?? "-"}</div>
          </div>
        </dl>
        <p className="hint">
          若 access_level 为空、role_ids 为空，所有 RLS 策略都不会命中，查询返回 0 行。
        </p>
      </div>

      <div className="two-column">
        <div className="card">
          <h2 className="card-title">可见岗位（{data.roles.length}）</h2>
          {data.roles.length === 0 ? (
            <p className="hint">0 行。</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>类型</th>
                  <th>slug</th>
                </tr>
              </thead>
              <tbody>
                {data.roles.map((role) => (
                  <tr key={role.id}>
                    <td>{role.name}</td>
                    <td className="mono">{role.kind}</td>
                    <td className="mono">{role.slug}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card" id="audit">
          <h2 className="card-title">最近审计（仅 L1 可见）</h2>
          {data.audits.length === 0 ? (
            <p className="hint">0 行（无权限或尚无记录）。</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>动作</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {data.audits.map((row) => (
                  <tr key={row.id}>
                    <td className="mono">{row.id}</td>
                    <td className="mono">{row.action}</td>
                    <td className="mono">{new Date(row.created_at).toISOString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
