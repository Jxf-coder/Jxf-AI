-- 043 例外授权：data_scope_grants 与 resource_shares 的 RLS 与判定函数
--
-- 规则：
--   - 两张表只有 L1 可以创建/修改；例外地，某资源的 manage 持有者（如被授权管理公共邮箱的 L2）可以为该资源继续授权
--   - 有效期一律用 now() 实时过滤，到期即刻失效，不依赖定时任务
--   - 判定函数全部 SECURITY DEFINER，避免策略内递归查同一张表

create or replace function app.has_scope_grant_all(p_domain text, p_capability text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from data_scope_grants g
     where g.tenant_id = app.current_tenant_id()
       and g.grantee_user_id = app.current_user_id()
       and g.domain = p_domain
       and g.capability = p_capability
       and g.scope_type = 'ALL'
       and g.valid_from <= now()
       and (g.valid_until is null or g.valid_until > now())
  );
$fn$;

create or replace function app.scope_grant_refs(p_domain text, p_capability text)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(array_agg(ref), '{}'::uuid[])
    from (
      select distinct unnest(g.scope_refs) as ref
        from data_scope_grants g
       where g.tenant_id = app.current_tenant_id()
         and g.grantee_user_id = app.current_user_id()
         and g.domain = p_domain
         and g.capability = p_capability
         and g.scope_type in ('USERS', 'DEPARTMENTS')
         and g.valid_from <= now()
         and (g.valid_until is null or g.valid_until > now())
    ) refs;
$fn$;

create or replace function app.has_resource_manage(p_resource_type text, p_resource_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
    when app.current_user_id() is null then false
    when app.current_access_level() = 'L1' then true
    else exists (
      select 1
        from resource_shares s
       where s.tenant_id = app.current_tenant_id()
         and s.resource_type = p_resource_type
         and s.resource_id = p_resource_id
         and s.grantee_user_id = app.current_user_id()
         and s.capability = 'manage'
         and s.valid_from <= now()
         and (s.valid_until is null or s.valid_until > now())
    )
  end;
$fn$;

create or replace function app.has_resource_capability(
  p_resource_type text,
  p_resource_id uuid,
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
    when app.current_user_id() is null then false
    when app.current_access_level() = 'L1' then true
    else exists (
      select 1
        from resource_shares s
       where s.tenant_id = app.current_tenant_id()
         and s.resource_type = p_resource_type
         and s.resource_id = p_resource_id
         and s.grantee_user_id = app.current_user_id()
         and s.valid_from <= now()
         and (s.valid_until is null or s.valid_until > now())
         and (
           s.capability = p_capability
           or s.capability = 'manage'
           or (p_capability = 'read' and s.capability in ('write', 'send', 'assign'))
         )
    )
  end;
$fn$;

revoke all on function app.has_scope_grant_all(text, text) from public;
revoke all on function app.scope_grant_refs(text, text) from public;
revoke all on function app.has_resource_manage(text, uuid) from public;
revoke all on function app.has_resource_capability(text, uuid, text) from public;

grant execute on function app.has_scope_grant_all(text, text) to jxf_app;
grant execute on function app.scope_grant_refs(text, text) to jxf_app;
grant execute on function app.has_resource_manage(text, uuid) to jxf_app;
grant execute on function app.has_resource_capability(text, uuid, text) to jxf_app;

-- ---------------------------------------------------------------------------
-- data_scope_grants：本人可读自己的例外授权，L1 可读全部并可写
-- ---------------------------------------------------------------------------
alter table data_scope_grants enable row level security;

drop policy if exists data_scope_grants_read on data_scope_grants;
create policy data_scope_grants_read on data_scope_grants
  for select
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and (
      app.current_access_level() = 'L1'
      or grantee_user_id = app.current_user_id()
    )
  );

drop policy if exists data_scope_grants_write on data_scope_grants;
create policy data_scope_grants_write on data_scope_grants
  for all
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  )
  with check (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  );

-- ---------------------------------------------------------------------------
-- resource_shares：被共享人可读；资源 manage 持有者可读可写；L1 全量
-- ---------------------------------------------------------------------------
alter table resource_shares enable row level security;

drop policy if exists resource_shares_read on resource_shares;
create policy resource_shares_read on resource_shares
  for select
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and (
      grantee_user_id = app.current_user_id()
      or app.has_resource_manage(resource_type, resource_id)
    )
  );

drop policy if exists resource_shares_write on resource_shares;
create policy resource_shares_write on resource_shares
  for all
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and app.has_resource_manage(resource_type, resource_id)
  )
  with check (
    tenant_id = app.current_tenant_id()
    and app.has_resource_manage(resource_type, resource_id)
  );
