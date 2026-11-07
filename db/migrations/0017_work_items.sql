CREATE TYPE "public"."work_item_status" AS ENUM('draft', 'queued', 'running', 'waiting_review', 'done', 'returned', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_employee_id" uuid,
	"assigned_by" uuid NOT NULL,
	"reviewer_id" uuid,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" "work_item_status" DEFAULT 'queued' NOT NULL,
	"current_run_id" uuid,
	"deliverable" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_ai_employee_id_ai_employees_id_fk" FOREIGN KEY ("ai_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_current_run_id_runs_id_fk" FOREIGN KEY ("current_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_items_department_status_idx" ON "work_items" USING btree ("department_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "work_items_employee_status_idx" ON "work_items" USING btree ("ai_employee_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "work_items_assigned_by_idx" ON "work_items" USING btree ("assigned_by","created_at" DESC NULLS LAST);
