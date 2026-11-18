-- 050 公共池领用申请：RLS 与申请 / 审批函数
--
-- 设计要点：
--   - L2 / L3 只能提交申请；审批人是 L1，或该申请部门的 L2（仅限审批 L3 的申请）
--   - 审批通过时才真正改归属，并复用领用的上限与 90 天保护期规则
--   - 应用角色只能读申请表，写入全部收口到 SECURITY DEFINER 函数

alter table crm_claim_requests enable row level security;

drop policy if exists crm_claim_requests_read on crm_claim_requests;
create policy crm_claim_requests_read on crm_claim_requests
  for select
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and (
      requester_user_id = app.current_user_id()
      or app.current_access_level() = 'L1'
      or (app.current_access_level() = 'L2' and app.can_read(department_id))
    )
  );

-- ---------------------------------------------------------------------------
-- 提交领用申请（L2 / L3）：普通公海、本部门可写、未达上限、无重复待审批
-- ---------------------------------------------------------------------------
create or replace function app.crm_pool_request_claim(p_account_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_user uuid := app.current_user_id();
  v_tenant uuid := app.current_tenant_id();
  v_level text := app.current_access_level();
  v_account record;
  v_cap integer;
  v_id uuid;
begin
  if v_user is null or v_tenant is null then
    raise exception 'missing identity' using errcode = '42501';
  end if;
  if v_level not in ('L2', 'L3') then
    raise exception 'only L2/L3 can request a claim' using errcode = '42501';
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
  if not app.can_write(v_account.department_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if v_account.pool_status <> 'public' then
    raise exception 'only public accounts can be requested' using errcode = '23514';
  end if;

  v_cap := app.crm_effective_holder_cap(v_user);
  if v_cap is not null and v_cap > 0 and app.crm_held_count(v_user) >= v_cap then
    raise exception 'holder cap reached' using errcode = '23514';
  end if;

  if exists (
    select 1
      from crm_claim_requests r
     where r.tenant_id = v_tenant
       and r.account_id = p_account_id
       and r.requester_user_id = v_user
       and r.status = 'pending'
  ) then
    raise exception 'claim request already pending' using errcode = '23514';
  end if;

  insert into crm_claim_requests
    (tenant_id, department_id, account_id, requester_user_id, status)
  values
    (v_tenant, v_account.department_id, p_account_id, v_user, 'pending')
  returning id into v_id;

  return v_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 审批领用申请（L1 / L2）
--   - 不能审批自己的申请
--   - L2 只能审批本部门 L3 的申请；L2 的申请只能由 L1 审批
--   - 通过时复检公海状态、部门、申请人任用与上限，再改归属并写流转流水
-- ---------------------------------------------------------------------------
create or replace function app.crm_pool_decide_claim(
  p_request_id uuid,
  p_approve boolean,
  p_note text
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
  v_req record;
  v_req_level text;
  v_account record;
  v_cap integer;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_user is null or v_tenant is null then
    raise exception 'missing identity' using errcode = '42501';
  end if;
  if v_level not in ('L1', 'L2') then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  select r.*
    into v_req
    from crm_claim_requests r
   where r.id = p_request_id
     and r.tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'request is not pending' using errcode = '23514';
  end if;
  if v_req.requester_user_id = v_user then
    raise exception 'cannot decide your own request' using errcode = '42501';
  end if;

  v_req_level := app.effective_access_level(v_req.requester_user_id);
  if v_level = 'L2' then
    if v_req_level <> 'L3' then
      raise exception 'L2 can only approve L3 requests' using errcode = '42501';
    end if;
    if not app.can_write(v_req.department_id) then
      raise exception 'permission denied' using errcode = '42501';
    end if;
  end if;

  if not p_approve then
    update crm_claim_requests
       set status = 'rejected',
           decided_by = v_user,
           decided_at = now(),
           decision_note = v_note
     where id = p_request_id;
    return;
  end if;

  select a.id, a.department_id, a.pool_status, a.owner_user_id
    into v_account
    from crm_accounts a
   where a.id = v_req.account_id
     and a.tenant_id = v_tenant
     and a.archived_at is null
   for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if v_account.department_id <> v_req.department_id then
    raise exception 'account department changed' using errcode = '23514';
  end if;
  if v_account.pool_status <> 'public' then
    raise exception 'account is no longer in public pool' using errcode = '23514';
  end if;
  if not exists (
    select 1
      from memberships m
     where m.tenant_id = v_tenant
       and m.user_id = v_req.requester_user_id
       and m.department_id = v_req.department_id
       and m.status = 'active'
  ) then
    raise exception 'requester no longer in department' using errcode = '42501';
  end if;

  v_cap := app.crm_effective_holder_cap(v_req.requester_user_id);
  if v_cap is not null and v_cap > 0 and app.crm_held_count(v_req.requester_user_id) >= v_cap then
    raise exception 'holder cap reached' using errcode = '23514';
  end if;

  update crm_accounts
     set owner_user_id = v_req.requester_user_id,
         pool_status = 'private',
         protection_until = now() + interval '90 days',
         released_reason = null,
         updated_at = now()
   where id = v_account.id;

  insert into crm_assignments
    (tenant_id, account_id, action, from_user_id, to_user_id,
     from_pool_status, to_pool_status, reason, operated_by)
  values
    (v_tenant, v_account.id, 'claim', v_account.owner_user_id, v_req.requester_user_id,
     'public', 'private', coalesce(v_note, '领用申请通过'), v_user);

  update crm_claim_requests
     set status = 'approved',
         decided_by = v_user,
         decided_at = now(),
         decision_note = v_note
   where id = p_request_id;

  -- 同一客户的其它待审批申请自动取消，避免通过后仍显示可审批
  update crm_claim_requests
     set status = 'cancelled',
         decided_by = v_user,
         decided_at = now(),
         decision_note = '同一客户已有其它申请通过'
   where tenant_id = v_tenant
     and account_id = v_account.id
     and status = 'pending'
     and id <> p_request_id;
end;
$fn$;

revoke all on function app.crm_pool_request_claim(uuid) from public;
revoke all on function app.crm_pool_decide_claim(uuid, boolean, text) from public;

grant execute on function app.crm_pool_request_claim(uuid) to jxf_app;
grant execute on function app.crm_pool_decide_claim(uuid, boolean, text) to jxf_app;
