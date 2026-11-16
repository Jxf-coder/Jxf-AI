-- 040 经验策略扩展：读取函数扩展为 10 项阈值，并新增部门/通道开关函数。
-- 返回类型变化后 CREATE OR REPLACE 不兼容，必须先 drop 再建；策略文件按序重放仍然幂等。

alter table public.experience_channel_policies enable row level security;

drop policy if exists experience_channel_policies_read on public.experience_channel_policies;
create policy experience_channel_policies_read on public.experience_channel_policies
  for select
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  );

revoke insert, update, delete, truncate on public.experience_channel_policies from jxf_app;
grant select on public.experience_channel_policies to jxf_app;

drop function if exists app.experience_policy();
create function app.experience_policy()
returns table (
  min_source_chars integer,
  max_source_chars integer,
  hourly_job_limit integer,
  daily_card_limit integer,
  max_candidates integer,
  cooldown_minutes integer,
  dedupe_window_hours integer,
  min_signal_level integer,
  auto_capture_success boolean,
  model_tier text
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
    coalesce(p.max_candidates, 3),
    coalesce(p.cooldown_minutes, 60),
    coalesce(p.dedupe_window_hours, 24),
    coalesce(p.min_signal_level, 1),
    coalesce(p.auto_capture_success, false),
    coalesce(p.model_tier, 'fast')
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

drop function if exists app.save_experience_policy(integer, integer, integer, integer, integer);
drop function if exists app.save_experience_policy(integer, integer, integer, integer, integer, integer, integer, integer, boolean, text);
create or replace function app.save_experience_policy(
  p_min_source_chars integer,
  p_max_source_chars integer,
  p_hourly_job_limit integer,
  p_daily_card_limit integer,
  p_max_candidates integer,
  p_cooldown_minutes integer,
  p_dedupe_window_hours integer,
  p_min_signal_level integer,
  p_auto_capture_success boolean,
  p_model_tier text
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
     or p_max_candidates is null
     or p_cooldown_minutes is null
     or p_dedupe_window_hours is null
     or p_min_signal_level is null
     or p_auto_capture_success is null
     or p_model_tier is null then
    raise exception '策略参数不能为空' using errcode = '22023';
  end if;

  insert into experience_policies (
    tenant_id, min_source_chars, max_source_chars, hourly_job_limit,
    daily_card_limit, max_candidates, cooldown_minutes, dedupe_window_hours,
    min_signal_level, auto_capture_success, model_tier, updated_by, updated_at
  )
  values (
    v_tenant, p_min_source_chars, p_max_source_chars, p_hourly_job_limit,
    p_daily_card_limit, p_max_candidates, p_cooldown_minutes, p_dedupe_window_hours,
    p_min_signal_level, p_auto_capture_success, p_model_tier, app.current_user_id(), now()
  )
  on conflict (tenant_id) do update
    set min_source_chars = excluded.min_source_chars,
        max_source_chars = excluded.max_source_chars,
        hourly_job_limit = excluded.hourly_job_limit,
        daily_card_limit = excluded.daily_card_limit,
        max_candidates = excluded.max_candidates,
        cooldown_minutes = excluded.cooldown_minutes,
        dedupe_window_hours = excluded.dedupe_window_hours,
        min_signal_level = excluded.min_signal_level,
        auto_capture_success = excluded.auto_capture_success,
        model_tier = excluded.model_tier,
        updated_by = excluded.updated_by,
        updated_at = now();
end;
$fn$;

revoke all on function app.save_experience_policy(integer, integer, integer, integer, integer, integer, integer, integer, boolean, text) from public;
grant execute on function app.save_experience_policy(integer, integer, integer, integer, integer, integer, integer, integer, boolean, text) to jxf_app;

-- 部门 × 通道是否启用：无配置行视为 true，采集侧调用一次即可。
create or replace function app.experience_channel_enabled(
  p_department_id uuid,
  p_channel text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce((
    select p.enabled
      from experience_channel_policies p
     where p.tenant_id = app.current_tenant_id()
       and p.department_id = p_department_id
       and p.channel = p_channel
  ), true)
$fn$;

revoke all on function app.experience_channel_enabled(uuid, text) from public;
grant execute on function app.experience_channel_enabled(uuid, text) to jxf_app;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'app_worker') then
    execute 'grant execute on function app.experience_channel_enabled(uuid, text) to app_worker';
  end if;
end $$;

-- 保存部门 × 通道开关（仅 L1）；先校部门属于当前租户，再 upsert。
create or replace function app.save_experience_channel_policy(
  p_department_id uuid,
  p_channel text,
  p_enabled boolean
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
    raise exception '只有 L1 可以修改经验采集开关' using errcode = '42501';
  end if;
  if p_channel not in ('document', 'skill', 'pipeline', 'review', 'retro', 'connector', 'manual') then
    raise exception '未知的经验通道：%', p_channel using errcode = '22023';
  end if;
  if not exists (
    select 1 from departments d where d.id = p_department_id and d.tenant_id = v_tenant
  ) then
    raise exception '部门不存在或不属于当前租户' using errcode = '22023';
  end if;

  insert into experience_channel_policies (
    tenant_id, department_id, channel, enabled, updated_by, updated_at
  )
  values (v_tenant, p_department_id, p_channel, p_enabled, app.current_user_id(), now())
  on conflict (tenant_id, department_id, channel) do update
    set enabled = excluded.enabled,
        updated_by = excluded.updated_by,
        updated_at = now();
end;
$fn$;

revoke all on function app.save_experience_channel_policy(uuid, text, boolean) from public;
grant execute on function app.save_experience_channel_policy(uuid, text, boolean) to jxf_app;
