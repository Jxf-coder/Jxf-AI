-- P5 设置面：平台设置单行表（品牌 / 模型 Key / 审计留存）
--
-- 该表是私有化单租户配置，不按部门隔离：
--   - 读：仅 L1（写入后由 /settings 展示）；
--   - 写：仅 L1（应用层还需 platform:settings 守卫）；
--   - 不允许新增行或删除（单行约束 + 撤销 delete/insert）。
-- 启动期与登录页通过 SECURITY DEFINER 的 app.public_branding() / app.runtime_settings()
-- 读取，不绕过本策略直接查表。

alter table app_settings enable row level security;

drop policy if exists app_settings_read on app_settings;
create policy app_settings_read on app_settings
  for select using (
    app.current_access_level() = 'L1'
  );

drop policy if exists app_settings_update on app_settings;
create policy app_settings_update on app_settings
  for update using (
    app.current_access_level() = 'L1'
  ) with check (
    app.current_access_level() = 'L1'
  );

grant select, update on app_settings to jxf_app;
revoke insert, delete on app_settings from jxf_app;
