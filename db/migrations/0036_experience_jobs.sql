-- 经验采集队列与目录纠偏样本。
--
-- 设计约束：
--   1. 采集层只写队列，不做 LLM；提炼由 worker 异步完成；
--   2. 去重依赖唯一索引，不依赖“先查后插”；
--   3. source_id 必须非空，否则唯一索引含 NULL 会失去去重能力；
--   4. source_text 只存去敏并截断后的文本（≤12000 字符），90 天后清理；
--   5. RLS 与授权在 db/policies 中单独维护，本迁移只建表与索引。

CREATE TABLE IF NOT EXISTS "experience_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "department_id" uuid NOT NULL REFERENCES "departments"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "source_type" text NOT NULL,
  "source_id" uuid NOT NULL,
  "source_version" text NOT NULL,
  "cooldown_bucket" text NOT NULL,
  "fingerprint" text,
  "occurrence_count" integer DEFAULT 1 NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cooldown_until" timestamp with time zone,
  "merged_into_job_id" uuid,
  "related_job_id" uuid,
  "source_text" text,
  "source_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "not_before" timestamp with time zone,
  "attempts" integer DEFAULT 0 NOT NULL,
  "error" text,
  "result_card_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "worker_id" text,
  "lease_until" timestamp with time zone,
  "heartbeat_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  CONSTRAINT "experience_jobs_status" CHECK ("status" in ('queued', 'running', 'done', 'failed', 'skipped', 'dead')),
  CONSTRAINT "experience_jobs_channel" CHECK ("channel" in ('document', 'skill', 'pipeline', 'review', 'retro', 'connector', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experience_jobs_source_unique"
  ON "experience_jobs" ("tenant_id", "channel", "source_type", "source_id", "source_version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experience_jobs_fingerprint_bucket_unique"
  ON "experience_jobs" ("tenant_id", "fingerprint", "cooldown_bucket")
  WHERE "fingerprint" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_jobs_dedupe_idx"
  ON "experience_jobs" ("tenant_id", "department_id", "fingerprint", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_jobs_claim_idx"
  ON "experience_jobs" ("status", "not_before", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_jobs_tenant_idx"
  ON "experience_jobs" ("tenant_id", "created_at" DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "folder_route_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "department_id" uuid NOT NULL REFERENCES "departments"("id") ON DELETE CASCADE,
  "card_id" uuid NOT NULL,
  "job_id" uuid,
  "channel" text NOT NULL,
  "kind" text,
  "action" text NOT NULL,
  "suggested_folder" text,
  "chosen_folder" text,
  "route_confidence" numeric(3, 2),
  "route_reason" text,
  "route_pending" boolean DEFAULT false NOT NULL,
  "features" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "folder_route_feedback_action" CHECK ("action" in ('accepted', 'overridden', 'pending_resolved'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folder_route_feedback_card_idx"
  ON "folder_route_feedback" ("card_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folder_route_feedback_stats_idx"
  ON "folder_route_feedback" ("tenant_id", "department_id", "channel", "created_at" DESC);
