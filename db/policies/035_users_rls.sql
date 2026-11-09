-- ============================================================================
-- SEC-01 残留 · users 行级安全
--
-- users 是单租户身份目录：审计、工作项、知识卡、MCP 令牌都要按 id 解析姓名，
-- 因此读范围是「本人 + L1 + 可读部门内仍在岗的成员」，而不是整表开放。
-- Auth.js 走 jxf_auth 且在无业务上下文下查询，必须单独放行，否则登录链路会被清空。
-- 表属主（jxf_owner）不受 RLS 影响，迁移与 SECURITY DEFINER 函数保持可用。
-- ============================================================================

alter table users enable row level security;

-- 读：本人 / L1 / 本人可读部门内的在岗成员
drop policy if exists users_app_read on users;
create policy users_app_read on users
  for select
  to jxf_app
  using (
    id = app.current_user_id()
    or app.current_access_level() = 'L1'
    or exists (
      select 1
        from memberships m
       where m.user_id = users.id
         and m.status = 'active'
         and m.tenant_id = app.current_tenant_id()
         and app.can_read(m.department_id)
    )
  );

-- 建：只有 L1/L2 能新建人员（权限点 member:manage 在应用层已校验）
drop policy if exists users_app_insert on users;
create policy users_app_insert on users
  for insert
  to jxf_app
  with check (app.current_access_level() in ('L1', 'L2'));

-- 改：本人改资料；L1 改全部，L2 只能改可读部门内的成员（L3 不能改他人）
drop policy if exists users_app_update on users;
create policy users_app_update on users
  for update
  to jxf_app
  using (
    id = app.current_user_id()
    or app.current_access_level() = 'L1'
    or (
      app.current_access_level() = 'L2'
      and exists (
        select 1
          from memberships m
         where m.user_id = users.id
           and m.status = 'active'
           and m.tenant_id = app.current_tenant_id()
           and app.can_read(m.department_id)
      )
    )
  )
  with check (
    id = app.current_user_id()
    or app.current_access_level() = 'L1'
    or (
      app.current_access_level() = 'L2'
      and exists (
        select 1
          from memberships m
         where m.user_id = users.id
           and m.status = 'active'
           and m.tenant_id = app.current_tenant_id()
           and app.can_read(m.department_id)
      )
    )
  );

-- 删：人员只做离岗（memberships.status），不允许物理删除；不建策略即默认拒绝
revoke delete on users from jxf_app;

-- Auth.js 适配器：jxf_auth 只碰认证相关表，需原样读写
drop policy if exists users_auth_all on users;
create policy users_auth_all on users
  for all
  to jxf_auth
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- 跨范围只读/写入所需的 SECURITY DEFINER 入口
-- 业务查询受 RLS 限制后，登录状态与唯一性探测仍需在无上下文或跨部门下工作。
-- ---------------------------------------------------------------------------

-- 会话校验：requireSession() 在建立用户上下文之前查询账号状态
create or replace function app.user_status(p_user_id uuid) returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select u.status from users u where u.id = p_user_id
$fn$;

-- 手机号/邮箱唯一性探测：目标用户可能不在当前可读部门内
create or replace function app.user_id_by_phone(p_phone text) returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select u.id from users u where u.phone = p_phone limit 1
$fn$;

create or replace function app.user_id_by_email(p_email text) returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select u.id from users u
   where lower(u.email) = lower(p_email)
   limit 1
$fn$;

-- 新增成员时的「按手机号复用/更新既有人员」：写入在 RLS 生效前完成
create or replace function app.ensure_user(
  p_name text,
  p_phone text,
  p_email text,
  p_birthday date
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id uuid;
begin
  select u.id into v_id from users u where u.phone = p_phone limit 1;

  if v_id is null then
    insert into users (name, phone, email, birthday)
    values (p_name, p_phone, p_email, p_birthday)
    returning id into v_id;
  else
    update users
       set name = p_name,
           birthday = coalesce(p_birthday, birthday)
     where id = v_id;
  end if;

  return v_id;
end
$fn$;

revoke all on function app.user_status(uuid) from public;
revoke all on function app.user_id_by_phone(text) from public;
revoke all on function app.user_id_by_email(text) from public;
revoke all on function app.ensure_user(text, text, text, date) from public;

grant execute on function app.user_status(uuid) to jxf_app;
grant execute on function app.user_id_by_phone(text) to jxf_app;
grant execute on function app.user_id_by_email(text) to jxf_app;
grant execute on function app.ensure_user(text, text, text, date) to jxf_app;
