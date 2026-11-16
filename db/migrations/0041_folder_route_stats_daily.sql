-- 0041 目录路由纠偏日聚合：把 folder_route_feedback 按天汇总，供统计页判断路由准不准。
-- 为什么要聚合表而不是每次现算：feedback 会持续增长，页面按天读聚合行既稳定又不扫全表。

CREATE TABLE IF NOT EXISTS "folder_route_stats_daily" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "day" date NOT NULL,
  "channel" text NOT NULL,
  "action" text NOT NULL,
  "suggested_folder" text,
  "chosen_folder" text NOT NULL,
  "total" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "folder_route_stats_daily_total" CHECK ("total" >= 0)
);
--> statement-breakpoint
-- suggested_folder 允许为空（当时没有建议目录），因此唯一索引必须把 NULL 当作同一个值
CREATE UNIQUE INDEX IF NOT EXISTS "folder_route_stats_daily_key"
  ON "folder_route_stats_daily" (
    "tenant_id", "day", "channel", "action", "suggested_folder", "chosen_folder"
  ) NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "folder_route_stats_daily_tenant_day_idx"
  ON "folder_route_stats_daily" ("tenant_id", "day" DESC);
