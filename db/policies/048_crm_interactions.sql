-- 048 客户交互时间线 RLS
--
-- 联系记录的可见性完全跟随客户：能看到客户，就能看到它的联系记录；
-- 可写条件与"能改这个客户"一致，避免出现"能写客户却不能写记录"的割裂。
-- 依赖 crm_accounts 自身的 RLS（子查询里会自动生效）。

alter table crm_interactions enable row level security;

drop policy if exists crm_interactions_read on crm_interactions;
create policy crm_interactions_read on crm_interactions
  for select
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and exists (select 1 from crm_accounts a where a.id = account_id)
  );

drop policy if exists crm_interactions_write on crm_interactions;
create policy crm_interactions_write on crm_interactions
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
