"use client";

import { useMemo, useState } from "react";

import { CollapsibleSection } from "@/components/ui/collapsible";
import { Select, type SelectOption } from "@/components/ui/select";
import { PERMISSION_SCOPE_LABEL } from "@/lib/permissions/scope";
import type { AdminGrantMap, AdminMember, AdminModule } from "@/types/permission-admin";
import type { PermissionKey, PermissionScope } from "@/types/permission";
import type { AccessLevel } from "@/types/profile";

import { RiskBadge, ScopeSelect } from "./parts";

type MemberMode = "inherit" | "allow" | "deny";

export function MemberPanel({
  modules,
  ceilings,
  members,
  templates,
  selectedMemberId,
  draft,
  onSelectMember,
  onModeChange,
  onScopeChange,
  onReset,
  resetting,
}: {
  modules: AdminModule[];
  ceilings: Record<AccessLevel, readonly PermissionKey[]>;
  members: AdminMember[];
  templates: Record<AccessLevel, AdminGrantMap>;
  selectedMemberId: string;
  draft: AdminGrantMap;
  onSelectMember: (userId: string) => void;
  onModeChange: (key: PermissionKey, mode: MemberMode) => void;
  onScopeChange: (key: PermissionKey, scope: PermissionScope) => void;
  onReset: () => void;
  resetting: boolean;
}) {
  const [memberSearch, setMemberSearch] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [nodeSearch, setNodeSearch] = useState("");

  const selected = members.find((member) => member.userId === selectedMemberId) ?? null;
  const template = selected ? templates[selected.level] ?? {} : {};
  const templateCount = Object.values(template).filter((grant) => grant.effect === "allow").length;
  const overrideCount = Object.keys(draft).length;
  const allowed = useMemo(
    () => new Set<PermissionKey>(selected ? ceilings[selected.level] : []),
    [ceilings, selected],
  );

  const filteredMembers = useMemo(() => {
    const keyword = memberSearch.trim().toLowerCase();
    if (!keyword) {
      return members;
    }
    return members.filter(
      (member) =>
        (member.name ?? "").toLowerCase().includes(keyword) ||
        (member.phone ?? "").includes(keyword) ||
        (member.departmentName ?? "").toLowerCase().includes(keyword),
    );
  }, [memberSearch, members]);

  const keyword = nodeSearch.trim().toLowerCase();

  return (
    <div className="perm-layout">
      <aside className="perm-member-list">
        <input
          className="perm-search perm-search-block"
          value={memberSearch}
          onChange={(event) => setMemberSearch(event.target.value)}
          placeholder="搜索成员、手机号、部门"
          aria-label="搜索成员"
        />
        <div className="perm-member-scroll">
          {filteredMembers.length === 0 ? (
            <p className="perm-empty">没有匹配的成员。</p>
          ) : (
            filteredMembers.map((member) => {
              const active = member.userId === selectedMemberId;
              const initial = (member.name || member.phone || "J").trim().charAt(0).toUpperCase();
              return (
                <button
                  key={member.userId}
                  type="button"
                  className={`perm-member${active ? " is-active" : ""}`}
                  onClick={() => onSelectMember(member.userId)}
                >
                  <span className="perm-avatar">{initial}</span>
                  <span className="perm-member-meta">
                    <span className="perm-member-name">
                      {member.name || member.phone || "未命名成员"}
                      <span className={`badge level-${(member.level ?? "L3").toLowerCase()}`}>
                        {member.level === "L1" ? "老板" : member.level || "—"}
                      </span>
                    </span>
                    <span className="perm-member-dept">{member.departmentName || "—"}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <div className="perm-panel">
        {!selected ? (
          <p className="perm-empty">请选择左侧成员。</p>
        ) : (
          <>
            <div className="perm-panel-head">
              <div>
                <h2 className="perm-panel-title">
                  {selected.name || selected.phone || "未命名成员"}
                  <span className={`badge level-${(selected.level ?? "L3").toLowerCase()}`}>
                    {selected.level === "L1" ? "老板" : selected.level || "—"}
                  </span>
                </h2>
                <p className="perm-panel-subtitle">
                  {selected.departmentName || "—"}
                  {selected.phone ? ` · ${selected.phone}` : ""} · 模板 {templateCount} 项 · 个人覆盖{" "}
                  {overrideCount} 项
                </p>
              </div>
              <div className="perm-panel-actions">
                <input
                  className="perm-search"
                  value={nodeSearch}
                  onChange={(event) => setNodeSearch(event.target.value)}
                  placeholder="搜索权限点、Key"
                  aria-label="搜索成员权限点"
                />
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={onReset}
                  disabled={resetting || overrideCount === 0 || selected.level === "L1"}
                >
                  {resetting ? "恢复中…" : "恢复默认"}
                </button>
              </div>
            </div>

            {selected.level === "L1" ? (
              <p className="perm-note">L1 默认拥有全部非保护区权限，无需配置个人授权。</p>
            ) : (
              modules.map((module) => {
                const nodes = module.nodes.filter((node) => {
                  if (!allowed.has(node.key)) {
                    return false;
                  }
                  if (!keyword) {
                    return true;
                  }
                  return (
                    (node.nameZh ?? "").toLowerCase().includes(keyword) ||
                    (node.key ?? "").toLowerCase().includes(keyword) ||
                    (node.description ?? "").toLowerCase().includes(keyword)
                  );
                });
                if (nodes.length === 0) {
                  return null;
                }

                const open = !collapsed.has(module.key);
                return (
                  <CollapsibleSection
                    key={module.key}
                    open={open}
                    onToggle={() =>
                      setCollapsed((current) => {
                        const next = new Set(current);
                        if (next.has(module.key)) {
                          next.delete(module.key);
                        } else {
                          next.add(module.key);
                        }
                        return next;
                      })
                    }
                    title={module.nameZh}
                    description={module.description}
                    meta={`${nodes.length} 项`}
                  >
                    {nodes.map((node) => {
                      const override = draft[node.key];
                      const templateGrant = template[node.key];
                      const mode: MemberMode = override ? override.effect : "inherit";
                      const enabled = mode === "allow";

                      const modeOptions: SelectOption[] = [
                        {
                          value: "inherit",
                          label: `继承${
                            templateGrant
                              ? `（${
                                  templateGrant.effect === "deny"
                                    ? "拒绝"
                                    : PERMISSION_SCOPE_LABEL[templateGrant.scope]
                                }）`
                              : "（未开启）"
                          }`,
                        },
                        { value: "allow", label: "允许" },
                        { value: "deny", label: "拒绝" },
                      ];

                      return (
                        <div className="perm-row" key={node.key}>
                          <div className="perm-row-main">
                            <div className="perm-row-title">
                              <span className="perm-row-name">{node.nameZh}</span>
                              <RiskBadge risk={node.risk} />
                              {override ? (
                                <span
                                  className={`perm-tag ${
                                    override.effect === "deny" ? "perm-tag-deny" : "perm-tag-allow"
                                  }`}
                                >
                                  {override.effect === "deny" ? "拒绝" : "覆盖"}
                                </span>
                              ) : (
                                <span className="perm-tag perm-tag-template">继承模板</span>
                              )}
                            </div>
                            <p className="perm-row-desc">{node.description}</p>
                            <code className="perm-key">{node.key}</code>
                          </div>

                          <div className="perm-row-controls">
                            {!node.grantable ? (
                              <span className="perm-muted">系统保留</span>
                            ) : (
                              <>
                                <div className="perm-row-scope">
                                  {enabled && override ? (
                                    <ScopeSelect
                                      node={node}
                                      value={override.scope}
                                      onChange={(scope) => onScopeChange(node.key, scope)}
                                    />
                                  ) : (
                                    <span className="perm-muted">—</span>
                                  )}
                                </div>
                                <Select
                                  className="perm-mode-select"
                                  value={mode}
                                  aria-label={`${node.nameZh}授权方式`}
                                  options={modeOptions}
                                  onValueChange={(next) => onModeChange(node.key, next as MemberMode)}
                                />
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </CollapsibleSection>
                );
              })
            )}
          </>
        )}
      </div>
    </div>
  );
}
