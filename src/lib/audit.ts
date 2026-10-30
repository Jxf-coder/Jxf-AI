import type { PoolClient } from "pg";

import { getPool } from "@/lib/db/pool";
import type { UserContext } from "@/lib/db/user-context";
import { loadEnv } from "@/lib/env";
import { errorMessage, log } from "@/lib/logger";

export interface AuditEvent {
  actorUserId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  requestId?: string | null;
  payload?: Record<string, unknown>;
}

const INSERT_AUDIT = `
  insert into audit_events
    (tenant_id, actor_user_id, action, target_type, target_id, request_id, payload)
  values ($1, $2, $3, $4, $5, $6, $7::jsonb)
`;

/** 在已注入上下文的业务事务内写审计（与业务写入同生共死） */
export async function auditInTx(
  client: PoolClient,
  context: UserContext,
  event: AuditEvent,
): Promise<void> {
  await client.query(INSERT_AUDIT, [
    context.tenantId,
    event.actorUserId,
    event.action,
    event.targetType ?? null,
    event.targetId ?? null,
    event.requestId ?? context.requestId ?? null,
    JSON.stringify(event.payload ?? {}),
  ]);
}

/** 无业务事务时使用（如登录成功）；失败只记日志，不阻断主流程 */
export async function auditStandalone(event: AuditEvent): Promise<void> {
  const env = loadEnv();
  const client = await getPool().connect();

  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [env.tenantId]);
    await client.query(INSERT_AUDIT, [
      env.tenantId,
      event.actorUserId,
      event.action,
      event.targetType ?? null,
      event.targetId ?? null,
      event.requestId ?? null,
      JSON.stringify(event.payload ?? {}),
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    log("error", "audit_write_failed", { action: event.action, error: errorMessage(error) });
  } finally {
    client.release();
  }
}
