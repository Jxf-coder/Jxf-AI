-- 0043 经验策略扩展：补齐冷却窗、最小信号等级、成功自动沉淀、模型档位与部门/通道开关。
-- 默认值保持与旧代码常量一致（冷却 60 分钟、去重窗 24 小时、信号等级 1、不采成功、fast 模型）。

ALTER TABLE "experience_policies"
  ADD COLUMN IF NOT EXISTS "cooldown_minutes" integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS "dedupe_window_hours" integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS "min_signal_level" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "auto_capture_success" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "model_tier" text NOT NULL DEFAULT 'fast';
--> statement-breakpoint
-- 新列的范围约束单独命名；用 DO 包裹保证策略重放幂等
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'experience_policies_window_range'
  ) THEN
    ALTER TABLE "experience_policies"
      ADD CONSTRAINT "experience_policies_window_range" CHECK (
        cooldown_minutes BETWEEN 1 AND 1440
        AND dedupe_window_hours BETWEEN 1 AND 168
        AND min_signal_level BETWEEN 1 AND 3
        AND model_tier IN ('fast', 'pro')
      );
  END IF;
END $$;
--> statement-breakpoint
-- 部门 × 通道开关：没有行时视为启用，避免新增部门要逐条补配置
CREATE TABLE IF NOT EXISTS "experience_channel_policies" (
  "tenant_id" uuid NOT NULL,
  "department_id" uuid NOT NULL REFERENCES "departments"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "department_id", "channel"),
  CONSTRAINT "experience_channel_policies_channel" CHECK (
    channel IN ('document', 'skill', 'pipeline', 'review', 'retro', 'connector', 'manual')
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experience_channel_policies_tenant_idx"
  ON "experience_channel_policies" ("tenant_id", "department_id");
