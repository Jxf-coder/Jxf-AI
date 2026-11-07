-- M3.5 AI 员工派活：work_items 的 RLS 与 worker 权限
--
-- 约定与运行时表一致：
--   业务角色 jxf_app：本部门可读写（读子树、写本部门）；
--   worker 角色 app_worker：只读、只改执行状态与交付物；
--   不提供 DELETE 策略：工作项保留审计与历史。

alter table work_items enable row level security;

drop policy if exists work_items_read on work_items;
create policy work_items_read on work_items
  for select using (app.can_read(department_id));

drop policy if exists work_items_insert on work_items;
create policy work_items_insert on work_items
  for insert with check (app.can_write(department_id));

drop policy if exists work_items_update on work_items;
create policy work_items_update on work_items
  for update using (app.can_write(department_id))
  with check (app.can_write(department_id));

drop policy if exists work_items_worker_read on work_items;
create policy work_items_worker_read on work_items
  for select using (current_user = 'app_worker');

drop policy if exists work_items_worker_update on work_items;
create policy work_items_worker_update on work_items
  for update using (current_user = 'app_worker')
  with check (current_user = 'app_worker');

grant select, insert, update on work_items to jxf_app;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_worker') then
    execute 'grant select, update on work_items to app_worker';
  end if;
end $$;
