"use client";

import { CollapsibleSection } from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import type { AdminGrantMap, AdminModule } from "@/types/permission-admin";
import type { PermissionKey, PermissionScope } from "@/types/permission";

import { RiskBadge, ScopeSelect } from "./parts";

export function TemplatePanel({
  modules,
  ceiling,
  draft,
  readOnly,
  search,
  onSearch,
  collapsed,
  onToggleModule,
  onToggleNode,
  onScopeChange,
}: {
  modules: AdminModule[];
  ceiling: readonly PermissionKey[];
  draft: AdminGrantMap;
  readOnly: boolean;
  search: string;
  onSearch: (value: string) => void;
  collapsed: ReadonlySet<string>;
  onToggleModule: (moduleKey: string) => void;
  onToggleNode: (key: PermissionKey, enabled: boolean) => void;
  onScopeChange: (key: PermissionKey, scope: PermissionScope) => void;
}) {
  const keyword = search.trim().toLowerCase();
  const allowed = new Set<PermissionKey>(ceiling);

  return (
    <div className="perm-panel">
      <div className="perm-panel-head">
        <div>
          <h2 className="perm-panel-title">角色模板</h2>
          <p className="perm-panel-subtitle">
            等级默认权限；成员未单独授权时按模板生效，保存后立即影响该等级全部成员。
          </p>
        </div>
        <input
          className="perm-search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="搜索权限点、Key"
          aria-label="搜索角色模板权限点"
        />
      </div>

      {modules.map((module) => {
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
        const enabledCount = nodes.filter((node) => draft[node.key]?.effect === "allow").length;

        return (
          <CollapsibleSection
            key={module.key}
            open={open}
            onToggle={() => onToggleModule(module.key)}
            title={module.nameZh}
            description={module.description}
            meta={`${enabledCount} / ${nodes.length}`}
          >
            {nodes.map((node) => {
              const grant = draft[node.key];
              const enabled = grant?.effect === "allow";
              return (
                <div className="perm-row" key={node.key}>
                  <div className="perm-row-main">
                    <div className="perm-row-title">
                      <span className="perm-row-name">{node.nameZh}</span>
                      <RiskBadge risk={node.risk} />
                      {node.requiresApproval ? <span className="perm-tag">需审批</span> : null}
                    </div>
                    <p className="perm-row-desc">{node.description}</p>
                    <code className="perm-key">{node.key}</code>
                  </div>
                  <div className="perm-row-controls">
                    <div className="perm-row-scope">
                      {enabled && grant ? (
                        <ScopeSelect
                          node={node}
                          value={grant.scope}
                          disabled={readOnly}
                          onChange={(scope) => onScopeChange(node.key, scope)}
                        />
                      ) : (
                        <span className="perm-muted">未开启</span>
                      )}
                    </div>
                    <Switch
                      checked={enabled}
                      disabled={readOnly}
                      label={`${node.nameZh}开关`}
                      onChange={(next) => onToggleNode(node.key, next)}
                    />
                  </div>
                </div>
              );
            })}
          </CollapsibleSection>
        );
      })}
    </div>
  );
}
