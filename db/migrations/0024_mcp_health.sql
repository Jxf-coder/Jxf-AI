ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "health_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "health_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "health_latency_ms" integer;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "health_consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "health_last_error" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "health_alerted_at" timestamp with time zone;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_servers_health_status'
  ) THEN
    ALTER TABLE "mcp_servers"
      ADD CONSTRAINT "mcp_servers_health_status"
      CHECK (health_status in ('unknown', 'healthy', 'degraded', 'down'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_servers_health_idx"
  ON "mcp_servers" USING btree ("tenant_id", "health_status");
