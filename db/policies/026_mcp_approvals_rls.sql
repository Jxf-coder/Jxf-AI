-- M4 切片 4：逐工具审批单 RLS
--
-- 申请：任何在岗任用（MCP 令牌上下文）都可为「自己的写类调用」落单；
-- 读：申请人可看自己的单，L1 可看全部；
-- 决定：仅 L1；删除一律禁止（保留审计）。

alter table mcp_tool_approvals enable row level security;

drop policy if exists mcp_tool_approvals_read on mcp_tool_approvals;
create policy mcp_tool_approvals_read on mcp_tool_approvals
  for select using (
    tenant_id = app.current_tenant_id()
    and (
      user_id = app.current_user_id()
      or app.current_access_level() = 'L1'
    )
  );

drop policy if exists mcp_tool_approvals_insert on mcp_tool_approvals;
create policy mcp_tool_approvals_insert on mcp_tool_approvals
  for insert with check (
    tenant_id = app.current_tenant_id()
    and user_id = app.current_user_id()
  );

drop policy if exists mcp_tool_approvals_update on mcp_tool_approvals;
create policy mcp_tool_approvals_update on mcp_tool_approvals
  for update using (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  ) with check (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  );

grant select, insert, update on mcp_tool_approvals to jxf_app;
revoke delete on mcp_tool_approvals from jxf_app;
