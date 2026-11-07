-- M4 MCP Hub：mcp_tokens 的 RLS 与令牌校验函数
--
-- 约定：
--   令牌管理只对 L1 开放（token:issue 仅 L1 可持有）；
--   外部客户端没有会话，只能通过 SECURITY DEFINER 函数按 hash 反查；
--   函数内部同时校验任用仍在岗（离岗即失效，比过期更强）。

alter table mcp_tokens enable row level security;

drop policy if exists mcp_tokens_read on mcp_tokens;
create policy mcp_tokens_read on mcp_tokens
  for select using (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
  );

drop policy if exists mcp_tokens_insert on mcp_tokens;
create policy mcp_tokens_insert on mcp_tokens
  for insert with check (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
  );

drop policy if exists mcp_tokens_update on mcp_tokens;
create policy mcp_tokens_update on mcp_tokens
  for update using (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
  ) with check (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
  );

-- 不提供 DELETE：吊销走 revoked_at，保留审计痕迹
grant select, insert, update on mcp_tokens to jxf_app;

-- 按 hash 反查：只在 token 未吊销、未过期且任用仍在岗时返回
create or replace function app.lookup_mcp_token(p_hash text)
returns table (
  id uuid,
  tenant_id uuid,
  membership_id uuid,
  user_id uuid,
  department_id uuid,
  scope jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select t.id, t.tenant_id, t.membership_id, t.user_id, t.department_id, t.scope
    from mcp_tokens t
    join memberships m on m.id = t.membership_id
   where t.token_hash = p_hash
     and t.revoked_at is null
     and (t.expires_at is null or t.expires_at > now())
     and m.status = 'active'
     and m.removed_at is null
$fn$;

revoke all on function app.lookup_mcp_token(text) from public;
grant execute on function app.lookup_mcp_token(text) to jxf_app;

-- 记录最近使用时间；失败不影响调用
create or replace function app.touch_mcp_token(p_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $fn$
  update mcp_tokens set last_used_at = now() where id = p_id
$fn$;

revoke all on function app.touch_mcp_token(uuid) from public;
grant execute on function app.touch_mcp_token(uuid) to jxf_app;
