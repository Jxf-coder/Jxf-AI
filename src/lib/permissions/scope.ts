/**
 * 权限作用域：决定一个 PermissionNode 能落在哪些数据上。
 *
 * - ALL：全租户（仅 L1 或全局型动作使用）
 * - DEPT_TREE：本部门 + 全部直属子部门（只允许读类动作）
 * - DEPT：严格本部门（写类动作默认）
 * - SELF：仅本人 / 本人创建的资源
 *
 * 作用域是「授权行」的属性，不是 PermissionNode 的全局属性；
 * 同一个节点在不同成员身上可以授予不同 Scope。
 */

export const PERMISSION_SCOPES = ["ALL", "DEPT_TREE", "DEPT", "SELF"] as const;

export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

const SCOPE_RANK: Record<PermissionScope, number> = {
  ALL: 4,
  DEPT_TREE: 3,
  DEPT: 2,
  SELF: 1,
};

export const PERMISSION_SCOPE_LABEL: Record<PermissionScope, string> = {
  ALL: "全租户",
  DEPT_TREE: "本部门及子部门",
  DEPT: "本部门",
  SELF: "仅本人",
};

export function isPermissionScope(value: unknown): value is PermissionScope {
  return typeof value === "string" && (PERMISSION_SCOPES as readonly string[]).includes(value);
}

export function scopeRank(scope: PermissionScope): number {
  return SCOPE_RANK[scope];
}

/** granted 是否覆盖 requested；例如 DEPT_TREE 覆盖 DEPT，DEPT 不覆盖 DEPT_TREE。 */
export function isScopeWithin(requested: PermissionScope, granted: PermissionScope): boolean {
  return SCOPE_RANK[requested] <= SCOPE_RANK[granted];
}

/** 从候选里取最宽的作用域；空数组返回 null。 */
export function widestScope(scopes: readonly PermissionScope[]): PermissionScope | null {
  let best: PermissionScope | null = null;
  for (const scope of scopes) {
    if (!best || SCOPE_RANK[scope] > SCOPE_RANK[best]) {
      best = scope;
    }
  }
  return best;
}

export interface ScopeMatchInput {
  scope: PermissionScope;
  /** 当前任用部门 */
  activeDepartmentId: string | null;
  /** 资源所属部门；无部门资源（全局配置等）传 null */
  resourceDepartmentId: string | null;
  /** 当前部门子树（含自身）；只用于 DEPT_TREE */
  subtreeDepartmentIds: readonly string[];
  /** SELF 判定：资源是否属于本人 */
  isOwnResource?: boolean;
}

/**
 * 判断某个 Scope 是否覆盖目标资源。
 * 注意：这是纯函数，调用方必须先用数据库读出的资源行，而不是客户端参数。
 */
export function scopeCoversResource(input: ScopeMatchInput): boolean {
  const { scope, activeDepartmentId, resourceDepartmentId, subtreeDepartmentIds, isOwnResource } = input;

  if (scope === "ALL") {
    return true;
  }

  if (scope === "SELF") {
    return Boolean(isOwnResource);
  }

  if (!activeDepartmentId || !resourceDepartmentId) {
    return false;
  }

  if (scope === "DEPT") {
    return resourceDepartmentId === activeDepartmentId;
  }

  return resourceDepartmentId === activeDepartmentId || subtreeDepartmentIds.includes(resourceDepartmentId);
}
