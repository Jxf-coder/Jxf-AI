-- ============================================================================
-- jxf_auth 专用角色与最小授权（第二阶段）
--
-- 角色本身必须由超级用户创建（jxf_owner 无 CREATEROLE）：
--   - 新库：docker/postgres/00-init.sh 在 initdb 阶段创建；
--   - 旧库：按 db/ops/auth-role-cutover.sql 的第 1 步人工创建。
--
-- 本文件只做两件事，且幂等：
--   1. 提供「仅本人上下文可读」的口令哈希函数，为后续列级收权做准备；
--   2. jxf_auth 已存在时，授予 Auth.js 所需的最小 DML 与函数执行权限。
-- 对 jxf_app 的收权不在这里执行（否则未配置 AUTH_DATABASE_URL 的部署会直接
-- 失去登录能力），见 db/ops/auth-role-cutover.sql 第 3 步。
-- ============================================================================

create or replace function app.current_password_hash(p_user_id uuid) returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select u.password_hash
    from users u
   where u.id = p_user_id
     and p_user_id = app.current_user_id()
$fn$;

revoke all on function app.current_password_hash(uuid) from public;
grant execute on function app.current_password_hash(uuid) to jxf_app;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'jxf_auth') then
    raise notice 'jxf_auth 不存在：跳过授权（新库由 00-init.sh 创建，旧库见 db/ops/auth-role-cutover.sql）';
    return;
  end if;

  execute format('grant connect on database %I to jxf_auth', current_database());
  grant usage on schema public to jxf_auth;
  -- 登录链路调用的函数位于 app schema，EXECUTE 之外还需要 schema USAGE
  grant usage on schema app to jxf_auth;
  grant select, insert, update, delete
     on users, accounts, sessions, verification_tokens
     to jxf_auth;
  -- 登录链路还会校验有效任用；函数已 revoke from public，必须显式授权
  grant execute on function app.user_department_ids(uuid) to jxf_auth;
end
$$;
