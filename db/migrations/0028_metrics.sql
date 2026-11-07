-- 可观测性：聚合指标快照
--
-- 目的：Prometheus / 运维脚本需要一个只读、无明细的聚合视图；
-- 应用角色 jxf_app 受 RLS 限制，直接 count 只能看到当前部门，因此用
-- SECURITY DEFINER 函数返回跨部门聚合值（不含任何用户 / 文档明细）。

CREATE OR REPLACE FUNCTION app.metrics_snapshot()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'runs', coalesce(
      (SELECT jsonb_object_agg(s.status, s.total)
         FROM (SELECT status::text AS status, count(*)::int AS total FROM runs GROUP BY status) s),
      '{}'::jsonb
    ),
    'work_items', coalesce(
      (SELECT jsonb_object_agg(s.status, s.total)
         FROM (SELECT status::text AS status, count(*)::int AS total FROM work_items GROUP BY status) s),
      '{}'::jsonb
    ),
    'ops_tasks', coalesce(
      (SELECT jsonb_object_agg(s.status, s.total)
         FROM (SELECT status::text AS status, count(*)::int AS total FROM ops_tasks GROUP BY status) s),
      '{}'::jsonb
    ),
    'connectors', (
      SELECT jsonb_build_object(
        'total', count(*)::int,
        'healthy', count(*) filter (where health_status = 'healthy')::int,
        'degraded', count(*) filter (where health_status = 'degraded')::int,
        'down', count(*) filter (where health_status = 'down')::int,
        'unknown', count(*) filter (
          where health_status is null or health_status not in ('healthy', 'degraded', 'down')
        )::int
      )
      FROM mcp_servers
    ),
    'pipelines', (
      SELECT jsonb_build_object(
        'total', count(*)::int,
        'enabled', count(*) filter (where enabled)::int
      )
      FROM pipelines
    ),
    'pipeline_runs_open', (SELECT count(*)::int FROM pipeline_runs WHERE finished_at IS NULL),
    'audit_events', (SELECT count(*)::int FROM audit_events),
    'users', (SELECT count(*)::int FROM users)
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.metrics_snapshot() FROM public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.metrics_snapshot() TO jxf_app;
