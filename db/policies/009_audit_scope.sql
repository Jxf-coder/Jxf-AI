-- ============================================================================
-- P1 · 审计日志分级可见性
--   L1：本租户全部审计
--   L2：本人操作 + 本部门及下级部门的操作
--   L3：仅本人操作
-- 说明：department_id 由写入方补全；为空的事件（如登录）只对操作者本人与 L1 可见。
-- 幂等：drop policy if exists → create policy
-- ============================================================================

drop policy if exists audit_events_read on audit_events;
create policy audit_events_read on audit_events
  for select
  using (
    tenant_id = app.current_tenant_id()
    and (
      app.current_access_level() = 'L1'
      or actor_user_id = app.current_user_id()
      or (
        app.current_access_level() = 'L2'
        and department_id is not null
        and app.can_read(department_id)
      )
    )
  );
