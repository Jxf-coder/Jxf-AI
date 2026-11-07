-- 自动化产线切片 2：定时触发 + 链式推进 + 可选步骤
--
-- 设计：
-- - 产线原来一次性派出全部步骤，无法引用上一步产物；
-- - 现在改为「派第一步 → 上一步结束后再派下一步」，由宿主机 runner 推进；
-- - next_step_index 为下一个待派步骤的下标（已派出 steps[0..next_step_index-1]）；
-- - trigger_kind 区分手动 / 定时；skipped_steps 记录因失败被跳过的可选步骤。

alter table "pipelines" add column if not exists "schedule_interval_minutes" integer;
--> statement-breakpoint
alter table "pipelines" add column if not exists "last_scheduled_at" timestamp with time zone;
--> statement-breakpoint
alter table "pipeline_runs" add column if not exists "trigger_kind" text not null default 'manual';
--> statement-breakpoint
alter table "pipeline_runs" add column if not exists "next_step_index" integer not null default 0;
--> statement-breakpoint
alter table "pipeline_runs" add column if not exists "skipped_steps" text[] not null default '{}'::text[];
--> statement-breakpoint
alter table "pipeline_runs" add column if not exists "finished_at" timestamp with time zone;
--> statement-breakpoint
-- 历史数据：旧运行记录已一次性派出全部步骤，直接推进到末尾，避免被 runner 重复派活
update "pipeline_runs"
   set "next_step_index" = coalesce(array_length("work_item_ids", 1), 0)
 where "next_step_index" = 0 and coalesce(array_length("work_item_ids", 1), 0) > 0;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pipelines_schedule_interval_range'
  ) THEN
    ALTER TABLE "pipelines"
      ADD CONSTRAINT "pipelines_schedule_interval_range"
      CHECK ("schedule_interval_minutes" is null
             or "schedule_interval_minutes" between 5 and 10080);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_runs_trigger_kind_valid'
  ) THEN
    ALTER TABLE "pipeline_runs"
      ADD CONSTRAINT "pipeline_runs_trigger_kind_valid"
      CHECK ("trigger_kind" in ('manual', 'schedule'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_runs_next_step_index_nonnegative'
  ) THEN
    ALTER TABLE "pipeline_runs"
      ADD CONSTRAINT "pipeline_runs_next_step_index_nonnegative"
      CHECK ("next_step_index" >= 0);
  END IF;
END $$;
--> statement-breakpoint
create index if not exists "pipelines_schedule_idx"
  on "pipelines" ("tenant_id", "schedule_interval_minutes")
  where "enabled" and "schedule_interval_minutes" is not null;
--> statement-breakpoint
create index if not exists "pipeline_runs_pending_idx"
  on "pipeline_runs" ("created_at")
  where "finished_at" is null;
