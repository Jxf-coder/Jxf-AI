-- 通知渠道：SMTP 邮件
--
-- 配置来源优先级：设置面（app_settings）> 环境变量（SMTP_HOST 等）。
-- 口令与模型 Key 一样加密入库（v1.<iv>.<tag>.<data>），页面只展示末 4 位。
-- runtime_settings() 供 Web / runner 在无用户上下文时读取通知配置。

alter table "app_settings" add column if not exists "notify_email_enabled" boolean not null default false;
--> statement-breakpoint
alter table "app_settings" add column if not exists "smtp_host" text;
--> statement-breakpoint
alter table "app_settings" add column if not exists "smtp_port" integer;
--> statement-breakpoint
alter table "app_settings" add column if not exists "smtp_user" text;
--> statement-breakpoint
alter table "app_settings" add column if not exists "smtp_pass_enc" text;
--> statement-breakpoint
alter table "app_settings" add column if not exists "smtp_pass_hint" text;
--> statement-breakpoint
alter table "app_settings" add column if not exists "notify_email_to" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_smtp_port_range'
  ) THEN
    ALTER TABLE "app_settings"
      ADD CONSTRAINT "app_settings_smtp_port_range"
      CHECK ("smtp_port" is null or "smtp_port" between 1 and 65535);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_smtp_host_length'
  ) THEN
    ALTER TABLE "app_settings"
      ADD CONSTRAINT "app_settings_smtp_host_length"
      CHECK ("smtp_host" is null or char_length("smtp_host") <= 255);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_notify_email_to_length'
  ) THEN
    ALTER TABLE "app_settings"
      ADD CONSTRAINT "app_settings_notify_email_to_length"
      CHECK ("notify_email_to" is null or char_length("notify_email_to") <= 500);
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
    'notify_email_to', s.notify_email_to
  )
  FROM app_settings s
  WHERE s.id = 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.runtime_settings() FROM public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.runtime_settings() TO jxf_app;
