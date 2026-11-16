-- 0042 经验沉淀策略：按租户保存采集与提炼的阈值，替代散落在代码里的常量。
-- 默认值与代码常量一致（200 字起采、12000 字截断、每小时 20 条、每日 50 张卡、每 job 3 个候选）。

CREATE TABLE IF NOT EXISTS "experience_policies" (
  "tenant_id" uuid PRIMARY KEY,
  "min_source_chars" integer NOT NULL DEFAULT 200,
  "max_source_chars" integer NOT NULL DEFAULT 12000,
  "hourly_job_limit" integer NOT NULL DEFAULT 20,
  "daily_card_limit" integer NOT NULL DEFAULT 50,
  "max_candidates" integer NOT NULL DEFAULT 3,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "experience_policies_range" CHECK (
    min_source_chars BETWEEN 20 AND 2000
    AND max_source_chars BETWEEN 1000 AND 60000
    AND min_source_chars < max_source_chars
    AND hourly_job_limit BETWEEN 1 AND 500
    AND daily_card_limit BETWEEN 1 AND 1000
    AND max_candidates BETWEEN 1 AND 10
  )
);
