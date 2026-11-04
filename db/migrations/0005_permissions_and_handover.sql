CREATE TYPE "public"."user_status" AS ENUM('active', 'pending_handover', 'disabled');--> statement-breakpoint
ALTER TYPE "public"."membership_status" ADD VALUE 'pending_removal' BEFORE 'removed';--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	CONSTRAINT "approval_requests_status" CHECK (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "handover_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"approval_id" uuid NOT NULL,
	"asset_type" text NOT NULL,
	"asset_id" text NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"transferred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_revisions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_template_grants" (
	"template_id" text NOT NULL,
	"permission_key" text NOT NULL,
	"scope_type" text NOT NULL,
	"effect" text DEFAULT 'allow' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_template_grants_scope_shape" CHECK ((scope_type in ('ALL', 'SELF')) or (scope_type in ('DEPT', 'DEPT_TREE'))),
	CONSTRAINT "role_template_grants_effect" CHECK (effect in ('allow', 'deny'))
);
--> statement-breakpoint
CREATE TABLE "role_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"level" "access_level" NOT NULL,
	"is_system" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_permission_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"effect" text DEFAULT 'allow' NOT NULL,
	"granted_by" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_permission_grants_scope_type" CHECK (scope_type in ('ALL', 'DEPT_TREE', 'DEPT', 'SELF')),
	CONSTRAINT "user_permission_grants_effect" CHECK (effect in ('allow', 'deny')),
	CONSTRAINT "user_permission_grants_scope_shape" CHECK (((scope_type in ('ALL', 'SELF') and scope_id is null) or (scope_type in ('DEPT', 'DEPT_TREE') and scope_id is not null)))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" "user_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_items" ADD CONSTRAINT "handover_items_approval_id_approval_requests_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_items" ADD CONSTRAINT "handover_items_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_items" ADD CONSTRAINT "handover_items_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_revisions" ADD CONSTRAINT "permission_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_template_grants" ADD CONSTRAINT "role_template_grants_template_id_role_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."role_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_tenant_status_idx" ON "approval_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "approval_requests_subject_idx" ON "approval_requests" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "handover_items_approval_idx" ON "handover_items" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "handover_items_from_idx" ON "handover_items" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "handover_items_to_idx" ON "handover_items" USING btree ("to_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_template_grants_unique" ON "role_template_grants" USING btree ("template_id","permission_key");--> statement-breakpoint
CREATE UNIQUE INDEX "user_permission_grants_user_key_unique" ON "user_permission_grants" USING btree ("tenant_id","user_id","permission_key");--> statement-breakpoint
CREATE INDEX "user_permission_grants_user_idx" ON "user_permission_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_permission_grants_key_idx" ON "user_permission_grants" USING btree ("permission_key");