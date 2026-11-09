/**
 * M4 MCP 令牌：签发、列表、吊销与外部请求解析。
 *
 * 红线：
 * - 明文只在签发时返回一次，库里只有 sha256；
 * - 令牌绑定任用：离岗、停用、过期、吊销任一成立即失效；
 * - 解析出的上下文按任用计算，L1 也只看该任用的部门（不因令牌扩大范围）。
 */

import { createHash, randomBytes } from "node:crypto";

import { auditInTx } from "@/lib/audit";
import { getPool } from "@/lib/db/pool";
import type { UserContext } from "@/lib/db/user-context";
import { resolveUserContextForMembership, withUserContext } from "@/lib/db/user-context";
import { loadEnv } from "@/lib/env";
import { log } from "@/lib/logger";
import { normalizeMcpClient, type McpClientKey } from "@/lib/mcp/clients";
import { normalizeScope, type McpToolScope } from "@/lib/mcp/tools";
import { requireContextPermission } from "@/lib/permissions/server";

export type { McpClientKey } from "@/lib/mcp/clients";

export interface McpTokenView {
  id: string;
  name: string;
  tokenPrefix: string;
  client: McpClientKey | null;
  scope: McpToolScope;
  userName: string | null;
  departmentName: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  status: "active" | "revoked" | "expired";
}

export interface McpMembershipCandidate {
  membershipId: string;
  userId: string;
  userName: string | null;
  departmentName: string;
  level: string;
  title: string;
}

export interface IssueMcpTokenInput {
  name: string;
  membershipId: string;
  client?: McpClientKey | null;
  skills: string[];
  pipelines: string[];
  tools: string[];
  allowWrite: boolean;
  approvalTools: string[];
  channels: string[];
  expiresAt?: string | null;
}

export function hashMcpToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function statusOf(row: { revoked_at: Date | null; expires_at: Date | null }): McpTokenView["status"] {
  if (row.revoked_at) {
    return "revoked";
  }
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
    return "expired";
  }
  return "active";
}

export async function issueMcpToken(
  context: UserContext,
  input: IssueMcpTokenInput,
): Promise<{ id: string; token: string }> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 60) {
    throw new Error("令牌名称不能为空且不超过 60 字");
  }
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new Error("过期时间格式不正确");
  }
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new Error("过期时间必须晚于当前时间");
  }
  const scope = normalizeScope({
    skills: input.skills,
    pipelines: input.pipelines,
    tools: input.tools,
    allowWrite: input.allowWrite,
    approvalTools: input.approvalTools,
    channels: input.channels,
  });
  const clientKey = normalizeMcpClient(input.client);

  const token = `jxf_mcp_${randomBytes(32).toString("base64url")}`;
  const tokenHash = hashMcpToken(token);
  const tokenPrefix = token.slice(0, 16);

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "token:issue");

    const membership = await client.query<{
      id: string;
      user_id: string;
      department_id: string;
      status: string;
      removed_at: Date | null;
    }>(
      `select id, user_id, department_id, status::text as status, removed_at
         from memberships
        where id = $1 and tenant_id = $2`,
      [input.membershipId, context.tenantId],
    );
    const row = membership.rows[0];
    if (!row || row.status !== "active" || row.removed_at) {
      throw new Error("只能给在岗任用签发令牌");
    }

    const inserted = await client.query<{ id: string }>(
      `insert into mcp_tokens
         (tenant_id, name, token_hash, token_prefix, membership_id, user_id, department_id,
          client, scope, expires_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       returning id`,
      [
        context.tenantId,
        name,
        tokenHash,
        tokenPrefix,
        row.id,
        row.user_id,
        row.department_id,
        clientKey,
        JSON.stringify(scope),
        expiresAt,
        context.userId,
      ],
    );
    const id = inserted.rows[0].id;

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "mcp.token_issued",
      targetType: "mcp_token",
      targetId: id,
      departmentId: row.department_id,
      payload: {
        name,
        membership_id: row.id,
        client: clientKey,
        skills: scope.skills,
        pipelines: scope.pipelines,
        tools: scope.tools,
        allow_write: scope.allowWrite,
        approval_tools: scope.approvalTools,
        channels: scope.channels,
        expires_at: expiresAt?.toISOString() ?? null,
      },
    });

    return { id, token };
  });
}

