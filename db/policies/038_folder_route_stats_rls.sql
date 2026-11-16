-- 038 目录纠偏统计：聚合行的重算函数与只读策略。
-- 聚合行是跨部门统计，只对 L1 可见；写入只走 SECURITY DEFINER 的重算函数，业务角色不能直接改。

alter table public.folder_route_stats_daily enable row level security;

drop policy if exists folder_route_stats_read on public.folder_route_stats_daily;
create policy folder_route_stats_read on public.folder_route_stats_daily
  for select
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  );

revoke insert, update, delete, truncate on public.folder_route_stats_daily from jxf_app;
grant select on public.folder_route_stats_daily to jxf_app;

-- 重算最近 p_days 天的聚合：按租户、天、通道、动作、建议目录与最终目录汇总。
-- 同一批数据重复重算只会覆盖 total，不产生重复行（依赖唯一索引 + NULLS NOT DISTINCT）。
create or replace function app.rollup_folder_route_stats(p_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tenant uuid := app.current_tenant_id();
  v_rows integer := 0;
begin
  if v_tenant is null then
    raise exception '缺少租户上下文' using errcode = '42501';
  end if;
  if app.current_access_level() is distinct from 'L1' then
    raise exception '只有 L1 可以重算目录纠偏统计' using errcode = '42501';
  end if;
  if p_days is null or p_days < 1 or p_days > 3650 then
    raise exception '统计天数必须在 1 到 3650 之间' using errcode = '22023';
  end if;

  insert into folder_route_stats_daily (
    tenant_id, day, channel, action, suggested_folder, chosen_folder, total
  )
  select
    f.tenant_id,
    f.created_at::date as day,
    f.channel,
    f.action,
    f.suggested_folder,
    f.chosen_folder,
    count(*)::integer as total
  from folder_route_feedback f
  where f.tenant_id = v_tenant
    and f.created_at >= current_date - make_interval(days => p_days)
  group by 1, 2, 3, 4, 5, 6
  on conflict (
    tenant_id, day, channel, action, suggested_folder, chosen_folder
  ) do update
    set total = excluded.total,
        updated_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$fn$;

revoke all on function app.rollup_folder_route_stats(integer) from public;
grant execute on function app.rollup_folder_route_stats(integer) to jxf_app;
