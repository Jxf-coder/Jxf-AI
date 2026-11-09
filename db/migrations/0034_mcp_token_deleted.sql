alter table "mcp_tokens" add column if not exists "deleted_at" timestamp with time zone;--> statement-breakpoint
create index if not exists "mcp_tokens_deleted_idx" on "mcp_tokens" ("tenant_id", "deleted_at");
