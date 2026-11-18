-- 045 客户与联系人 RLS
--
-- 读：L1 全量 / 本人 / 汇报线下级 / L2 部门子树 / L3 本部门 / 范围例外授权 / 单条资源共享
-- 写：L1 全量；L2 只能写本部门；L3 只能写本部门且必须是自己的客户；
--     例外授权与单条共享按授权人的显式范围放行。
-- 写策略必须同时约束 department_id，否则 L3 可以把自己的客户建到兄弟部门，破坏部门归属。
-- 联系人的可见与可写跟随所属客户，不单独维护一套范围。

-- ---------------------------------------------------------------------------
-- 建档查重：按租户全量比对归一后的名称
-- RLS 只能看到自己范围内的客户，跨部门同名会漏判，因此单独收一个只回布尔的入口，
-- 不返回对方名称与编码，避免把其他部门的客户名透给 L3。
-- ---------------------------------------------------------------------------
create or replace function app.crm_account_name_exists(p_name_norm text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from crm_accounts a
     where a.tenant_id = app.current_tenant_id()
       and a.name_norm = p_name_norm
       and a.archived_at is null
  )
$fn$;

revoke all on function app.crm_account_name_exists(text) from public;
grant execute on function app.crm_account_name_exists(text) to jxf_app;

alter table crm_accounts enable row level security;

drop policy if exists crm_accounts_read on crm_accounts;
create policy crm_accounts_read on crm_accounts
  for select
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    -- 重点池候选与已确认的重点池只对 L1/L2 可见，避免"AI 打高分就被抢"
    and (
      app.current_access_level() in ('L1', 'L2')
      or pool_status not in ('key_pending', 'key')
    )
    and (
      app.current_access_level() = 'L1'
      or owner_user_id = app.current_user_id()
      or owner_user_id = any (app.manager_subtree_user_ids(app.current_user_id()))
      or (app.current_access_level() = 'L2' and app.can_read(department_id))
      or (app.current_access_level() = 'L3' and app.can_write(department_id))
      or owner_user_id = any (app.scope_grant_refs('crm', 'read'))
      or owner_user_id = any (app.scope_grant_refs('crm', 'write'))
      or owner_user_id = any (app.scope_grant_refs('crm', 'manage'))
      or app.has_resource_capability('crm_account', id, 'read')
    )
  );

drop policy if exists crm_accounts_write on crm_accounts;
create policy crm_accounts_write on crm_accounts
  for all
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and (
      app.current_access_level() = 'L1'
      or (
        app.can_write(department_id)
        and (
          app.current_access_level() = 'L2'
          or owner_user_id = app.current_user_id()
        )
      )
      or owner_user_id = any (app.scope_grant_refs('crm', 'write'))
      or owner_user_id = any (app.scope_grant_refs('crm', 'manage'))
      or app.has_resource_capability('crm_account', id, 'write')
    )
  )
  with check (
    tenant_id = app.current_tenant_id()
    and (
      app.current_access_level() = 'L1'
      or (
        app.can_write(department_id)
        and (
          app.current_access_level() = 'L2'
          or owner_user_id = app.current_user_id()
        )
      )
      or owner_user_id = any (app.scope_grant_refs('crm', 'write'))
      or owner_user_id = any (app.scope_grant_refs('crm', 'manage'))
      or app.has_resource_capability('crm_account', id, 'write')
    )
  );

alter table crm_contacts enable row level security;

drop policy if exists crm_contacts_read on crm_contacts;
create policy crm_contacts_read on crm_contacts
  for select
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and exists (select 1 from crm_accounts a where a.id = account_id)
  );

drop policy if exists crm_contacts_write on crm_contacts;
create policy crm_contacts_write on crm_contacts
  for all
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and exists (
      select 1
        from crm_accounts a
       where a.id = account_id
         and (
           app.current_access_level() = 'L1'
           or (
             app.can_write(a.department_id)
             and (
               app.current_access_level() = 'L2'
               or a.owner_user_id = app.current_user_id()
             )
           )
           or a.owner_user_id = any (app.scope_grant_refs('crm', 'write'))
           or a.owner_user_id = any (app.scope_grant_refs('crm', 'manage'))
           or app.has_resource_capability('crm_account', a.id, 'write')
         )
    )
  )
  with check (
    tenant_id = app.current_tenant_id()
    and exists (
      select 1
        from crm_accounts a
       where a.id = account_id
         and (
           app.current_access_level() = 'L1'
           or (
             app.can_write(a.department_id)
             and (
               app.current_access_level() = 'L2'
               or a.owner_user_id = app.current_user_id()
             )
           )
           or a.owner_user_id = any (app.scope_grant_refs('crm', 'write'))
           or a.owner_user_id = any (app.scope_grant_refs('crm', 'manage'))
           or app.has_resource_capability('crm_account', a.id, 'write')
         )
    )
  );
