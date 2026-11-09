-- ============================================================================
-- Auth.js 相关表的行级安全（第一阶段）
--
-- 背景：users / accounts / sessions / verification_tokens 由 Auth.js 在无用户
-- 上下文的连接上访问，必须先拆出专用角色再对 jxf_app 收权（见审计报告 SEC-01）。
-- 本文件先处理两张可以安全收紧的表：
--   - app_versions：业务只通过 app.current_app_version() 读取，直接收回写权限；
--   - user_email_identities：按「本人或可读部门成员」隔离，读写同一套判据。
-- 幂等：drop policy if exists → create policy；revoke 可重复执行。
-- ============================================================================

alter table app_versions enable row level security;

drop policy if exists app_versions_read on app_versions;
create policy app_versions_read on app_versions
  for select using (true);

-- 版本记录只由迁移容器（owner）写入，业务角色只需要读
revoke insert, update, delete on app_versions from jxf_app;

-- ---------------------------------------------------------------------------
-- user_email_identities：本人可读写；他人条目要求目标用户存在当前上下文可读
-- 部门下的在岗任用（memberships_read 会再收窄一次，不会跨子树泄露）
-- ---------------------------------------------------------------------------
alter table user_email_identities enable row level security;

drop policy if exists user_email_identities_access on user_email_identities;
create policy user_email_identities_access on user_email_identities
  for all
  using (
    tenant_id = app.current_tenant_id()
    and (
      user_id = app.current_user_id()
      or exists (
        select 1
          from memberships m
         where m.user_id = user_email_identities.user_id
           and m.status = 'active'
           and app.can_read(m.department_id)
      )
    )
  )
  with check (
    tenant_id = app.current_tenant_id()
    and (
      user_id = app.current_user_id()
      or exists (
        select 1
          from memberships m
         where m.user_id = user_email_identities.user_id
           and m.status = 'active'
           and app.can_read(m.department_id)
      )
    )
  );
