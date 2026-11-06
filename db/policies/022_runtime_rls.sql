-- M3 AI 运行时：RLS 与 worker 权限
--
-- 设计：
--   1. 业务角色 jxf_app：threads / runs 可读写本部门；事件与用量只读（只追加，业务侧不可删）。
--   2. worker 进程使用专用受限角色 app_worker（由 docker/postgres/00-init.sh 创建）：
--      只对运行时表授予 DML，且策略以 current_user = 'app_worker' 判定；
--      绝不授予 threads 之外的业务表权限。
--   3. 全部表都不提供 DELETE 策略：事件流只追加。
--
-- 幂等：drop policy if exists → create policy；授权用 do 块包裹，角色不存在时跳过。

alter table threads       enable row level security;
alter table runs          enable row level security;
alter table run_steps     enable row level security;
alter table run_events    enable row level security;
alter table tool_calls    enable row level security;
alter table token_usages  enable row level security;

-- ---------------------------------------------------------------------------
-- 业务角色：jxf_app
-- ---------------------------------------------------------------------------

drop policy if exists threads_read on threads;
create policy threads_read on threads
  for select using (app.can_read(department_id));

drop policy if exists threads_insert on threads;
create policy threads_insert on threads
  for insert with check (app.can_write(department_id));

drop policy if exists threads_update on threads;
create policy threads_update on threads
  for update using (app.can_write(department_id))
  with check (app.can_write(department_id));

drop policy if exists runs_read on runs;
create policy runs_read on runs
  for select using (app.can_read(department_id));

drop policy if exists runs_insert on runs;
create policy runs_insert on runs
  for insert with check (app.can_write(department_id));

-- 受理后由用户触发的写只有「取消」与读取；运行时状态推进由 worker 负责
drop policy if exists runs_update on runs;
create policy runs_update on runs
  for update using (app.can_write(department_id))
  with check (app.can_write(department_id));

drop policy if exists run_steps_read on run_steps;
create policy run_steps_read on run_steps
  for select using (
    exists (select 1 from runs r where r.id = run_steps.run_id and app.can_read(r.department_id))
  );

drop policy if exists run_events_read on run_events;
create policy run_events_read on run_events
  for select using (app.can_read(department_id));

drop policy if exists tool_calls_read on tool_calls;
create policy tool_calls_read on tool_calls
  for select using (app.can_read(department_id));

drop policy if exists token_usages_read on token_usages;
create policy token_usages_read on token_usages
  for select using (app.can_read(department_id));

-- ---------------------------------------------------------------------------
-- worker 角色：app_worker
-- ---------------------------------------------------------------------------

drop policy if exists runs_worker_read on runs;
create policy runs_worker_read on runs
  for select using (current_user = 'app_worker');

drop policy if exists runs_worker_update on runs;
create policy runs_worker_update on runs
  for update using (current_user = 'app_worker')
  with check (current_user = 'app_worker');

drop policy if exists threads_worker_read on threads;
create policy threads_worker_read on threads
  for select using (current_user = 'app_worker');

drop policy if exists run_steps_worker_read on run_steps;
create policy run_steps_worker_read on run_steps
  for select using (current_user = 'app_worker');

drop policy if exists run_steps_worker_insert on run_steps;
create policy run_steps_worker_insert on run_steps
  for insert with check (current_user = 'app_worker');

-- 模型调用结束后回填 model / provider / duration_ms，worker 必须能更新自己写入的 step
drop policy if exists run_steps_worker_update on run_steps;
create policy run_steps_worker_update on run_steps
  for update using (current_user = 'app_worker')
  with check (current_user = 'app_worker');

drop policy if exists run_events_worker_read on run_events;
create policy run_events_worker_read on run_events
  for select using (current_user = 'app_worker');

drop policy if exists run_events_worker_insert on run_events;
create policy run_events_worker_insert on run_events
  for insert with check (current_user = 'app_worker');

drop policy if exists tool_calls_worker_read on tool_calls;
create policy tool_calls_worker_read on tool_calls
  for select using (current_user = 'app_worker');

drop policy if exists tool_calls_worker_insert on tool_calls;
create policy tool_calls_worker_insert on tool_calls
  for insert with check (current_user = 'app_worker');

drop policy if exists token_usages_worker_read on token_usages;
create policy token_usages_worker_read on token_usages
  for select using (current_user = 'app_worker');

drop policy if exists token_usages_worker_insert on token_usages;
create policy token_usages_worker_insert on token_usages
  for insert with check (current_user = 'app_worker');

-- ---------------------------------------------------------------------------
-- 表级授权
-- ---------------------------------------------------------------------------

grant select, insert, update on threads       to jxf_app;
grant select, insert, update on runs          to jxf_app;
grant select on run_steps, run_events, tool_calls, token_usages to jxf_app;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_worker') then
    execute 'grant select, update on runs to app_worker';
    execute 'grant select on threads to app_worker';
    execute 'grant select, insert on run_events, tool_calls, token_usages to app_worker';
    execute 'grant select, insert, update on run_steps to app_worker';
    execute 'grant usage, select on all sequences in schema public to app_worker';
    -- worker 写入带 returning 时 PostgreSQL 会同时求值 SELECT 策略，
    -- 必须能求值 app.can_read / app.can_write（GUC 为空，结果恒为 false，不产生越权）
    execute 'grant usage on schema app to app_worker';
    execute 'grant execute on function app.my_department_ids() to app_worker';
    execute 'grant execute on function app.can_read(uuid), app.can_write(uuid) to app_worker';
  end if;
end $$;
