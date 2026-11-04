-- ============================================================================
-- P1 · 移出成员前的“运行中工作 / 资产”预检
-- 当前数据模型只有组织架构，尚未落地 M2 assets 与 M3 runs；
-- 这里用 to_regclass + 列存在性做前置判断：
--   · 表未建立时计数为 0，移出流程不受影响；
--   · 表建立后自动按归属人统计，无需再改移出逻辑。
-- 幂等：create or replace，可重复执行
-- ============================================================================

create or replace function app.membership_blockers(p_membership_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_department_id uuid;
  v_user_id uuid;
  v_open_work bigint := 0;
  v_assets bigint := 0;
begin
  if coalesce(app.current_access_level(), '') <> 'L1' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  select m.department_id, m.user_id
    into v_department_id, v_user_id
    from memberships m
   where m.id = p_membership_id
     and m.status = 'active';

  if not found then
    raise exception 'membership not found' using errcode = 'P0002';
  end if;

  if not app.can_read(v_department_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  -- M3 运行态：排队与执行中的任务
  if to_regclass('public.runs') is not null
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'runs' and column_name = 'principal_id'
     ) then
    execute $q$
      select count(*) from runs
       where principal_id = $1
         and status::text in ('queued', 'running')
    $q$ into v_open_work using v_user_id;
  end if;

  -- M2 知识资产：该成员创建的资产
  if to_regclass('public.assets') is not null
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'assets' and column_name = 'created_by'
     ) then
    execute 'select count(*) from assets where created_by = $1'
      into v_assets using v_user_id;
  end if;

  return jsonb_build_object('open_work', v_open_work, 'assets', v_assets);
end
$fn$;

revoke all on function app.membership_blockers(uuid) from public;
grant execute on function app.membership_blockers(uuid) to jxf_app;
