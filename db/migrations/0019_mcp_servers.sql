CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"transport" text DEFAULT 'http' NOT NULL,
	"url" text,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allowed_tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"timeout_ms" integer DEFAULT 20000 NOT NULL,
	"rate_limit_per_min" integer DEFAULT 60 NOT NULL,
	"tools_cache" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_transport_check" CHECK (transport in ('http', 'stdio'))
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_servers_tenant_idx" ON "mcp_servers" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE TABLE "mcp_server_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"status" text NOT NULL,
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_server_calls" ADD CONSTRAINT "mcp_server_calls_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_server_calls_server_idx" ON "mcp_server_calls" USING btree ("server_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mcp_server_calls_tenant_idx" ON "mcp_server_calls" USING btree ("tenant_id","created_at" DESC NULLS LAST);
