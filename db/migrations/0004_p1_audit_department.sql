ALTER TABLE "audit_events" ADD COLUMN "department_id" uuid;--> statement-breakpoint
CREATE INDEX "audit_events_department_idx" ON "audit_events" USING btree ("department_id");
