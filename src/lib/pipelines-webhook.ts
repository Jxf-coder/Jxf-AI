/**
 * 产线外部 Webhook。
 *
 * - 令牌只在生成时返回一次，库内保存 SHA-256 哈希与末 4 位提示；
 * - 校验使用 timingSafeEqual，避免逐字节比较泄露；
 * - 查库走 SECURITY DEFINER 的 app.pipeline_webhook_lookup()，
 *   因此路由不需要用户会话，也不能读取其它产线。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { auditInTx } from "@/lib/audit";
import { getPool } from "@/lib/db/pool";
import { withUserContext, type UserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";
import type { PermissionResource } from "@/types/permission";

import { PipelineInputError } from "./pipelines";

export interface WebhookLookup {
  id: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  createdBy: string | null;
  webhookEnabled: boolean;
  tokenHash: string | null;
}

interface LookupRow {
  id: string;
  tenant_id: string;
  name: string;
  enabled: boolean;
  created_by: string | null;
  webhook_enabled: boolean;
  token_hash: string | null;
}

function departmentResource(context: UserContext): PermissionResource {
  const departmentId = context.activeDepartmentId;
  return { kind: "department", id: departmentId ?? undefined, departmentId };
}

export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function webhookTokenHint(token: string): string {
  return `••••${token.slice(-4)}`;
}

export async function lookupWebhookPipeline(pipelineId: string): Promise<WebhookLookup | null> {
  const { rows } = await getPool().query<{ value: LookupRow | null }>(
    "select app.pipeline_webhook_lookup($1) as value",
    [pipelineId],
  );
  const row = rows[0]?.value;
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    enabled: Boolean(row.enabled),
    createdBy: row.created_by,
    webhookEnabled: Boolean(row.webhook_enabled),
    tokenHash: row.token_hash,
  };
}

/** 恒定时间比较；哈希均为 64 位 hex */
export function verifyWebhookToken(lookup: WebhookLookup | null, token: string): boolean {
  if (!lookup?.webhookEnabled || !lookup.tokenHash || !token) {
    return false;
  }
  const expected = Buffer.from(lookup.tokenHash, "utf8");
  const actual = Buffer.from(hashWebhookToken(token), "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface RotatedWebhookToken {
  /** 仅此一次返回明文；之后只能看到末 4 位提示 */
  token: string;
  hint: string;
}

export async function rotateWebhookToken(
  context: UserContext,
  pipelineId: string,
): Promise<RotatedWebhookToken> {
  const token = randomBytes(32).toString("hex");
  const hash = hashWebhookToken(token);
  const hint = webhookTokenHint(token);

  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "pipeline:manage", departmentResource(context));
    const updated = await client.query(
      `update pipelines
          set webhook_enabled = true,
              webhook_token_hash = $2,
              webhook_token_hint = $3,
              updated_at = now()
        where id = $1 and tenant_id = $4`,
      [pipelineId, hash, hint, context.tenantId],
    );
    if (updated.rowCount === 0) {
      throw new PipelineInputError("产线不存在或无权操作");
    }
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "pipeline.webhook_rotated",
      targetType: "pipeline",
      targetId: pipelineId,
      departmentId: context.activeDepartmentId,
      payload: { token_hint: hint },
    });
  });

  return { token, hint };
}

export async function disableWebhook(context: UserContext, pipelineId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "pipeline:manage", departmentResource(context));
    const updated = await client.query(
      `update pipelines
          set webhook_enabled = false,
              webhook_token_hash = null,
              webhook_token_hint = null,
              updated_at = now()
        where id = $1 and tenant_id = $2`,
      [pipelineId, context.tenantId],
    );
    if (updated.rowCount === 0) {
      throw new PipelineInputError("产线不存在或无权操作");
    }
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "pipeline.webhook_disabled",
      targetType: "pipeline",
      targetId: pipelineId,
      departmentId: context.activeDepartmentId,
    });
  });
}
