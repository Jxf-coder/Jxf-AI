CREATE TABLE IF NOT EXISTS "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipelines_name_len" CHECK (char_length(name) between 1 and 60),
	CONSTRAINT "pipelines_description_len" CHECK (char_length(description) <= 300),
	CONSTRAINT "pipelines_steps_shape" CHECK (
		jsonb_typeof(steps) = 'array'
		and jsonb_array_length(steps) between 1 and 10
	)
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pipelines_department_id_departments_id_fk'
  ) THEN
    ALTER TABLE "pipelines"
      ADD CONSTRAINT "pipelines_department_id_departments_id_fk"
      FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pipelines_created_by_users_id_fk'
  ) THEN
    ALTER TABLE "pipelines"
      ADD CONSTRAINT "pipelines_created_by_users_id_fk"
      FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipelines_department_idx"
  ON "pipelines" USING btree ("tenant_id", "department_id", "created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"work_item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"failed_step" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_runs_pipeline_id_pipelines_id_fk'
  ) THEN
    ALTER TABLE "pipeline_runs"
      ADD CONSTRAINT "pipeline_runs_pipeline_id_pipelines_id_fk"
      FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_runs_department_id_departments_id_fk'
  ) THEN
    ALTER TABLE "pipeline_runs"
      ADD CONSTRAINT "pipeline_runs_department_id_departments_id_fk"
      FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_runs_requested_by_users_id_fk'
  ) THEN
    ALTER TABLE "pipeline_runs"
      ADD CONSTRAINT "pipeline_runs_requested_by_users_id_fk"
      FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_runs_pipeline_idx"
  ON "pipeline_runs" USING btree ("tenant_id", "pipeline_id", "created_at" DESC NULLS LAST);
