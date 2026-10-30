-- ============================================================================
-- P1 · 身份上下文与授权函数（部门模型）
-- 幂等：全部使用 create or replace；每次 migrate 重放安全
-- ============================================================================

create schema if not exists app;

-- 请求入口注入的上下文；未注入时返回 null / 空数组（fail-closed）
create or replace function app.current_user_id() returns uuid
language sql
stable
as $fn$
  select nullif(current_setting('app.user_id', true), '')::uuid
$fn$;

create or replace function app.current_tenant_id() returns uuid
language sql
stable
as $fn$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$fn$;

create or replace function app.current_access_level() returns text
language sql
stable
as $fn$
  select nullif(current_setting('app.access_level', true), '')
$fn$;

create or replace function app.my_department_ids() returns uuid[]
language sql
stable
as $fn$
  select coalesce(nullif(current_setting('app.department_ids', true), '')::uuid[], '{}'::uuid[])
$fn$;

-- 请求入口只调用这两个函数一次，把结果写入 SET LOCAL，策略里不再 join memberships
create or replace function app.user_department_ids(p_user_id uuid) returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(array_agg(m.department_id order by m.department_id), '{}'::uuid[])
    from memberships m
   where m.user_id = p_user_id
     and m.status = 'active'
$fn$;

-- L1 > L2 > L3；无有效任用返回 null
create or replace function app.effective_access_level(p_user_id uuid) returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
           when exists (select 1 from memberships m
                         where m.user_id = p_user_id and m.status = 'active' and m.access_level = 'L1') then 'L1'
           when exists (select 1 from memberships m
                         where m.user_id = p_user_id and m.status = 'active' and m.access_level = 'L2') then 'L2'
           when exists (select 1 from memberships m
                         where m.user_id = p_user_id and m.status = 'active' and m.access_level = 'L3') then 'L3'
           else null
         end
$fn$;

-- 读：自身部门 + 全部子部门（SECURITY DEFINER 读闭包，避免策略递归）
create or replace function app.can_read(p_department_id uuid) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from department_closure dc
     where dc.descendant_id = p_department_id
       and dc.ancestor_id = any (app.my_department_ids())
  )
$fn$;

-- 写：仅自身部门（不向上/向旁扩权）
create or replace function app.can_write(p_department_id uuid) returns boolean
language sql
stable
as $fn$
  select p_department_id = any (app.my_department_ids())
$fn$;

-- 离岗：必须保留至少一个 L1；只允许 L1 在可读子树内操作
create or replace function app.remove_membership(p_membership_id uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_department_id uuid;
  v_level access_level;
  v_tenant_id uuid;
begin
  if coalesce(app.current_access_level(), '') <> 'L1' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  select m.department_id, m.access_level, m.tenant_id
    into v_department_id, v_level, v_tenant_id
    from memberships m
   where m.id = p_membership_id
     and m.status = 'active'
   for update;

  if not found then
    raise exception 'membership not found' using errcode = 'P0002';
  end if;

  if not app.can_read(v_department_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  if v_level = 'L1' then
    if not exists (
      select 1 from memberships m
       where m.tenant_id = v_tenant_id
         and m.status = 'active'
         and m.access_level = 'L1'
         and m.id <> p_membership_id
    ) then
      raise exception 'cannot remove the last L1' using errcode = '23514';
    end if;
  end if;

  update memberships
     set status = 'removed', removed_at = now()
   where id = p_membership_id;
end
$fn$;

-- ---------------------------------------------------------------------------
-- 清理旧「岗位（role）」模型遗留函数，避免概念债
-- ---------------------------------------------------------------------------
drop function if exists app.my_role_ids();
drop function if exists app.user_role_ids(uuid);

-- ---------------------------------------------------------------------------
-- 权限：业务角色只能执行显式授权函数
-- ---------------------------------------------------------------------------
grant usage on schema app to jxf_app;

revoke all on function app.current_user_id() from public;
revoke all on function app.current_tenant_id() from public;
revoke all on function app.current_access_level() from public;
revoke all on function app.my_department_ids() from public;
revoke all on function app.user_department_ids(uuid) from public;
revoke all on function app.effective_access_level(uuid) from public;
revoke all on function app.can_read(uuid) from public;
revoke all on function app.can_write(uuid) from public;
revoke all on function app.remove_membership(uuid) from public;

grant execute on function app.current_user_id() to jxf_app;
grant execute on function app.current_tenant_id() to jxf_app;
grant execute on function app.current_access_level() to jxf_app;
grant execute on function app.my_department_ids() to jxf_app;
grant execute on function app.user_department_ids(uuid) to jxf_app;
grant execute on function app.effective_access_level(uuid) to jxf_app;
grant execute on function app.can_read(uuid) to jxf_app;
grant execute on function app.can_write(uuid) to jxf_app;
grant execute on function app.remove_membership(uuid) to jxf_app;
