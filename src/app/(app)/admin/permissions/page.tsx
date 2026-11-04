import { headers } from "next/headers";
import Link from "next/link";

import { requireSession } from "@/lib/auth/session";
import { resolveUserContext, withUserContext } from "@/lib/db/user-context";
import { authorize, authorizeProtected } from "@/lib/permissions/authorize";
import { resolveContextPermissions } from "@/lib/permissions/server";
import type { ResolvedPermissions } from "@/types/permission";

import { AuditTab } from "./AuditTab";
import { GrantsTab } from "./GrantsTab";
import { MineTab } from "./MineTab";
import { RolesTab } from "./RolesTab";

export const dynamic = "force-dynamic";

type TabKey = "mine" | "roles" | "grants" | "audit";
type AuditLogType = "all" | "permission" | "system";
type AuditOrder = "asc" | "desc";

const TAB_LABEL: Record<TabKey, string> = {
  mine: "我的权限",
  roles: "角色管理",
  grants: "成员授权",
  audit: "审计日志",
};

const TAB_ORDER: readonly TabKey[] = ["mine", "roles", "grants", "audit"];

export default async function PermissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; type?: string; order?: string }>;
}) {
  const session = await requireSession();
  const requestId = (await headers()).get("x-request-id") ?? undefined;
  const context = await resolveUserContext(session.userId, requestId);

  const access = await withUserContext(context, async (client) => {
    let actor: ResolvedPermissions | null = null;
    try {
      actor = await resolveContextPermissions(client, context);
    } catch {
      actor = null;
    }
    return {
      canManage: actor
        ? authorizeProtected(actor, "protected:permission_grant").allowed
        : false,
      canReadAudit: actor ? authorize(actor, "audit:read").allowed : false,
    };
  });

  const tabs = TAB_ORDER.filter((key) =>
    key === "mine" ? true : key === "audit" ? access.canReadAudit : access.canManage,
  );

  const params = await searchParams;
  const active = tabs.includes(params.tab as TabKey) ? (params.tab as TabKey) : "mine";
  const logType: AuditLogType =
    params.type === "permission" || params.type === "system" ? params.type : "all";
  const auditOrder: AuditOrder = params.order === "asc" ? "asc" : "desc";

  return (
    <section>
      <header className="section-header">
        <div>
          <h1 className="section-title">权限管理</h1>
          <p className="section-subtitle">
            我的权限、角色模板、成员授权与审计日志统一入口 · 角色与授权仅 L1 可编辑
          </p>
        </div>
        <span className={`badge ${context.accessLevel ? "badge-ok" : "badge-error"}`}>
          {context.accessLevel ?? "NO ACCESS"}
        </span>
      </header>

      <nav className="perm-tabs" role="tablist" aria-label="权限管理">
        {tabs.map((key) => (
          <Link
            key={key}
            href={key === "mine" ? "/admin/permissions" : `/admin/permissions?tab=${key}`}
            role="tab"
            aria-selected={active === key}
            className={`perm-tab${active === key ? " is-active" : ""}`}
          >
            {TAB_LABEL[key]}
          </Link>
        ))}
      </nav>

      <div className="perm-tab-body">
        {active === "roles" ? (
          <RolesTab />
        ) : active === "grants" ? (
          <GrantsTab />
        ) : active === "audit" ? (
          <AuditTab logType={logType} order={auditOrder} />
        ) : (
          <MineTab />
        )}
      </div>
    </section>
  );
}
