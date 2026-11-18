-- 046 客户公共池：池策略 / 个体上限 / 流转流水 的 RLS 与流转函数
--
-- 设计要点：
--   - 公共池是 crm_accounts.pool_status 的状态位，不另建池表
--   - 领用 / 置公 / 分配 / 重点池裁决都收口到 SECURITY DEFINER 函数：
--     函数自己校验身份、部门范围与三层上限，避免把复杂条件散进 RLS
--   - 流转流水只追加，应用角色只能读

-- ---------------------------------------------------------------------------
-- 三层上限：个体覆盖 > 部门策略 > 全局默认（L3 150 / L2 500，0 = 不限）
-- ---------------------------------------------------------------------------
create or replace function app.crm_effective_holder_cap(p_user_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tenant uuid := app.current_tenant_id();
  v_level text;
  v_dept uuid;
  v_cap integer;
begin
  if p_user_id is null then
    return null;
  end if;
  v_level := app.effective_access_level(p_user_id);

  select c.holder_cap
    into v_cap
    from crm_holder_caps c
   where c.tenant_id = v_tenant
     and c.user_id = p_user_id
     and c.holder_cap is not null
     and c.valid_from <= now()
     and (c.valid_until is null or c.valid_until > now())
   limit 1;
  if v_cap is not null then
    return v_cap;
  end if;

  if p_user_id = app.current_user_id() then
    v_dept := app.current_active_department_id();
  end if;
  if v_dept is null then
    select m.department_id
      into v_dept
      from memberships m
     where m.user_id = p_user_id
       and m.status = 'active'
       and m.tenant_id = v_tenant
     order by m.department_id
     limit 1;
  end if;

  if v_dept is not null then
    select case when v_level = 'L2' then pol.manager_holder_cap else pol.holder_cap end
      into v_cap
      from crm_pool_policies pol
     where pol.tenant_id = v_tenant
       and pol.department_id = v_dept;
    if v_cap is not null then
      return v_cap;
    end if;
  end if;

  return case when v_level = 'L2' then 500 else 150 end;
end;
$fn$;

-- 当前私海持有数
create or replace function app.crm_held_count(p_user_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select count(*)::int
    from crm_accounts a
   where a.tenant_id = app.current_tenant_id()
     and a.owner_user_id = p_user_id
     and a.pool_status = 'private'
     and a.archived_at is null
$fn$;

-- ---------------------------------------------------------------------------
-- 领用：仅普通公海、仅本部门、需带 crm:claim（应用层校验），受三层上限约束
-- ---------------------------------------------------------------------------
create or replace function app.crm_pool_claim(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_user uuid := app.current_user_id();
  v_tenant uuid := app.current_tenant_id();
  v_account record;
  v_cap integer;
begin
  if v_user is null or v_tenant is null then
    raise exception 'missing identity' using errcode = '42501';
  end if;

  select a.id, a.department_id, a.pool_status, a.owner_user_id
    into v_account
    from crm_accounts a
   where a.id = p_account_id
     and a.tenant_id = v_tenant
     and a.archived_at is null
   for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  if not app.can_write(v_account.department_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if v_account.pool_status <> 'public' then
    raise exception 'only public accounts can be claimed' using errcode = '23514';
  end if;

  v_cap := app.crm_effective_holder_cap(v_user);
  if v_cap is not null and v_cap > 0 and app.crm_held_count(v_user) >= v_cap then
    raise exception 'holder cap reached' using errcode = '23514';
  end if;

  update crm_accounts
     set owner_user_id = v_user,
         pool_status = 'private',
         protection_until = now() + interval '90 days',
         released_reason = null,
         updated_at = now()
   where id = p_account_id;

  insert into crm_assignments
    (tenant_id, account_id, action, from_user_id, to_user_id,
     from_pool_status, to_pool_status, operated_by)
  values
    (v_tenant, p_account_id, 'claim', v_account.owner_user_id, v_user,
     'public', 'private', v_user);

  -- 客户一旦离开公海，同客户的待审批申请立即失效，避免审批入口残留
  update crm_claim_requests
     set status = 'cancelled',
         decided_by = v_user,
         decided_at = now(),
         decision_note = '客户已被领用'
   where tenant_id = v_tenant
     and account_id = p_account_id
     and status = 'pending';
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 置公：负责人本人或可写该部门的人；必须带原因
-- ---------------------------------------------------------------------------
create or replace function app.crm_pool_release(p_account_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_user uuid := app.current_user_id();
  v_tenant uuid := app.current_tenant_id();
  v_account record;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_user is null or v_tenant is null then
    raise exception 'missing identity' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'release reason required' using errcode = '22023';
  end if;

  select a.id, a.department_id, a.pool_status, a.owner_user_id
    into v_account
    from crm_accounts a
   where a.id = p_account_id
     and a.tenant_id = v_tenant
     and a.archived_at is null
   for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  if not (app.can_write(v_account.department_id) or v_account.owner_user_id = v_user) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if v_account.pool_status = 'public' then
    return;
  end if;

  update crm_accounts
     set pool_status = 'public',
         owner_user_id = null,
         protection_until = null,
         released_reason = v_reason,
         updated_at = now()
   where id = p_account_id;

  insert into crm_assignments
    (tenant_id, account_id, action, from_user_id, to_user_id,
     from_pool_status, to_pool_status, reason, operated_by)
  values
    (v_tenant, p_account_id, 'release', v_account.owner_user_id, null,
     v_account.pool_status, 'public', v_reason, v_user);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 定向分配（L1/L2）：管辖范围（可读子树）内分配；不受上限拦截但会回传超限
-- 重点池与候选分配必须带原因
-- ---------------------------------------------------------------------------
create or replace function app.crm_pool_assign(p_account_id uuid, p_to_user_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_user uuid := app.current_user_id();
  v_tenant uuid := app.current_tenant_id();
  v_level text := app.current_access_level();
  v_account record;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_to_dept uuid;
  v_cap integer;
  v_held integer;
begin
  if v_user is null or v_tenant is null then
    raise exception 'missing identity' using errcode = '42501';
  end if;
  if v_level not in ('L1', 'L2') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_to_user_id is null then
    raise exception 'target user required' using errcode = '22023';
  end if;

  select a.id, a.department_id, a.pool_status, a.owner_user_id
    into v_account
    from crm_accounts a
   where a.id = p_account_id
     and a.tenant_id = v_tenant
     and a.archived_at is null
   for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  if not app.can_read(v_account.department_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  -- 目标成员必须在本人的管辖范围内；同时取其在范围内、且优先与客户同部门的任用，
  -- 客户部门随负责人转移，否则新负责人拿到客户却因 can_write 不通过而改不动
  select m.department_id
    into v_to_dept
    from memberships m
   where m.user_id = p_to_user_id
     and m.status = 'active'
     and m.tenant_id = v_tenant
     and app.can_read(m.department_id)
   order by (m.department_id = v_account.department_id) desc, m.department_id
   limit 1;
  if v_to_dept is null then
    raise exception 'target user not in your scope' using errcode = '42501';
  end if;
  if v_account.pool_status in ('key', 'key_pending') and v_reason is null then
    raise exception 'reason required for key pool assignment' using errcode = '22023';
  end if;

  update crm_accounts
     set owner_user_id = p_to_user_id,
         department_id = v_to_dept,
         pool_status = 'private',
         protection_until = now() + interval '90 days',
         released_reason = null,
         updated_at = now()
   where id = p_account_id;

  -- 联系人 / 联系记录跟随客户部门，避免写入校验仍按旧部门判定
  update crm_contacts
     set department_id = v_to_dept
   where account_id = p_account_id
     and department_id <> v_to_dept;

  update crm_interactions
     set department_id = v_to_dept
   where account_id = p_account_id
     and department_id <> v_to_dept;

  insert into crm_assignments
    (tenant_id, account_id, action, from_user_id, to_user_id,
     from_pool_status, to_pool_status, reason, operated_by)
  values
    (v_tenant, p_account_id, 'assign', v_account.owner_user_id, p_to_user_id,
     v_account.pool_status, 'private', v_reason, v_user);

  -- 定向分配后同客户的待审批申请立即失效（含申请人本人那条）
  update crm_claim_requests
     set status = 'cancelled',
         decided_by = v_user,
         decided_at = now(),
         decision_note = '客户已由主管分配'
   where tenant_id = v_tenant
     and account_id = p_account_id
     and status = 'pending';

  v_cap := app.crm_effective_holder_cap(p_to_user_id);
  v_held := app.crm_held_count(p_to_user_id);
  return (v_cap is not null and v_cap > 0 and v_held > v_cap);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 重点池裁决（L1/L2）：候选 → 确认进重点池 / 降级回普通公海
-- ---------------------------------------------------------------------------
create or replace function app.crm_pool_confirm_key(
  p_account_id uuid,
  p_confirm boolean,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_user uuid := app.current_user_id();
  v_tenant uuid := app.current_tenant_id();
  v_level text := app.current_access_level();
  v_account record;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_next text := case when p_confirm then 'key' else 'public' end;
begin
  if v_user is null or v_tenant is null then
    raise exception 'missing identity' using errcode = '42501';
  end if;
  if v_level not in ('L1', 'L2') then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  select a.id, a.department_id, a.pool_status
    into v_account
    from crm_accounts a
   where a.id = p_account_id
     and a.tenant_id = v_tenant
     and a.archived_at is null
   for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if not app.can_read(v_account.department_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if v_account.pool_status <> 'key_pending' then
    raise exception 'account is not a key candidate' using errcode = '23514';
  end if;

  update crm_accounts
     set pool_status = v_next,
         owner_user_id = null,
         protection_until = null,
         updated_at = now()
   where id = p_account_id;

  insert into crm_assignments
    (tenant_id, account_id, action, from_pool_status, to_pool_status, reason, operated_by)
  values
    (v_tenant, p_account_id,
     case when p_confirm then 'key_confirm' else 'key_downgrade' end,
     'key_pending', v_next, v_reason, v_user);
end;
$fn$;

revoke all on function app.crm_effective_holder_cap(uuid) from public;
revoke all on function app.crm_held_count(uuid) from public;
revoke all on function app.crm_pool_claim(uuid) from public;
revoke all on function app.crm_pool_release(uuid, text) from public;
revoke all on function app.crm_pool_assign(uuid, uuid, text) from public;
revoke all on function app.crm_pool_confirm_key(uuid, boolean, text) from public;

grant execute on function app.crm_effective_holder_cap(uuid) to jxf_app;
grant execute on function app.crm_held_count(uuid) to jxf_app;
grant execute on function app.crm_pool_claim(uuid) to jxf_app;
grant execute on function app.crm_pool_release(uuid, text) to jxf_app;
grant execute on function app.crm_pool_assign(uuid, uuid, text) to jxf_app;
grant execute on function app.crm_pool_confirm_key(uuid, boolean, text) to jxf_app;

-- ---------------------------------------------------------------------------
-- 池策略：租户内可读（展示上限），L1 可写全部、L2 只能写本部门
-- ---------------------------------------------------------------------------
alter table crm_pool_policies enable row level security;

drop policy if exists crm_pool_policies_read on crm_pool_policies;
create policy crm_pool_policies_read on crm_pool_policies
  for select
  to jxf_app
  using (tenant_id = app.current_tenant_id());

drop policy if exists crm_pool_policies_write on crm_pool_policies;
create policy crm_pool_policies_write on crm_pool_policies
  for all
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and (
      app.current_access_level() = 'L1'
      or (app.current_access_level() = 'L2' and app.can_write(department_id))
    )
  )
  with check (
    tenant_id = app.current_tenant_id()
    and (
      app.current_access_level() = 'L1'
      or (app.current_access_level() = 'L2' and app.can_write(department_id))
    )
  );

-- ---------------------------------------------------------------------------
-- 个体上限：本人与 L1 可读；L2 可读管辖范围内的成员；写同读（crm:holder_cap 在应用层）
-- ---------------------------------------------------------------------------
alter table crm_holder_caps enable row level security;

drop policy if exists crm_holder_caps_read on crm_holder_caps;
create policy crm_holder_caps_read on crm_holder_caps
  for select
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and (
      app.current_access_level() = 'L1'
      or user_id = app.current_user_id()
      or (
        app.current_access_level() = 'L2'
        and exists (
          select 1
            from memberships m
           where m.user_id = crm_holder_caps.user_id
             and m.status = 'active'
             and m.tenant_id = app.current_tenant_id()
             and app.can_read(m.department_id)
        )
      )
    )
  );

drop policy if exists crm_holder_caps_write on crm_holder_caps;
create policy crm_holder_caps_write on crm_holder_caps
  for all
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and (
      app.current_access_level() = 'L1'
      or (
        app.current_access_level() = 'L2'
        and exists (
          select 1
            from memberships m
           where m.user_id = crm_holder_caps.user_id
             and m.status = 'active'
             and m.tenant_id = app.current_tenant_id()
             and app.can_read(m.department_id)
        )
      )
    )
  )
  with check (
    tenant_id = app.current_tenant_id()
    and (
      app.current_access_level() = 'L1'
      or (
        app.current_access_level() = 'L2'
        and exists (
          select 1
            from memberships m
           where m.user_id = crm_holder_caps.user_id
             and m.status = 'active'
             and m.tenant_id = app.current_tenant_id()
             and app.can_read(m.department_id)
        )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 流转流水：可见性跟随客户；只追加，应用角色不得改删
-- ---------------------------------------------------------------------------
alter table crm_assignments enable row level security;

drop policy if exists crm_assignments_read on crm_assignments;
create policy crm_assignments_read on crm_assignments
  for select
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and exists (select 1 from crm_accounts a where a.id = account_id)
  );

revoke insert, update, delete, truncate on crm_assignments from jxf_app;
