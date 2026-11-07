-- P5 切片 2：运维任务（备份 / 恢复演练）
--
-- Web 不持有 docker 权限，只负责「落单」；宿主机 ops-runner 轮询队列执行，
-- 用 owner 连接回写状态。业务角色只能由 L1 插入 queued 任务并读取，不能改状态。

alter table ops_tasks enable row level security;

drop policy if exists ops_tasks_read on ops_tasks;
create policy ops_tasks_read on ops_tasks
  for select using (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  );

drop policy if exists ops_tasks_insert on ops_tasks;
create policy ops_tasks_insert on ops_tasks
  for insert with check (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
    and requested_by_user_id = app.current_user_id()
    and status = 'queued'
  );

grant select, insert on ops_tasks to jxf_app;
revoke update, delete on ops_tasks from jxf_app;
