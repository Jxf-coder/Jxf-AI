-- 证据链：支持“非文档”来源（运行产物/人工粘贴）。
--
-- 旧唯一索引 (card_id, document_id, char_start, char_end) 在 document_id/char_start
-- 为 NULL 时互不相等，对运行证据完全无效；因此新增基于哈希的部分唯一索引。
-- source_hash 为空的历史切片不参与新索引，继续由旧索引兜底，避免迁移因历史
-- 重复数据失败。

ALTER TABLE "card_evidence" ADD COLUMN IF NOT EXISTS "source_kind" text;
--> statement-breakpoint
ALTER TABLE "card_evidence" ADD COLUMN IF NOT EXISTS "source_ref" jsonb;
--> statement-breakpoint
ALTER TABLE "card_evidence" ADD COLUMN IF NOT EXISTS "source_hash" text;
--> statement-breakpoint
ALTER TABLE "card_evidence" ADD COLUMN IF NOT EXISTS "quote_hash" text;
--> statement-breakpoint
ALTER TABLE "card_evidence" ADD COLUMN IF NOT EXISTS "context_excerpt" text;
--> statement-breakpoint
UPDATE "card_evidence"
   SET "source_kind" = 'chunk'
 WHERE "source_kind" IS NULL
   AND "document_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "card_evidence_source_quote_unique"
  ON "card_evidence" ("card_id", "source_kind", "source_hash", "quote_hash")
  WHERE "source_hash" IS NOT NULL;
