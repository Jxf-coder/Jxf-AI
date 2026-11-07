ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "daily_quota" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_tool_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"arguments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result_preview" text,
	"error" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tool_approvals_status" CHECK (status in ('pending', 'approved', 'rejected', 'failed'))
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_tool_approvals_token_id_mcp_tokens_id_fk'
  ) THEN
    ALTER TABLE "mcp_tool_approvals"
      ADD CONSTRAINT "mcp_tool_approvals_token_id_mcp_tokens_id_fk"
      FOREIGN KEY ("token_id") REFERENCES "public"."mcp_tokens"("id") ON DELETE cascade;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_tool_approvals_membership_id_memberships_id_fk'
  ) THEN
    ALTER TABLE "mcp_tool_approvals"
      ADD CONSTRAINT "mcp_tool_approvals_membership_id_memberships_id_fk"
      FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_tool_approvals_department_id_departments_id_fk'
  ) THEN
    ALTER TABLE "mcp_tool_approvals"
      ADD CONSTRAINT "mcp_tool_approvals_department_id_departments_id_fk"
      FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_tool_approvals_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "mcp_tool_approvals"
      ADD CONSTRAINT "mcp_tool_approvals_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_tool_approvals_decided_by_users_id_fk'
  ) THEN
    ALTER TABLE "mcp_tool_approvals"
      ADD CONSTRAINT "mcp_tool_approvals_decided_by_users_id_fk"
      FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_tool_approvals_tenant_idx"
  ON "mcp_tool_approvals" USING btree ("tenant_id","status","created_at" DESC NULLS LAST);
