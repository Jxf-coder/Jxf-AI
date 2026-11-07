/**
 * 产线外部 Webhook 触发入口。
 *
 *   POST /api/webhooks/pipelines/:id
 *   Header: X-JXF-Token: <token>   （或 Authorization: Bearer <token>）
 *
 * 鉴权：每产线独立令牌，库内只存 SHA-256 哈希；恒定时间比较。
 * 身份：以产线发起人的上下文运行（沿用 assignWork 的权限与 RLS）。
 * 返回：202 + runId；令牌错误 401；产线不存在/未启用 Webhook 404；
 *       产线停用或无有效发起人 409；请求体过大 413。
 */

import { createHash } from "node:crypto";

import { resolveUserContext } from "@/lib/db/user-context";
import { errorMessage, log } from "@/lib/logger";
import { runPipeline } from "@/lib/pipelines";
import { lookupWebhookPipeline, verifyWebhookToken } from "@/lib/pipelines-webhook";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 64_000;

function tokenFrom(request: Request): string {
  const direct = request.headers.get("x-jxf-token")?.trim();
  if (direct) {
    return direct;
  }
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!UUID.test(id)) {
    return Response.json({ error: "invalid pipeline" }, { status: 400 });
  }

  const token = tokenFrom(request);
  if (!token) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const lookup = await lookupWebhookPipeline(id);
  if (!lookup || !lookup.webhookEnabled) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (!verifyWebhookToken(lookup, token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!lookup.enabled) {
    return Response.json({ error: "pipeline disabled" }, { status: 409 });
  }
  if (!lookup.createdBy) {
    return Response.json({ error: "pipeline has no owner" }, { status: 409 });
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return Response.json({ error: "payload too large" }, { status: 413 });
  }

  // 只记录请求摘要，不落外部系统原始负载，避免把第三方数据带进审计
  const triggerRef = body.trim()
    ? `webhook:${createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16)}`
    : "webhook";

  try {
    const userContext = await resolveUserContext(lookup.createdBy);
    if (!userContext.activeDepartmentId) {
      return Response.json({ error: "pipeline owner inactive" }, { status: 409 });
    }
    const result = await runPipeline(userContext, id, {
      trigger: "webhook",
      triggerRef,
    });
    return Response.json(
      {
        ok: true,
        pipeline: lookup.name,
        runId: result.runId,
        nextStepIndex: result.nextStepIndex,
        failedStep: result.failedStep,
      },
      { status: 202 },
    );
  } catch (caught) {
    log("warn", "pipeline_webhook_run_failed", {
      pipeline_id: id,
      error: errorMessage(caught),
    });
    return Response.json({ error: "trigger failed" }, { status: 409 });
  }
}
