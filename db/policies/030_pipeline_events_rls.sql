-- 产线事件订阅与事件总线的行级安全
--
-- subscriptions：跟随产线可见性（pipelines 的 RLS 决定 can_read），
--   应用层再用 pipeline:manage 守卫写操作；
-- events：只读给 L1，写入统一走 app.publish_event()（SECURITY DEFINER），
--   应用角色不能直接 insert / update / delete，runner（owner）负责派发与收口。

alter table pipeline_event_subscriptions enable row level security;
alter table pipeline_events enable row level security;

drop policy if exists pipeline_event_subscriptions_read on pipeline_event_subscriptions;
create policy pipeline_event_subscriptions_read on pipeline_event_subscriptions
  for select using (
    tenant_id = app.current_tenant_id()
    and exists (select 1 from pipelines p where p.id = pipeline_id)
  );

drop policy if exists pipeline_event_subscriptions_insert on pipeline_event_subscriptions;
create policy pipeline_event_subscriptions_insert on pipeline_event_subscriptions
  for insert with check (
    tenant_id = app.current_tenant_id()
    and created_by = app.current_user_id()
    and exists (select 1 from pipelines p where p.id = pipeline_id and p.enabled)
  );

drop policy if exists pipeline_event_subscriptions_update on pipeline_event_subscriptions;
create policy pipeline_event_subscriptions_update on pipeline_event_subscriptions
  for update using (
    tenant_id = app.current_tenant_id()
    and exists (select 1 from pipelines p where p.id = pipeline_id)
  ) with check (
    tenant_id = app.current_tenant_id()
    and exists (select 1 from pipelines p where p.id = pipeline_id)
  );

drop policy if exists pipeline_event_subscriptions_delete on pipeline_event_subscriptions;
create policy pipeline_event_subscriptions_delete on pipeline_event_subscriptions
  for delete using (
    tenant_id = app.current_tenant_id()
    and exists (select 1 from pipelines p where p.id = pipeline_id)
  );

drop policy if exists pipeline_events_read on pipeline_events;
create policy pipeline_events_read on pipeline_events
  for select using (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  );

grant select, insert, update, delete on pipeline_event_subscriptions to jxf_app;
grant select on pipeline_events to jxf_app;
revoke insert, update, delete on pipeline_events from jxf_app;
