-- 通知渠道：飞书 / 企业微信群机器人
--
-- 群机器人只需要一个 Webhook 地址（飞书可选签名密钥），不涉及 corpId / secret / 回调。
-- 地址与签名密钥与 SMTP 口令一样加密入库（v1/v2），页面只回显主机名与末 4 位。
-- 事件订阅用显式数组保存（默认三类全开）；空数组表示该渠道不接收任何业务事件。

alter table "app_settings" add column if not exists "notify_feishu_enabled" boolean not null default false;
--> statement-breakpoint
alter table "app_settings" add column if not exists "feishu_webhook_enc" text;
--> statement-breakpoint
alter table "app_settings" add column if not exists "feishu_webhook_hint" text;
--> statement-breakpoint
alter table "app_settings" add column if not exists "feishu_secret_enc" text;
--> statement-breakpoint
alter table "app_settings" add column if not exists "feishu_secret_hint" text;
--> statement-breakpoint
alter table "app_settings" add column if not exists "notify_feishu_events" text[] not null
  default array['mcp_health', 'ops_task', 'pipeline']::text[];
--> statement-breakpoint
alter table "app_settings" add column if not exists "notify_wecom_enabled" boolean not null default false;
--> statement-breakpoint
alter table "app_settings" add column if not exists "wecom_webhook_enc" text;
--> statement-breakpoint
alter table "app_settings" add column if not exists "wecom_webhook_hint" text;
--> statement-breakpoint
alter table "app_settings" add column if not exists "notify_wecom_events" text[] not null
  default array['mcp_health', 'ops_task', 'pipeline']::text[];
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_feishu_webhook_hint_length'
  ) THEN
    ALTER TABLE "app_settings"
      ADD CONSTRAINT "app_settings_feishu_webhook_hint_length"
      CHECK ("feishu_webhook_hint" is null or char_length("feishu_webhook_hint") <= 300);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_wecom_webhook_hint_length'
  ) THEN
    ALTER TABLE "app_settings"
      ADD CONSTRAINT "app_settings_wecom_webhook_hint_length"
      CHECK ("wecom_webhook_hint" is null or char_length("wecom_webhook_hint") <= 300);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_feishu_secret_hint_length'
  ) THEN
    ALTER TABLE "app_settings"
      ADD CONSTRAINT "app_settings_feishu_secret_hint_length"
      CHECK ("feishu_secret_hint" is null or char_length("feishu_secret_hint") <= 100);
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.runtime_settings()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'ai_enabled', s.ai_enabled,
    'ai_base_url', s.ai_base_url,
    'ai_api_key_enc', s.ai_api_key_enc,
    'ai_api_key_hint', s.ai_api_key_hint,
    'ai_model_pro', s.ai_model_pro,
    'ai_model_flash', s.ai_model_flash,
    'audit_retention_days', s.audit_retention_days,
    'notify_email_enabled', s.notify_email_enabled,
    'smtp_host', s.smtp_host,
    'smtp_port', s.smtp_port,
    'smtp_user', s.smtp_user,
    'smtp_pass_enc', s.smtp_pass_enc,
    'smtp_pass_hint', s.smtp_pass_hint,
    'notify_email_to', s.notify_email_to,
    'notify_feishu_enabled', s.notify_feishu_enabled,
    'feishu_webhook_enc', s.feishu_webhook_enc,
    'feishu_webhook_hint', s.feishu_webhook_hint,
    'feishu_secret_enc', s.feishu_secret_enc,
    'feishu_secret_hint', s.feishu_secret_hint,
    'notify_feishu_events', to_jsonb(s.notify_feishu_events),
    'notify_wecom_enabled', s.notify_wecom_enabled,
    'wecom_webhook_enc', s.wecom_webhook_enc,
    'wecom_webhook_hint', s.wecom_webhook_hint,
    'notify_wecom_events', to_jsonb(s.notify_wecom_events)
  )
  FROM app_settings s
  WHERE s.id = 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.runtime_settings() FROM public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.runtime_settings() TO jxf_app;
