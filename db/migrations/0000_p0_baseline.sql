-- ---------------------------------------------------------------------------
-- P0 基线迁移：不创建任何业务表，只做扩展可用性断言（fail-closed）。
-- 扩展由自建 PG 镜像的 initdb 脚本创建；本迁移保证迁移链路能真实跑通，
-- 并让「重复执行 up」可验证幂等（drizzle 会跳过已应用迁移）。
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'pgvector (vector) extension is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_bigm') THEN
    RAISE EXCEPTION 'pg_bigm extension is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION 'pg_trgm extension is missing';
  END IF;
END
$$;
