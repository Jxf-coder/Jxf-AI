"use client";

import { Select } from "@/components/ui/select";
import { PERMISSION_SCOPE_LABEL } from "@/lib/permissions/scope";
import type { AdminNode } from "@/types/permission-admin";
import type { PermissionRisk, PermissionScope } from "@/types/permission";

const RISK_LABEL: Record<PermissionRisk, string> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "关键",
};

export function RiskBadge({ risk }: { risk: PermissionRisk }) {
  return <span className={`perm-risk perm-risk-${risk}`}>{RISK_LABEL[risk]}</span>;
}

/** 取该节点最宽（目录已按从宽到窄排序）的作用域作为默认值 */
export function defaultScope(node: AdminNode): PermissionScope {
  return node.allowedScopes[0] ?? "SELF";
}

export function ScopeSelect({
  node,
  value,
  disabled,
  onChange,
}: {
  node: AdminNode;
  value: PermissionScope;
  disabled?: boolean;
  onChange: (next: PermissionScope) => void;
}) {
  return (
    <Select
      className="perm-scope-select"
      value={value}
      disabled={disabled}
      aria-label={`${node.nameZh}作用域`}
      options={node.allowedScopes.map((scope) => ({
        value: scope,
        label: PERMISSION_SCOPE_LABEL[scope],
      }))}
      onValueChange={(next) => onChange(next as PermissionScope)}
    />
  );
}
