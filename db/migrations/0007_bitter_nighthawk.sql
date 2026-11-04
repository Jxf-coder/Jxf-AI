ALTER TABLE "audit_events" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "birthday" date;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "employee_no" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "hire_date" date;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "position" text;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_employee_no_unique" ON "memberships" USING btree ("tenant_id","employee_no") WHERE employee_no is not null;