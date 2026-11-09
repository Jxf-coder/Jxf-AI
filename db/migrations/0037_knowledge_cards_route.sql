-- 知识卡：来源通道、目录语义路由与多卡去重键。
--
-- 注意：
--   1. 蒸馏多卡不写 source_document_id（改用 source_ref.documentId），
--      因此旧的 knowledge_cards_source_document_unique 继续保留即可；
--   2. dedupe_key 走部分唯一索引，历史无来源的卡保持 NULL、不参与去重；
--   3. source_job_id 指向 experience_jobs，用于来源追溯与 source_text 清理判断。

ALTER TABLE "knowledge_cards" ADD COLUMN IF NOT EXISTS "source_channel" text;
--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN IF NOT EXISTS "source_ref" jsonb;
--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN IF NOT EXISTS "route_reason" text;
--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN IF NOT EXISTS "route_confidence" numeric(3, 2);
--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN IF NOT EXISTS "suggested_folder" text;
--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN IF NOT EXISTS "route_pending" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN IF NOT EXISTS "dedupe_key" text;
--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD COLUMN IF NOT EXISTS "source_job_id" uuid;
--> statement-breakpoint
UPDATE "knowledge_cards"
   SET "dedupe_key" = 'doc:' || "source_document_id"::text
 WHERE "source_document_id" IS NOT NULL
   AND "dedupe_key" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_cards_dedupe_key_unique"
  ON "knowledge_cards" ("tenant_id", "dedupe_key")
  WHERE "dedupe_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_cards_source_job_idx"
  ON "knowledge_cards" ("source_job_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE c.conname = 'knowledge_cards_source_job_id_fkey'
       AND t.relname = 'knowledge_cards'
  ) THEN
    ALTER TABLE "knowledge_cards"
      ADD CONSTRAINT "knowledge_cards_source_job_id_fkey"
      FOREIGN KEY ("source_job_id") REFERENCES "experience_jobs"("id") ON DELETE SET NULL;
  END IF;
END $$;
