CREATE TYPE "public"."share_status" AS ENUM('none', 'pending_approval', 'approved', 'rejected');--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "share_status" "share_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "share_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "share_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "share_reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "share_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN "share_status" "share_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN "share_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN "share_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN "share_reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN "share_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_share_requested_by_users_id_fk" FOREIGN KEY ("share_requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_share_reviewed_by_users_id_fk" FOREIGN KEY ("share_reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD CONSTRAINT "knowledge_cards_share_requested_by_users_id_fk" FOREIGN KEY ("share_requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD CONSTRAINT "knowledge_cards_share_reviewed_by_users_id_fk" FOREIGN KEY ("share_reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;