import { headers } from "next/headers";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import {
  enabledPermissionModules,
  getPermissionNode,
  permissionKeysForModule,
} from "@/lib/permissions/catalog";
import { PERMISSION_SCOPE_LABEL } from "@/lib/permissions/scope";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { ResolvedPermissions } from "@/types/permission";

export const dynamic = "force-dynamic";

interface DepartmentRow {
  id: string;
  name: string;
}

export default async function PermissionsPage() {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const data = await withUserContext(context, async (client) => {
    const result = await client.query<DepartmentRow>(
      "select id, name from departments order by sort_order, created_at",
    );

    let actor: ResolvedPermissions | null = null;
    try {
      actor = await resolveContextPermissions(client, context);
    } catch {
      actor = null;
    }

    const modules = actor
      ? enabledPermissionModules()
          .map((module) => ({
            key: module.key,
            nameZh: module.nameZh,
            nodes: permissionKeysForModule(module.key)
              .filter((key) => actor.grants.has(key))
              .map((key) => ({
                key,
                nameZh: getPermissionNode(key).nameZh,
                scope: PERMISSION_SCOPE_LABEL[actor.grants.get(key) ?? "SELF"],
              })),
          }))
          .filter((module) => module.nodes.length > 0)
      : [];

    return {
      departments: result.rows,
      effectiveModules: modules,
      denies: actor ? [...actor.denies] : [],
    };
  });

  return (
    <section>
      <header className="section-header">
        <div>
          <h1 className="section-title">我的权限</h1>
          <p className="section-subtitle">请求上下文：只加载当前任用，RLS 与权限判定共用同一份作用域</p>
        </div>
        <span className={`badge ${context.accessLevel ? "badge-ok" : "badge-error"}`}>
          {context.accessLevel ?? "NO ACCESS"}
        </span>
      </header>

      <div className="card">
        <h2 className="card-title">我的有效权限</h2>
        {data.effectiveModules.length === 0 ? (
          <p className="hint">当前没有有效权限（可能是账号没有有效任用）。</p>
        ) : (
          <div className="effective-groups">
            {data.effectiveModules.map((module) => (
              <div className="effective-group" key={module.key}>
                <div className="effective-group-title">{module.nameZh}</div>
                <div className="effective-chips">
                  {module.nodes.map((node) => (
                    <span className="badge" key={node.key}>
                      {node.nameZh} · {node.scope}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {data.denies.length > 0 ? (
          <p className="hint">显式拒绝：{data.denies.join("、")}</p>
        ) : null}
      </div>

      <div className="card">
        <h2 className="card-title">当前任用（SET LOCAL 注入值）</h2>
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
            <div className="meta-label">active_membership_id</div>
            <div className="meta-value">{context.activeMembershipId ?? "(empty)"}</div>
          </div>
          <div>
            <div className="meta-label">active_department</div>
            <div className="meta-value">
              {context.activeDepartmentName ?? "(empty)"}
              {context.activeDepartmentId ? ` · ${context.activeDepartmentId}` : ""}
            </div>
          </div>
          <div>
            <div className="meta-label">access_level</div>
            <div className="meta-value">{context.accessLevel ?? "(empty)"}</div>
          </div>
          <div>
            <div className="meta-label">permission_version</div>
            <div className="meta-value">{context.permissionVersion}</div>
          </div>
          <div>
            <div className="meta-label">department_ids（RLS 作用域根）</div>
            <div className="meta-value">
              {context.departmentIds.length > 0 ? context.departmentIds.join(", ") : "(empty)"}
            </div>
          </div>
          <div>
            <div className="meta-label">subtree_department_ids</div>
            <div className="meta-value">{context.subtreeDepartmentIds.length} 个部门</div>
          </div>
          <div>
            <div className="meta-label">request_id</div>
            <div className="meta-value">{requestId ?? "-"}</div>
          </div>
        </dl>
        <p className="hint">
          若 access_level 为空、department_ids 为空，所有 RLS 策略都不会命中，查询返回 0
          行。L1 的 department_ids 为全租户部门；L2 / L3 仅当前部门。
        </p>
      </div>

      <div className="card">
        <h2 className="card-title">我的有效任用（{context.activeMemberships.length}）</h2>
        {context.activeMemberships.length === 0 ? (
          <p className="hint">没有任何有效任用。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>部门</th>
                <th>业务岗位</th>
                <th>等级</th>
                <th>当前</th>
              </tr>
            </thead>
            <tbody>
              {context.activeMemberships.map((membership) => (
                <tr key={membership.id}>
                  <td>{membership.departmentName}</td>
                  <td>{membership.title}</td>
                  <td>{membership.level}</td>
                  <td>{membership.id === context.activeMembershipId ? "是" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">可见部门（{data.departments.length}）</h2>
        {data.departments.length === 0 ? (
          <p className="hint">0 行。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
              </tr>
            </thead>
            <tbody>
              {data.departments.map((department) => (
                <tr key={department.id}>
                  <td>{department.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
