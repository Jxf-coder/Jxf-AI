ALTER TABLE "qa_logs" ALTER COLUMN "invalid_cites" SET DATA TYPE text[];--> statement-breakpoint
ALTER TABLE "qa_logs" ALTER COLUMN "invalid_cites" SET DEFAULT '{}'::text[];