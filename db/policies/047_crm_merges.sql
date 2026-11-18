-- 047 客户合并：合并函数与 crm_merges 的只读策略
--
-- 合并规则：
--   - 仅 L1/L2（应用层校验 crm:merge），源客户必须可写、目标客户必须可读
--   - 源客户不物理删除：打 archived_at 并指向 target，旧编码在 crm_merges 留档
--   - 联系人迁到目标并跟随目标部门；目标已有主联系人时，迁入的主联系人降级为普通联系人
--   - 记录合并前后编码与迁移统计，供审计与反查
--   - 已合并的客户不能再次作为源或目标

create or replace function app.crm_merge_accounts(
  p_source_id uuid,
  p_target_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_user uuid := app.current_user_id();
  v_tenant uuid := app.current_tenant_id();
  v_level text := app.current_access_level();
  v_source record;
  v_target record;
  v_moved_contacts integer := 0;
  v_merge_id uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_user is null or v_tenant is null then
    raise exception 'missing identity' using errcode = '42501';
  end if;
  if v_level not in ('L1', 'L2') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_source_id is null or p_target_id is null or p_source_id = p_target_id then
    raise exception 'source and target must be different' using errcode = '22023';
  end if;

  select a.id, a.code, a.department_id, a.merged_into_id, a.archived_at
    into v_source
    from crm_accounts a
   where a.id = p_source_id
     and a.tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'source account not found' using errcode = 'P0002';
  end if;

  select a.id, a.code, a.department_id, a.merged_into_id, a.archived_at
    into v_target
    from crm_accounts a
   where a.id = p_target_id
     and a.tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'target account not found' using errcode = 'P0002';
  end if;

  if v_source.archived_at is not null then
    raise exception 'source account already archived' using errcode = '23514';
  end if;
  if v_target.archived_at is not null then
    raise exception 'target account already archived' using errcode = '23514';
  end if;
  if v_source.merged_into_id is not null or v_target.merged_into_id is not null then
    raise exception 'account already merged' using errcode = '23514';
  end if;
  if not app.can_write(v_source.department_id) then
    raise exception 'permission denied on source' using errcode = '42501';
  end if;
  if not app.can_read(v_target.department_id) then
    raise exception 'target out of your scope' using errcode = '42501';
  end if;

  update crm_contacts c
     set is_primary = false
   where c.account_id = p_source_id
     and c.is_primary
     and exists (
       select 1 from crm_contacts t
        where t.account_id = p_target_id and t.is_primary
     );

  with moved as (
    update crm_contacts
       set account_id = p_target_id,
           department_id = v_target.department_id,
           updated_at = now()
     where account_id = p_source_id
    returning 1
  )
  select count(*)::int into v_moved_contacts from moved;

  update crm_accounts
     set merged_into_id = p_target_id,
         archived_at = now(),
         updated_at = now()
   where id = p_source_id;

  insert into crm_merges
    (tenant_id, source_account_id, target_account_id, source_code, target_code,
     moved_contacts, moved_counts, reason, merged_by)
  values
    (v_tenant, p_source_id, p_target_id, v_source.code, v_target.code,
     v_moved_contacts, jsonb_build_object('contacts', v_moved_contacts), v_reason, v_user)
  returning id into v_merge_id;

  return jsonb_build_object(
    'merge_id', v_merge_id,
    'source_code', v_source.code,
    'target_code', v_target.code,
    'contacts', v_moved_contacts
  );
end;
$fn$;

revoke all on function app.crm_merge_accounts(uuid, uuid, text) from public;
grant execute on function app.crm_merge_accounts(uuid, uuid, text) to jxf_app;

-- ---------------------------------------------------------------------------
-- 合并记录：可见性跟随目标客户；只追加，写入只经函数
-- ---------------------------------------------------------------------------
alter table crm_merges enable row level security;

drop policy if exists crm_merges_read on crm_merges;
create policy crm_merges_read on crm_merges
  for select
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and (
      exists (select 1 from crm_accounts a where a.id = target_account_id)
      or exists (select 1 from crm_accounts a where a.id = source_account_id)
    )
  );

revoke insert, update, delete, truncate on crm_merges from jxf_app;
