CREATE TABLE IF NOT EXISTS "app_versions" (
	"version" text PRIMARY KEY NOT NULL,
	"git_sha" text,
	"first_applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.current_app_version()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'version', v.version,
    'git_sha', v.git_sha,
    'applied_at', v.last_applied_at,
    'notes', v.notes
  )
  FROM app_versions v
  ORDER BY v.last_applied_at DESC
  LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.current_app_version() FROM public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_app_version() TO jxf_app;
