-- 经验采集队列 / 目录纠偏样本：RLS 与授权
--
-- 与 022_runtime_rls.sql 保持一致：
--   1. 业务侧 jxf_app 用租户 + 部门上下文；
--   2. worker 侧单独一条 current_user = 'app_worker' 的通道——领取任务时
--      还不知道 department_id，无法满足 app.can_write；
--   3. 不提供物理 DELETE，保留审计与追溯。

alter table experience_jobs enable row level security;
alter table folder_route_feedback enable row level security;

-- ---------------------------------------------------------------------------
-- jxf_app
-- ---------------------------------------------------------------------------
drop policy if exists experience_jobs_read on experience_jobs;
create policy experience_jobs_read on experience_jobs
  for select
  using (tenant_id = app.current_tenant_id() and app.can_read(department_id));

drop policy if exists experience_jobs_insert on experience_jobs;
create policy experience_jobs_insert on experience_jobs
  for insert
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists experience_jobs_update on experience_jobs;
create policy experience_jobs_update on experience_jobs
  for update
  using (tenant_id = app.current_tenant_id() and app.can_write(department_id))
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

-- ---------------------------------------------------------------------------
-- worker 通道（与 runs 一致）
-- ---------------------------------------------------------------------------
drop policy if exists experience_jobs_worker_select on experience_jobs;
create policy experience_jobs_worker_select on experience_jobs
  for select
  using (current_user = 'app_worker');

drop policy if exists experience_jobs_worker_update on experience_jobs;
create policy experience_jobs_worker_update on experience_jobs
  for update
  using (current_user = 'app_worker')
  with check (current_user = 'app_worker');

-- ---------------------------------------------------------------------------
-- folder_route_feedback：只由 web 侧写（确认 / 改目录）
-- ---------------------------------------------------------------------------
drop policy if exists folder_route_feedback_read on folder_route_feedback;
create policy folder_route_feedback_read on folder_route_feedback
  for select
  using (tenant_id = app.current_tenant_id() and app.can_read(department_id));

drop policy if exists folder_route_feedback_insert on folder_route_feedback;
create policy folder_route_feedback_insert on folder_route_feedback
  for insert
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

grant select, insert, update on experience_jobs to jxf_app;
grant select, insert on folder_route_feedback to jxf_app;

-- ---------------------------------------------------------------------------
-- worker 授权：写卡与证据时仍需满足对应表的 can_write 策略，
-- 因此 worker 必须先 set_config('app.tenant_id' / 'app.department_ids')。
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_worker') then
    execute 'grant select, update on experience_jobs to app_worker';
    execute 'grant select, insert, update on knowledge_cards, card_evidence to app_worker';
    execute 'grant execute on function app.can_write(uuid), app.can_read(uuid), app.current_tenant_id(), app.my_department_ids() to app_worker';
    execute 'grant usage, select on all sequences in schema public to app_worker';
  end if;
end $$;
