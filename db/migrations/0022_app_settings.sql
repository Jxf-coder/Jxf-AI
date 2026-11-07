CREATE TABLE IF NOT EXISTS "app_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"site_name" text DEFAULT 'AI 工作台' NOT NULL,
	"site_tagline" text DEFAULT '私有化交付的 AI 员工平台' NOT NULL,
	"brand_primary" text DEFAULT '#0071e3' NOT NULL,
	"brand_strong" text DEFAULT '#13315c' NOT NULL,
	"brand_deep" text DEFAULT '#0b2545' NOT NULL,
	"brand_soft" text DEFAULT '#eff4ff' NOT NULL,
	"ai_enabled" boolean,
	"ai_base_url" text,
	"ai_api_key_enc" text,
	"ai_api_key_hint" text,
	"ai_model_pro" text,
	"ai_model_flash" text,
	"audit_retention_days" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	CONSTRAINT "app_settings_single_row" CHECK (id = 1),
	CONSTRAINT "app_settings_site_name" CHECK (char_length(site_name) between 1 and 40),
	CONSTRAINT "app_settings_site_tagline" CHECK (char_length(site_tagline) <= 120),
	CONSTRAINT "app_settings_brand_primary" CHECK (brand_primary ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "app_settings_brand_strong" CHECK (brand_strong ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "app_settings_brand_deep" CHECK (brand_deep ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "app_settings_brand_soft" CHECK (brand_soft ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "app_settings_audit_retention" CHECK (audit_retention_days is null or audit_retention_days between 30 and 3650)
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_updated_by_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "app_settings"
      ADD CONSTRAINT "app_settings_updated_by_user_id_users_id_fk"
      FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO "app_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.public_branding()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'site_name', s.site_name,
    'site_tagline', s.site_tagline,
    'brand_primary', s.brand_primary,
    'brand_strong', s.brand_strong,
    'brand_deep', s.brand_deep,
    'brand_soft', s.brand_soft
  )
  FROM app_settings s
  WHERE s.id = 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.public_branding() FROM public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.public_branding() TO jxf_app;
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
    'audit_retention_days', s.audit_retention_days
  )
  FROM app_settings s
  WHERE s.id = 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.runtime_settings() FROM public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.runtime_settings() TO jxf_app;
