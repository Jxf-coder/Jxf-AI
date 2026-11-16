-- 039 经验沉淀策略：读取函数对业务角色与 worker 开放，写入只给 L1。
-- 为什么要函数读取：采集在 web（jxf_app）、提炼在 worker（app_worker），两边都要同一份策略，
-- 直接查表会各自被 RLS 挡住；函数内部固定用当前租户上下文，避免跨租户读到别人的阈值。

alter table public.experience_policies enable row level security;

drop policy if exists experience_policies_read on public.experience_policies;
create policy experience_policies_read on public.experience_policies
  for select
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  );

revoke insert, update, delete, truncate on public.experience_policies from jxf_app;
grant select on public.experience_policies to jxf_app;

-- 读取当前租户策略；没有配置行或没有租户上下文时返回代码默认值，调用方不必判空。
-- 返回类型可能已被 040 扩展；策略每次启动都会重放，先删再建避免 return type 冲突。
drop function if exists app.experience_policy();
create or replace function app.experience_policy()
returns table (
  min_source_chars integer,
  max_source_chars integer,
  hourly_job_limit integer,
  daily_card_limit integer,
  max_candidates integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with current_tenant as (
    select app.current_tenant_id() as tenant_id
  )
  select
    coalesce(p.min_source_chars, 200),
    coalesce(p.max_source_chars, 12000),
    coalesce(p.hourly_job_limit, 20),
    coalesce(p.daily_card_limit, 50),
    coalesce(p.max_candidates, 3)
  from current_tenant t
  left join experience_policies p on p.tenant_id = t.tenant_id
$fn$;

revoke all on function app.experience_policy() from public;
grant execute on function app.experience_policy() to jxf_app;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'app_worker') then
    execute 'grant execute on function app.experience_policy() to app_worker';
  end if;
end $$;

-- 保存策略：仅 L1；范围与 min<max 由表约束再兜一次，函数内先给出可读报错。
create or replace function app.save_experience_policy(
  p_min_source_chars integer,
  p_max_source_chars integer,
  p_hourly_job_limit integer,
  p_daily_card_limit integer,
  p_max_candidates integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tenant uuid := app.current_tenant_id();
begin
  if v_tenant is null then
    raise exception '缺少租户上下文' using errcode = '42501';
  end if;
  if app.current_access_level() is distinct from 'L1' then
    raise exception '只有 L1 可以修改经验沉淀策略' using errcode = '42501';
  end if;
  if p_min_source_chars is null
     or p_max_source_chars is null
     or p_hourly_job_limit is null
     or p_daily_card_limit is null
     or p_max_candidates is null then
    raise exception '策略参数不能为空' using errcode = '22023';
  end if;

  insert into experience_policies (
    tenant_id, min_source_chars, max_source_chars, hourly_job_limit,
    daily_card_limit, max_candidates, updated_by, updated_at
  )
  values (
    v_tenant, p_min_source_chars, p_max_source_chars, p_hourly_job_limit,
    p_daily_card_limit, p_max_candidates, app.current_user_id(), now()
  )
  on conflict (tenant_id) do update
    set min_source_chars = excluded.min_source_chars,
        max_source_chars = excluded.max_source_chars,
        hourly_job_limit = excluded.hourly_job_limit,
        daily_card_limit = excluded.daily_card_limit,
        max_candidates = excluded.max_candidates,
        updated_by = excluded.updated_by,
        updated_at = now();
end;
$fn$;

revoke all on function app.save_experience_policy(integer, integer, integer, integer, integer) from public;
grant execute on function app.save_experience_policy(integer, integer, integer, integer, integer) to jxf_app;
