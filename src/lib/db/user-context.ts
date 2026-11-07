import { cookies } from "next/headers";
import type { PoolClient } from "pg";

import { getPool } from "@/lib/db/pool";
import { loadEnv } from "@/lib/env";

export type AccessLevel = "L1" | "L2" | "L3";

export const ACTIVE_DEPARTMENT_COOKIE = "jxf_active_department";

export interface ActiveMembership {
  id: string;
  departmentId: string;
  departmentName: string;
  level: AccessLevel;
  title: string;
}

export interface UserContext {
  userId: string;
  tenantId: string;
  /** 当前上下文任用；无有效任用时为 null */
  activeMembership: ActiveMembership | null;
  /** 全部有效任用，供部门切换器使用 */
  activeMemberships: ActiveMembership[];
  activeMembershipId: string | null;
  activeDepartmentId: string | null;
  activeDepartmentName: string | null;
  /** 全部任用部门 id（仅用于展示，不参与 SET LOCAL） */
  membershipDepartmentIds: string[];
  /** RLS 作用域根：L2/L3 只有当前部门；L1 为全租户部门 */
  departmentIds: string[];
  /** 当前部门子树（含自身）；L1 为全租户部门 */
  subtreeDepartmentIds: string[];
  accessLevel: AccessLevel | null;
  permissionVersion: number;
  requestId?: string;
}

interface MembershipRow {
  membership_id: string;
  department_id: string;
  department_name: string;
  level_text: string;
  title: string;
}

const ACCESS_LEVELS: readonly AccessLevel[] = ["L1", "L2", "L3"];

function toAccessLevel(raw: string): AccessLevel | null {
  return (ACCESS_LEVELS as readonly string[]).includes(raw) ? (raw as AccessLevel) : null;
}

async function readPreferredDepartmentId(): Promise<string | null> {
  try {
    const store = await cookies();
    return store.get(ACTIVE_DEPARTMENT_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

function mapMemberships(rows: MembershipRow[]): ActiveMembership[] {
  return rows.flatMap((row) => {
    const level = toAccessLevel(row.level_text);
    if (!level) {
      return [];
    }
    return [
      {
        id: row.membership_id,
        departmentId: row.department_id,
        departmentName: row.department_name,
        level,
        title: row.title,
      },
    ];
  });
}

async function queryActiveMemberships(client: PoolClient, userId: string): Promise<ActiveMembership[]> {
  const { rows } = await client.query<MembershipRow>(
    `select membership_id, department_id, department_name, level_text, title
       from app.user_active_memberships($1)`,
    [userId],
  );
  return mapMemberships(rows);
}

/** 供部门切换器等场景单独使用；调用方自行管理连接。 */
export async function listActiveMemberships(userId: string): Promise<ActiveMembership[]> {
  const client = await getPool().connect();
  try {
    return await queryActiveMemberships(client, userId);
  } finally {
    client.release();
  }
}

/**
 * 解析请求上下文。
 * - 只加载当前任用，不再合并全部部门；
 * - L1 拥有全租户数据范围，保持上帝视角；
 * - L2/L3 的作用域严格限制在当前部门（读子树、写本部门由 RLS 决定）。
 */
export async function resolveUserContext(userId: string, requestId?: string): Promise<UserContext> {
  const env = loadEnv();
  const preferredDepartmentId = await readPreferredDepartmentId();
  const client = await getPool().connect();

  try {
    const memberships = await queryActiveMemberships(client, userId);
    const active =
      memberships.find((membership) => membership.departmentId === preferredDepartmentId) ??
      memberships[0] ??
      null;

    if (!active) {
      return emptyContext(userId, env.tenantId, memberships, requestId);
    }

    return await buildContext(client, userId, env.tenantId, active, memberships, requestId);
  } finally {
    client.release();
  }
}

/**
 * 按「指定任用」解析上下文（MCP 令牌 / 机器调用使用）。
 * 任用不存在、不属于该用户、非在岗或已移除时返回空上下文（fail-closed）。
 */
export async function resolveUserContextForMembership(
  userId: string,
  membershipId: string,
  requestId?: string,
): Promise<UserContext> {
  const env = loadEnv();
  const client = await getPool().connect();

  try {
    // 走 SECURITY DEFINER 的任用列表函数：直接查 memberships 会被 RLS 挡掉
    const rows = await queryActiveMemberships(client, userId);
    const active = rows.find((membership) => membership.id === membershipId);
    if (!active) {
      return emptyContext(userId, env.tenantId, [], requestId);
    }

    return await buildContext(client, userId, env.tenantId, active, [active], requestId);
  } finally {
    client.release();
  }
}

function emptyContext(
  userId: string,
  tenantId: string,
  memberships: ActiveMembership[],
  requestId?: string,
): UserContext {
  return {
    userId,
    tenantId,
    activeMembership: null,
    activeMemberships: memberships,
    activeMembershipId: null,
    activeDepartmentId: null,
    activeDepartmentName: null,
    membershipDepartmentIds: memberships.map((membership) => membership.departmentId),
    departmentIds: [],
    subtreeDepartmentIds: [],
    accessLevel: null,
    permissionVersion: 0,
    requestId,
  };
}

async function buildContext(
  client: PoolClient,
  userId: string,
  tenantId: string,
  active: ActiveMembership,
  memberships: ActiveMembership[],
  requestId?: string,
): Promise<UserContext> {
  const scopeResult =
    active.level === "L1"
      ? await client.query<{ ids: string[] }>("select app.tenant_department_ids($1) as ids", [
          tenantId,
        ])
      : await client.query<{ ids: string[] }>("select app.department_subtree_ids($1) as ids", [
          active.departmentId,
        ]);

  const versionResult = await client.query<{ version: string | number }>(
    "select app.user_permission_version($1) as version",
    [userId],
  );

  const subtreeDepartmentIds = scopeResult.rows[0]?.ids ?? [active.departmentId];

  return {
    userId,
    tenantId,
    activeMembership: active,
    activeMemberships: memberships,
    activeMembershipId: active.id,
    activeDepartmentId: active.departmentId,
    activeDepartmentName: active.departmentName,
    membershipDepartmentIds: memberships.map((membership) => membership.departmentId),
    // L1 需要全租户写范围；L2/L3 只写当前部门
    departmentIds: active.level === "L1" ? subtreeDepartmentIds : [active.departmentId],
    subtreeDepartmentIds,
    accessLevel: active.level,
    permissionVersion: Number(versionResult.rows[0]?.version ?? 0),
    requestId,
  };
}

function toPgUuidArray(ids: string[]): string {
  return `{${ids.join(",")}}`;
}

/**
 * 每个请求一个事务，事务内注入 SET LOCAL 上下文。
 * 未登录 / 无有效任用时 access_level 为空、department_ids 为空 → 所有策略不命中（fail-closed）。
 */
export async function withUserContext<T>(
  context: UserContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query("begin");
    await client.query(
      `select
         set_config('app.user_id', $1, true),
         set_config('app.tenant_id', $2, true),
         set_config('app.access_level', $3, true),
         set_config('app.department_ids', $4, true),
         set_config('app.active_department_id', $5, true),
         set_config('app.membership_id', $6, true),
         set_config('app.permission_version', $7, true)`,
      [
        context.userId,
        context.tenantId,
        context.accessLevel ?? "",
        toPgUuidArray(context.departmentIds),
        context.activeDepartmentId ?? "",
        context.activeMembershipId ?? "",
        String(context.permissionVersion),
      ],
    );

    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