export async function listMcpTokens(context: UserContext): Promise<McpTokenView[]> {
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "token:issue");

    const { rows } = await client.query<{
      id: string;
      name: string;
      token_prefix: string;
      client: string | null;
      scope: Record<string, unknown>;
      expires_at: Date | null;
      revoked_at: Date | null;
      last_used_at: Date | null;
      created_at: Date;
      user_name: string | null;
      department_name: string | null;
    }>(
      `select t.id, t.name, t.token_prefix, t.client, t.scope,
              t.expires_at, t.revoked_at, t.last_used_at, t.created_at,
              u.name as user_name, d.name as department_name
         from mcp_tokens t
         left join users u on u.id = t.user_id
         left join departments d on d.id = t.department_id
        where t.tenant_id = $1
          and t.deleted_at is null
        order by t.created_at desc
        limit 100`,
      [context.tenantId],
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      tokenPrefix: row.token_prefix,
      client: normalizeMcpClient(row.client),
      scope: normalizeScope(row.scope),
      userName: row.user_name,
      departmentName: row.department_name,
      expiresAt: toIso(row.expires_at),
      revokedAt: toIso(row.revoked_at),
      lastUsedAt: toIso(row.last_used_at),
      createdAt: row.created_at.toISOString(),
      status: statusOf(row),
    }));
  });
}

export async function listMcpTokenCandidates(
  context: UserContext,
): Promise<McpMembershipCandidate[]> {
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "token:issue");

    const { rows } = await client.query<{
      membership_id: string;
      user_id: string;
      user_name: string | null;
      department_name: string;
      level_text: string;
      title: string;
    }>(
      `select m.id as membership_id, m.user_id, u.name as user_name,
              d.name as department_name, m.access_level::text as level_text, m.title
         from memberships m
         join users u on u.id = m.user_id
         join departments d on d.id = m.department_id
        where m.tenant_id = $1
          and m.status = 'active'
          and m.removed_at is null
        order by d.sort_order, d.name, u.name
        limit 200`,
      [context.tenantId],
    );

    return rows.map((row) => ({
      membershipId: row.membership_id,
      userId: row.user_id,
      userName: row.user_name,
      departmentName: row.department_name,
      level: row.level_text,
      title: row.title,
    }));
  });
}

export async function revokeMcpToken(context: UserContext, tokenId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "token:revoke");

    const existing = await client.query<{
      id: string;
      department_id: string;
      revoked_at: Date | null;
      deleted_at: Date | null;
    }>(
      `select id, department_id, revoked_at, deleted_at
         from mcp_tokens
        where id = $1 and tenant_id = $2`,
      [tokenId, context.tenantId],
    );
    const row = existing.rows[0];
    if (!row || row.deleted_at) {
      throw new Error("令牌不存在或无权操作");
    }
    if (row.revoked_at) {
      return;
    }

    await client.query(`update mcp_tokens set revoked_at = now() where id = $1`, [tokenId]);

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "mcp.token_revoked",
      targetType: "mcp_token",
      targetId: tokenId,
      departmentId: row.department_id,
    });
  });
}

export interface RenewMcpTokenInput {
  expiresAt?: string | null;
  /** 重新激活：清除已关闭状态 */
  reactivate?: boolean;
}

