"use client";

import type { AdminAuditEvent } from "@/types/permission-admin";

function describe(event: AdminAuditEvent): { label: string; detail: string } {
  const payload = event.payload;
  switch (event.action) {
    case "permission.template_updated":
      return {
        label: "修改角色模板",
        detail: `${String(payload.level ?? "—")} · ${String(payload.count ?? 0)} 项`,
      };
    case "permission.member_grants_updated":
      return {
        label: "修改成员授权",
        detail: `${event.targetName ?? "成员"} · ${String(payload.count ?? 0)} 项`,
      };
    case "permission.member_grants_reset":
      return {
        label: "恢复默认权限",
        detail: event.targetName ?? "成员",
      };
    default:
      return { label: event.action, detail: "—" };
  }
}

export function AuditPanel({ events }: { events: AdminAuditEvent[] }) {
  if (events.length === 0) {
    return <p className="perm-empty">暂无权限变更记录。</p>;
  }

  return (
    <div className="perm-panel">
      <div className="perm-panel-head">
        <div>
          <h2 className="perm-panel-title">变更记录</h2>
          <p className="perm-panel-subtitle">最近 50 条权限模板与成员授权变更，与业务写入同事务。</p>
        </div>
      </div>

      <ol className="perm-log">
        {events.map((event) => {
          const { label, detail } = describe(event);
          return (
            <li className="perm-log-item" key={event.id}>
              <span className={`perm-log-dot perm-log-dot-${event.action.split(".")[1] ?? "default"}`} />
              <div className="perm-log-main">
                <div className="perm-log-title">
                  <span>{label}</span>
                  <span className="perm-log-detail">{detail}</span>
                </div>
                <div className="perm-log-meta">
                  <span>{event.actorName ?? "系统"}</span>
                  <time>{event.occurredAt}</time>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
