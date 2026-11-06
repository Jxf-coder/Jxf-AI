CREATE TABLE "knowledge_card_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"rev" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" "card_status" NOT NULL,
	"edited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_card_versions" ADD CONSTRAINT "knowledge_card_versions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_card_versions" ADD CONSTRAINT "knowledge_card_versions_card_id_knowledge_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."knowledge_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_card_versions" ADD CONSTRAINT "knowledge_card_versions_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_card_versions_rev_unique" ON "knowledge_card_versions" USING btree ("card_id","rev");--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD CONSTRAINT "knowledge_cards_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;