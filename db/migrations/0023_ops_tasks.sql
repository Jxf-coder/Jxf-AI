CREATE TABLE IF NOT EXISTS "ops_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"requested_by_user_id" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ops_tasks_kind" CHECK (kind in ('backup', 'restore_verify')),
	CONSTRAINT "ops_tasks_status" CHECK (status in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ops_tasks_requested_by_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "ops_tasks"
      ADD CONSTRAINT "ops_tasks_requested_by_user_id_users_id_fk"
      FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ops_tasks_status_idx"
  ON "ops_tasks" USING btree ("tenant_id", "status", "requested_at" DESC NULLS LAST);
