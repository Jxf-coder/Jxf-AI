-- ============================================================================
-- P1 · audit_events：insert-only
-- 只允许当前租户内插入；只有 L1 可读；UPDATE / DELETE / TRUNCATE 直接撤销授权。
-- ============================================================================

drop policy if exists audit_events_insert on audit_events;
create policy audit_events_insert on audit_events
  for insert
  with check (tenant_id = app.current_tenant_id());

drop policy if exists audit_events_read on audit_events;
create policy audit_events_read on audit_events
  for select
  using (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
  );

revoke update, delete, truncate on audit_events from jxf_app;
