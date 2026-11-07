-- M4 切片 2：外部 MCP 连接器与调用账本的 RLS
--
-- 连接器是全局配置：仅 L1 可见可改（platform:settings 仅 L1 持有）；
-- 调用账本只追加，用于审计与每分钟限流，不提供 UPDATE / DELETE。

alter table mcp_servers enable row level security;

drop policy if exists mcp_servers_read on mcp_servers;
create policy mcp_servers_read on mcp_servers
  for select using (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
  );

drop policy if exists mcp_servers_insert on mcp_servers;
create policy mcp_servers_insert on mcp_servers
  for insert with check (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
  );

drop policy if exists mcp_servers_update on mcp_servers;
create policy mcp_servers_update on mcp_servers
  for update using (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
  ) with check (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
  );

grant select, insert, update on mcp_servers to jxf_app;

alter table mcp_server_calls enable row level security;

drop policy if exists mcp_server_calls_read on mcp_server_calls;
create policy mcp_server_calls_read on mcp_server_calls
  for select using (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
  );

drop policy if exists mcp_server_calls_insert on mcp_server_calls;
create policy mcp_server_calls_insert on mcp_server_calls
  for insert with check (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
  );

grant select, insert on mcp_server_calls to jxf_app;

-- worker 角色：只读连接器配置（构建工具计划）、写入调用账本（限流与审计）
drop policy if exists mcp_servers_worker_read on mcp_servers;
create policy mcp_servers_worker_read on mcp_servers
  for select using (current_user = 'app_worker');

drop policy if exists mcp_server_calls_worker_read on mcp_server_calls;
create policy mcp_server_calls_worker_read on mcp_server_calls
  for select using (current_user = 'app_worker');

drop policy if exists mcp_server_calls_worker_insert on mcp_server_calls;
create policy mcp_server_calls_worker_insert on mcp_server_calls
  for insert with check (current_user = 'app_worker');

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_worker') then
    execute 'grant select on mcp_servers to app_worker';
    execute 'grant select, insert on mcp_server_calls to app_worker';
    -- 同表上仍有 jxf_app 策略引用这些 GUC 读取函数，策略按 OR 组合时会一并求值
    execute 'grant execute on function app.current_tenant_id(), app.current_access_level() to app_worker';
  end if;
end $$;
