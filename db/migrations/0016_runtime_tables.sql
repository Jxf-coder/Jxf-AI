CREATE TYPE "public"."run_kind" AS ENUM('chat', 'task', 'workflow_step', 'ingest', 'regression');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'interrupted', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"department_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"ord" integer NOT NULL,
	"phase" text NOT NULL,
	"model" text,
	"provider" text,
	"finish_reason" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"role_key" text,
	"thread_id" uuid,
	"ai_employee_id" uuid,
	"kind" "run_kind" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"client_turn_id" text,
	"principal_id" uuid NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"worker_id" text,
	"lease_until" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"partial_text" text DEFAULT '' NOT NULL,
	"partial_updated_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"role_key" text,
	"ai_employee_id" uuid,
	"title" text,
	"created_by" uuid NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"run_id" uuid,
	"step_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid,
	"department_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"args_redacted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"result_chars" integer,
	"result_preview" text,
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_employees" ADD COLUMN "persona" text;--> statement-breakpoint
ALTER TABLE "ai_employees" ADD COLUMN "system_prompt" text;--> statement-breakpoint
ALTER TABLE "ai_employees" ADD COLUMN "skill_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_employees" ADD COLUMN "allowed_tools" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_employees" ADD COLUMN "model_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_ai_employee_id_ai_employees_id_fk" FOREIGN KEY ("ai_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_principal_id_users_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_ai_employee_id_ai_employees_id_fk" FOREIGN KEY ("ai_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usages" ADD CONSTRAINT "token_usages_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usages" ADD CONSTRAINT "token_usages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usages" ADD CONSTRAINT "token_usages_step_id_run_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."run_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_step_id_run_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."run_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_events_department_created_idx" ON "run_events" USING btree ("department_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_run_ord_unique" ON "run_steps" USING btree ("run_id","ord");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_client_turn_unique" ON "runs" USING btree ("tenant_id","principal_id","client_turn_id") WHERE client_turn_id is not null;--> statement-breakpoint
CREATE INDEX "runs_queue_idx" ON "runs" USING btree ("status","lease_until") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "runs_thread_created_idx" ON "runs" USING btree ("thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runs_department_created_idx" ON "runs" USING btree ("department_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "threads_department_run_idx" ON "threads" USING btree ("department_id","last_run_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "threads_created_by_idx" ON "threads" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "token_usages_department_created_idx" ON "token_usages" USING btree ("department_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "token_usages_run_idx" ON "token_usages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "tool_calls_run_idx" ON "tool_calls" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_calls_department_name_idx" ON "tool_calls" USING btree ("department_id","tool_name","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_logs" ADD CONSTRAINT "qa_logs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_runs_run_idx" ON "ingest_runs" USING btree ("run_id");