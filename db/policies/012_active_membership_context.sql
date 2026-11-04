-- ============================================================================
-- P3 · 单部门上下文与作用域函数
-- 目的：
--   · 请求入口只解析「当前任用」，不再把用户所有部门合并
--   · RLS 的 department_ids 只写当前部门（L1 写全租户，保持上帝视角）
--   · 子树由 SECURITY DEFINER 函数计算，策略内不做递归
-- 幂等：create or replace
-- ============================================================================

-- 当前用户的全部有效任用（含部门名与等级），供上下文选择与部门切换器使用
create or replace function app.user_active_memberships(p_user_id uuid)
returns table (
  membership_id uuid,
  department_id uuid,
  department_name text,
  level_text text,
  title text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select m.id,
         m.department_id,
         d.name,
         m.access_level::text,
         m.title,
         m.created_at
    from memberships m
    join departments d on d.id = m.department_id
   where m.user_id = p_user_id
     and m.status = 'active'
   order by m.created_at, m.id
$fn$;

-- 某部门的子树（含自身）
create or replace function app.department_subtree_ids(p_department_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(array_agg(dc.descendant_id order by dc.depth), '{}'::uuid[])
    from department_closure dc
   where dc.ancestor_id = p_department_id
$fn$;

-- 全租户部门（仅 L1 上下文使用）
create or replace function app.tenant_department_ids(p_tenant_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(array_agg(d.id order by d.created_at), '{}'::uuid[])
    from departments d
   where d.tenant_id = p_tenant_id
$fn$;

-- 权限版本号：用于缓存失效与前端快照
create or replace function app.user_permission_version(p_user_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
    (select version from permission_revisions where user_id = p_user_id),
    0
  )
$fn$;

-- 是否还有有效任用（登录校验用）
create or replace function app.has_active_membership(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from memberships m
     where m.user_id = p_user_id
       and m.status = 'active'
  )
$fn$;

-- 账号是否允许登录：账号状态 active 且至少一条有效任用
create or replace function app.user_can_login(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1 from users u
     where u.id = p_user_id
       and u.status = 'active'
  )
  and app.has_active_membership(p_user_id)
$fn$;

-- 请求上下文辅助读取
create or replace function app.current_active_department_id() returns uuid
language sql
stable
as $fn$
  select nullif(current_setting('app.active_department_id', true), '')::uuid
$fn$;

create or replace function app.current_membership_id() returns uuid
language sql
stable
as $fn$
  select nullif(current_setting('app.membership_id', true), '')::uuid
$fn$;

revoke all on function app.user_active_memberships(uuid) from public;
revoke all on function app.department_subtree_ids(uuid) from public;
revoke all on function app.tenant_department_ids(uuid) from public;
revoke all on function app.user_permission_version(uuid) from public;
revoke all on function app.has_active_membership(uuid) from public;
revoke all on function app.user_can_login(uuid) from public;
revoke all on function app.current_active_department_id() from public;
revoke all on function app.current_membership_id() from public;

grant execute on function app.user_active_memberships(uuid) to jxf_app;
grant execute on function app.department_subtree_ids(uuid) to jxf_app;
grant execute on function app.tenant_department_ids(uuid) to jxf_app;
grant execute on function app.user_permission_version(uuid) to jxf_app;
grant execute on function app.has_active_membership(uuid) to jxf_app;
grant execute on function app.user_can_login(uuid) to jxf_app;
grant execute on function app.current_active_department_id() to jxf_app;
grant execute on function app.current_membership_id() to jxf_app;
