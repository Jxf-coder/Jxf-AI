import { headers } from "next/headers";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { authorize } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { ResolvedPermissions } from "@/types/permission";

import { AuditTypeFilter } from "./AuditTypeFilter";

export const dynamic = "force-dynamic";

interface AuditRow {
  id: number;
  action: string;
  target_type: string | null;
  target_id: string | null;
  payload: Record<string, unknown> | null;
  occurred_at: string;
  department_name: string | null;
  actor_name: string | null;
  actor_phone: string | null;
  actor_email: string | null;
}

function text(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function flag(payload: Record<string, unknown> | null, key: string): boolean {
  return payload?.[key] === true;
}

/**
 * 展示用时间：默认截断到秒（YYYY-MM-DD HH:mm:ss），
 * title 仍保留含毫秒与时区的完整 ISO 时间戳，便于高频排查。
 */
function splitAuditTime(value: string): { display: string; full: string } {
  const full = value || "";
  const display =
    full.length >= 19 && full.includes("T")
      ? `${full.slice(0, 10)} ${full.slice(11, 19)}`
      : full;
  return { display, full };
}

function describeAudit(row: AuditRow): { label: string; detail: string } {
  const payload = row.payload;
  switch (row.action) {
    case "department.created":
      return { label: "新增部门", detail: text(payload, "name") ?? "—" };
    case "department.updated":
      return { label: "修改部门名称", detail: text(payload, "name") ?? "—" };
    case "department.deleted":
      return { label: "删除部门", detail: text(payload, "name") ?? "—" };
    case "department.reordered": {
      const name = text(payload, "departmentName");
      const before = text(payload, "beforeName");
      return {
        label: "调整部门顺序",
        detail: name && before ? `「${name}」移到「${before}」前方` : "同级顺序调整",
      };
    }
    case "membership.created": {
      const parts = [text(payload, "title"), text(payload, "accessLevel")].filter(Boolean);
      const department = text(payload, "departmentName");
      return {
        label: "新增成员",
        detail: [department, ...parts].filter(Boolean).join(" · ") || "—",
      };
    }
    case "membership.removed": {
      const name = text(payload, "memberName") ?? "成员";
      const department = text(payload, "departmentName");
      return {
        label: "移出成员",
        detail: department ? `${name} · ${department}（已停用，可恢复）` : `${name}（已停用，可恢复）`,
      };
    }
    case "membership.restored": {
      const name = text(payload, "memberName") ?? "成员";
      const department = text(payload, "departmentName");
      return {
        label: "恢复成员",
        detail: department ? `${name} · ${department}` : name,
      };
    }
    case "membership.moved": {
      const name = text(payload, "memberName") ?? "成员";
      const from = text(payload, "fromName");
      const to = text(payload, "toName");
      return {
        label: "调整成员部门",
        detail: from && to ? `${name}：${from} → ${to}` : name,
      };
    }
    case "profile.core_updated": {
      const changes: string[] = [];
      if (flag(payload, "nameChanged")) {
        changes.push("姓名");
      }
      if (flag(payload, "phoneChanged")) {
        changes.push("手机号");
      }
      if (flag(payload, "avatarChanged")) {
        changes.push("头像");
      }
      return {
        label: "修改个人资料",
        detail: changes.length > 0 ? changes.join("、") : "资料保存",
      };
    }
    case "profile.email_added":
      return { label: "添加邮箱", detail: text(payload, "email") ?? "—" };
    case "profile.birthday_updated":
      return { label: "修改生日", detail: text(payload, "birthday") ?? "已清空" };
    case "profile.primary_email_changed":
      return { label: "切换默认主邮箱", detail: text(payload, "email") ?? "—" };
    case "profile.email_removed":
      return { label: "解绑邮箱", detail: text(payload, "email") ?? "—" };
    case "profile.membership_updated": {
      const changes: string[] = [];
      const previousTitle = text(payload, "previousTitle");
      const title = text(payload, "title");
      if (previousTitle !== title) {
        changes.push(`岗位 ${previousTitle ?? "—"} → ${title ?? "—"}`);
      }
      const previousLevel = text(payload, "previousAccessLevel");
      const level = text(payload, "accessLevel");
      if (previousLevel && level && previousLevel !== level) {
        changes.push(`等级 ${previousLevel} → ${level}`);
      }
      if (text(payload, "previousDepartmentId") !== text(payload, "departmentId")) {
        const department = text(payload, "departmentName");
        changes.push(department ? `所属部门 → ${department}` : "调整所属部门");
      }
      const isPermissionChange = previousLevel !== level && Boolean(level);
      return {
        label: isPermissionChange ? "权限变更" : "组织与岗位变更",
        detail: changes.join("；") || "无实质变化",
      };
    }
    case "member.basics_updated": {
      const parts = [
        text(payload, "memberName"),
        text(payload, "employeeNo"),
        text(payload, "position"),
      ].filter(Boolean);
      return { label: "修改员工资料", detail: parts.join(" · ") || "—" };
    }
    case "approval.reassigned":
      return {
        label: "转交待处理审批单",
        detail: `${String(payload?.count ?? 0)} 条`,
      };
    case "permission.template_updated":
      return {
        label: "修改角色模板",
        detail: `${text(payload, "level") ?? "—"} · ${String(payload?.count ?? 0)} 项`,
      };
    case "permission.member_grants_updated":
      return {
        label: "修改成员授权",
        detail: `${text(payload, "targetName") ?? "成员"} · ${String(payload?.count ?? 0)} 项`,
      };
    case "permission.member_grants_reset":
      return {
        label: "恢复默认权限",
        detail: text(payload, "targetName") ?? "成员",
      };
    case "membership.removal_requested": {
      const name = text(payload, "memberName") ?? "成员";
      const department = text(payload, "departmentName");
      const assetCount = Number(payload?.assetCount ?? 0);
      return {
        label: "发起离职交接",
        detail: `${department ? `${name} · ${department}` : name} · ${assetCount} 项资产`,
      };
    }
    case "approval.approved":
    case "approval.rejected":
    case "approval.cancelled": {
      const name = text(payload, "memberName") ?? "成员";
      const reason = text(payload, "reason");
      const label =
        row.action === "approval.approved"
          ? "通过交接审批"
          : row.action === "approval.rejected"
            ? "驳回交接审批"
            : "撤回交接申请";
      return {
        label,
        detail: reason ? `${name} · ${reason}` : name,
      };
    }
    case "auth.login":
      return { label: "登录工作台", detail: "—" };
    default:
      return {
        label: row.action,
        detail: row.target_type ?? "—",
      };
  }
}

/** 审计日志：按权限可见范围展示最近 200 条组织、成员、资料与权限变更 */
export async function AuditTab({
  logType = "all",
  order = "desc",
}: {
  logType?: "all" | "permission" | "system";
  order?: "asc" | "desc";
}) {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const direction = order === "asc" ? "asc" : "desc";

  const data = await withUserContext(context, async (client) => {
    let actor: ResolvedPermissions | null = null;
    try {
      actor = await resolveContextPermissions(client, context);
    } catch {
      actor = null;
    }

    const canReadAudit = actor ? authorize(actor, "audit:read").allowed : false;
    if (!canReadAudit) {
      return { canReadAudit, rows: [] as AuditRow[] };
    }

    const result = await client.query<AuditRow>(
      `select a.id, a.action, a.target_type, a.target_id, a.payload,
              to_char(
                a.created_at at time zone 'Asia/Shanghai',
                'YYYY-MM-DD"T"HH24:MI:SS.MS'
              ) || '+08:00' as occurred_at,
              d.name as department_name,
              u.name as actor_name, u.phone as actor_phone, u.email as actor_email
         from audit_events a
         left join departments d on d.id = a.department_id
         left join users u on u.id = a.actor_user_id
        where (
          $1::text = 'all'
          or ($1::text = 'permission' and a.action like 'permission.%')
          or ($1::text = 'system' and a.action not like 'permission.%')
        )
        order by a.created_at ${direction}, a.id ${direction}
        limit 200`,
      [logType],
    );
    return { canReadAudit, rows: result.rows };
  });

  const scopeText = !data.canReadAudit
    ? "无权限"
    : context.accessLevel === "L1"
      ? "全部成员的操作"
      : context.accessLevel === "L2"
        ? "本人 + 本部门及下级部门的操作"
        : "无可见范围";

  return (
    <div>
      <div className="audit-toolbar">
        <p className="hint">当前可见范围：{scopeText}</p>
        <div className="approval-actions">
          {data.canReadAudit ? (
            <>
              <a
                className="button button-ghost"
                href={`/api/audit/export?type=${logType}&format=csv`}
              >
                导出 CSV
              </a>
              <a
                className="button button-ghost"
                href={`/api/audit/export?type=${logType}&format=jsonl`}
              >
                导出 JSONL
              </a>
            </>
          ) : null}
          <AuditTypeFilter type={logType} order={order} />
        </div>
      </div>

      {!data.canReadAudit ? (
        <div className="alert-error">无权查看审计日志：当前账号缺少「查看审计日志」权限。</div>
      ) : null}

      <div className="card">
        {data.rows.length === 0 ? (
          <p className="hint">暂无可见审计记录。</p>
        ) : (
          <ul className="audit-list">
            {data.rows.map((row) => {
              const { label, detail } = describeAudit(row);
              const time = splitAuditTime(row.occurred_at);
              const actor = row.actor_name || row.actor_phone || row.actor_email || "系统";
              return (
                <li className="audit-item" key={row.id}>
                  <div className="audit-main">
                    <span className="audit-action">{label}</span>
                    <span className="audit-detail">{detail}</span>
                  </div>
                  <div className="audit-meta">
                    <span>{actor}</span>
                    <span className="audit-dept">{row.department_name ?? "全局"}</span>
                    <time dateTime={time.full} title={time.full}>
                      {time.display}
                    </time>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="hint">
          按时间{order === "asc" ? "正序" : "倒序"}展示最近 200 条；更早记录可用上方导出按范围获取。
          审计只追加，留存默认 365 天，由运维执行 <code>npm run audit:prune</code> 清理。
        </p>
      </div>
    </div>
  );
}
