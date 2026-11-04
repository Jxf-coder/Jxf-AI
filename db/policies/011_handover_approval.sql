-- ============================================================================
-- 离职交接审批 · RLS
-- 本轮只有 L1 发起与审批；后续可扩展审批人列表。
-- 幂等：drop policy if exists → create policy
-- ============================================================================

alter table approval_requests enable row level security;
alter table handover_items   enable row level security;

-- ---------------------------------------------------------------------------
-- approval_requests：L1 可读写；申请人本人可读
-- ---------------------------------------------------------------------------
drop policy if exists approval_requests_read on approval_requests;
create policy approval_requests_read on approval_requests
  for select
  using (
    tenant_id = app.current_tenant_id()
    and (
      requester_id = app.current_user_id()
      or app.current_access_level() = 'L1'
    )
  );

drop policy if exists approval_requests_insert on approval_requests;
create policy approval_requests_insert on approval_requests
  for insert
  with check (
    tenant_id = app.current_tenant_id()
    and requester_id = app.current_user_id()
    and app.current_access_level() = 'L1'
  );

drop policy if exists approval_requests_update on approval_requests;
create policy approval_requests_update on approval_requests
  for update
  using (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  )
  with check (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  );

revoke delete on approval_requests from jxf_app;

-- ---------------------------------------------------------------------------
-- handover_items：与审批单同权；只有 L1 可写
-- ---------------------------------------------------------------------------
drop policy if exists handover_items_read on handover_items;
create policy handover_items_read on handover_items
  for select
  using (
    app.current_access_level() = 'L1'
    or exists (
      select 1
        from approval_requests ar
       where ar.id = handover_items.approval_id
         and ar.requester_id = app.current_user_id()
    )
  );

drop policy if exists handover_items_write on handover_items;
create policy handover_items_write on handover_items
  for all
  using (app.current_access_level() = 'L1')
  with check (app.current_access_level() = 'L1');

revoke delete on handover_items from jxf_app;
