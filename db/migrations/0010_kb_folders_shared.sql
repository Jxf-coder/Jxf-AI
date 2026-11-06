ALTER TABLE "knowledge_cards" ALTER COLUMN "visibility" SET DEFAULT 'department';--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "role_key" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "folder_key" text DEFAULT '01-original' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "visibility" text DEFAULT 'department' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN "role_key" text;--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN "folder_key" text DEFAULT '02-cards' NOT NULL;--> statement-breakpoint
CREATE INDEX "documents_folder_idx" ON "documents" USING btree ("department_id","role_key","folder_key");--> statement-breakpoint
CREATE INDEX "knowledge_cards_folder_idx" ON "knowledge_cards" USING btree ("department_id","role_key","folder_key");--> statement-breakpoint
-- 该列此前从未被 RLS 使用，历史行全部按默认值 'shared' 落库；
-- 0010 起 visibility 真正参与读策略，必须先收回为部门隔离，共享需显式设置。
UPDATE "knowledge_cards" SET "visibility" = 'department';