/** 续期 / 重新激活：只改过期时间与关闭状态，不动令牌本身 */
export async function renewMcpToken(
  context: UserContext,
  tokenId: string,
  input: RenewMcpTokenInput,
): Promise<void> {
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new Error("过期时间格式不正确");
  }
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new Error("新的过期时间必须晚于当前时间");
  }
  const reactivate = input.reactivate === true;
  if (!expiresAt && !reactivate) {
    throw new Error("请填写新的过期时间或选择重新激活");
  }

  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "token:issue");

    const existing = await client.query<{
      id: string;
      department_id: string;
      deleted_at: Date | null;
    }>(`select id, department_id, deleted_at from mcp_tokens where id = $1 and tenant_id = $2`, [
      tokenId,
      context.tenantId,
    ]);
    const row = existing.rows[0];
    if (!row || row.deleted_at) {
      throw new Error("令牌不存在或已删除");
    }

    await client.query(
      `update mcp_tokens
          set expires_at = coalesce($2, expires_at),
              revoked_at = case when $3 then null else revoked_at end
        where id = $1`,
      [tokenId, expiresAt, reactivate],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "mcp.token_renewed",
      targetType: "mcp_token",
      targetId: tokenId,
      departmentId: row.department_id,
      payload: {
        expires_at: expiresAt?.toISOString() ?? null,
        reactivated: reactivate,
      },
    });
  });
}

/** 删除令牌：软删除并同时关闭，保留审计痕迹（RLS 不开放物理 DELETE） */
export async function deleteMcpToken(context: UserContext, tokenId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "token:revoke");

    const existing = await client.query<{
      id: string;
      department_id: string;
      deleted_at: Date | null;
    }>(`select id, department_id, deleted_at from mcp_tokens where id = $1 and tenant_id = $2`, [
      tokenId,
      context.tenantId,
    ]);
    const row = existing.rows[0];
    if (!row || row.deleted_at) {
      throw new Error("令牌不存在或已删除");
    }

    await client.query(
      `update mcp_tokens
          set deleted_at = now(), revoked_at = coalesce(revoked_at, now())
        where id = $1`,
      [tokenId],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "mcp.token_deleted",
      targetType: "mcp_token",
      targetId: tokenId,
      departmentId: row.department_id,
    });
  });
}

/** 一键清理失效令牌：已关闭或已过期的记录全部软删除 */
export async function cleanupInvalidMcpTokens(context: UserContext): Promise<number> {
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "token:revoke");

    const updated = await client.query<{ id: string }>(
      `update mcp_tokens
          set deleted_at = now(), revoked_at = coalesce(revoked_at, now())
        where tenant_id = $1
          and deleted_at is null
          and (revoked_at is not null or (expires_at is not null and expires_at <= now()))
        returning id`,
      [context.tenantId],
    );
    const count = updated.rowCount ?? 0;

    if (count > 0) {
      await auditInTx(client, context, {
        actorUserId: context.userId,
        action: "mcp.tokens_cleaned",
        targetType: "mcp_token",
        targetId: null,
        payload: { count },
      });
    }
    return count;
  });
}

export interface ResolvedMcpToken {
  tokenId: string;
  scope: McpToolScope;
  context: UserContext;
}

/**
 * 外部请求解析：Bearer token → 任用上下文。
 * 返回 null 表示令牌无效（不存在 / 吊销 / 过期 / 任用离岗）。
 */
export async function resolveMcpToken(rawToken: string): Promise<ResolvedMcpToken | null> {
  const env = loadEnv();
  const hash = hashMcpToken(rawToken);

  const { rows } = await getPool().query<{
    id: string;
    tenant_id: string;
    membership_id: string;
    user_id: string;
    department_id: string;
    scope: Record<string, unknown>;
  }>("select id, tenant_id, membership_id, user_id, department_id, scope from app.lookup_mcp_token($1)", [
    hash,
  ]);
  const row = rows[0];
  if (!row || row.tenant_id !== env.tenantId) {
    return null;
  }

  const context = await resolveUserContextForMembership(row.user_id, row.membership_id);
  if (!context.activeMembershipId) {
    return null;
  }

  void getPool()
    .query("select app.touch_mcp_token($1)", [row.id])
    .catch((error) => {
      log("warn", "mcp_token_touch_failed", { token_id: row.id, error: error instanceof Error ? error.message : String(error) });
    });

  return { tokenId: row.id, scope: normalizeScope(row.scope), context };
}
