-- 产线事件触发：外部 Webhook + 内部事件总线
--
-- 外部 Webhook：
--   - 每个产线可生成一次性展示的令牌（库内只存 SHA-256 哈希与末 4 位提示）；
--   - POST /api/webhooks/pipelines/:id 校验令牌后以产线发起人身份运行。
--
-- 内部事件：
--   - pipeline_events 为追加式事件总线（发布用 SECURITY DEFINER 函数，避免给
--     worker / 业务角色开放业务表写权限）；
--   - pipeline_event_subscriptions 记录「哪个产线订阅哪类事件」；
--   - 宿主机 runner 轮询 pending 事件并按订阅触发产线（trigger_kind='event'）。

alter table "pipelines" add column if not exists "webhook_enabled" boolean not null default false;
--> statement-breakpoint
alter table "pipelines" add column if not exists "webhook_token_hash" text;
--> statement-breakpoint
alter table "pipelines" add column if not exists "webhook_token_hint" text;
--> statement-breakpoint
alter table "pipeline_runs" add column if not exists "trigger_ref" text;
--> statement-breakpoint
alter table "pipeline_runs" drop constraint if exists "pipeline_runs_trigger_kind_valid";
--> statement-breakpoint
alter table "pipeline_runs" add constraint "pipeline_runs_trigger_kind_valid"
  check ("trigger_kind" in ('manual', 'schedule', 'webhook', 'event'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_event_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "pipeline_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pipeline_event_subscriptions_type" CHECK (
    "event_type" in ('knowledge.ingest_done', 'mcp.connector_changed', 'work_item.finished')
  ),
  CONSTRAINT "pipeline_event_subscriptions_pipeline_fk"
    FOREIGN KEY ("pipeline_id") REFERENCES "pipelines" ("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_event_subscriptions_unique"
  ON "pipeline_event_subscriptions" ("pipeline_id", "event_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_event_subscriptions_dispatch_idx"
  ON "pipeline_event_subscriptions" ("tenant_id", "event_type")
  WHERE "enabled";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "run_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone,
  CONSTRAINT "pipeline_events_status" CHECK ("status" in ('pending', 'processed', 'failed')),
  CONSTRAINT "pipeline_events_type_length" CHECK (char_length("event_type") between 1 and 80),
  CONSTRAINT "pipeline_events_attempts" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_events_pending_idx"
  ON "pipeline_events" ("created_at")
  WHERE "status" = 'pending';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.publish_event(
  p_tenant_id uuid,
  p_event_type text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'publish_event: tenant_id is required';
  END IF;
  INSERT INTO pipeline_events (tenant_id, event_type, payload)
  VALUES (p_tenant_id, p_event_type, coalesce(p_payload, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.pipeline_webhook_lookup(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id', p.id,
    'tenant_id', p.tenant_id,
    'name', p.name,
    'enabled', p.enabled,
    'created_by', p.created_by,
    'webhook_enabled', p.webhook_enabled,
    'token_hash', p.webhook_token_hash
  )
  FROM pipelines p
  WHERE p.id = p_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.publish_event(uuid, text, jsonb) FROM public;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.pipeline_webhook_lookup(uuid) FROM public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.publish_event(uuid, text, jsonb) TO jxf_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.pipeline_webhook_lookup(uuid) TO jxf_app;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    EXECUTE 'grant execute on function app.publish_event(uuid, text, jsonb) to app_worker';
  END IF;
END $$;
