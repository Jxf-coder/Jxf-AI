-- 052 客户相关文档 RLS
--
-- 可见性与联系记录一致：能看到客户，就能看到它的文档；
-- 可写条件与"能改这个客户"一致，避免出现"只读用户上传/删除附件"的漏洞。

alter table crm_documents enable row level security;

drop policy if exists crm_documents_read on crm_documents;
create policy crm_documents_read on crm_documents
  for select
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and exists (select 1 from crm_accounts a where a.id = account_id)
  );

drop policy if exists crm_documents_write on crm_documents;
create policy crm_documents_write on crm_documents
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
