-- ============================================================================
-- P7 · 离职交接（Pending Handover）状态机
--
-- 流程：
--   1. L1 预检发现成员仍有资产 → 逐类指定接收人
--   2. app.create_membership_removal_request：生成审批单 + 交接明细，
--      任用 active → pending_removal，用户 active → pending_handover（会话立即失效）
--   3. L1 在审批中心通过 / 驳回 / 撤回
--      通过：明细标记已转移 → 任用 removed → 用户 disabled
--      驳回 / 撤回：任用恢复 active → 用户恢复 active
--
-- 约束：
--   · 只有 L1 可发起与审批（与 RLS 011 一致）
--   · 同一任用同时只允许一条 pending 审批（部分唯一索引）
--   · 最后一位 L1 不可移出
--   · 所有写入走 SECURITY DEFINER，应用角色无直写权限
-- 幂等：create or replace / if not exists，可重复执行
-- ============================================================================

-- 同一主体（任用）同时只能有一条待审批记录
create unique index if not exists approval_requests_pending_subject_uidx
  on approval_requests (subject_type, subject_id)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- 发起移出审批
-- p_handover: [{ "assetType": "knowledge", "assetId": "...", "toUserId": "..." }]
-- ---------------------------------------------------------------------------
create or replace function app.create_membership_removal_request(
  p_membership_id uuid,
  p_handover jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tenant_id uuid;
  v_department_id uuid;
  v_user_id uuid;
  v_level access_level;
  v_request_id uuid;
  v_item jsonb;
begin
  if coalesce(app.current_access_level(), '') <> 'L1' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  if p_handover is null or jsonb_typeof(p_handover) <> 'array' then
    raise exception 'handover must be a json array' using errcode = '22023';
  end if;

  -- 先判断是否已有待审批单：此时任用已进入 pending_removal，不能再按 active 查询
  if exists (
    select 1
      from approval_requests ar
     where ar.tenant_id = app.current_tenant_id()
       and ar.subject_type = 'membership'
       and ar.subject_id = p_membership_id
       and ar.status = 'pending'
  ) then
    raise exception 'removal already requested' using errcode = '23505';
  end if;

  select m.tenant_id, m.department_id, m.user_id, m.access_level
    into v_tenant_id, v_department_id, v_user_id, v_level
    from memberships m
   where m.id = p_membership_id
     and m.status = 'active'
   for update;

  if not found then
    raise exception 'membership not found' using errcode = 'P0002';
  end if;

  if not app.can_read(v_department_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  if v_level = 'L1' then
    if not exists (
      select 1 from memberships m
       where m.tenant_id = v_tenant_id
         and m.status = 'active'
         and m.access_level = 'L1'
         and m.id <> p_membership_id
    ) then
      raise exception 'cannot remove the last L1' using errcode = '23514';
    end if;
  end if;

  insert into approval_requests
    (tenant_id, type, subject_type, subject_id, requester_id, status, payload)
  values
    (v_tenant_id, 'membership_removal', 'membership', p_membership_id,
     app.current_user_id(), 'pending',
     jsonb_build_object('departmentId', v_department_id, 'accessLevel', v_level))
  returning id into v_request_id;

  for v_item in select value from jsonb_array_elements(p_handover)
  loop
    if coalesce(v_item->>'assetType', '') = ''
       or coalesce(v_item->>'assetId', '') = ''
       or coalesce(v_item->>'toUserId', '') = '' then
      raise exception 'invalid handover item' using errcode = '22023';
    end if;

    if (v_item->>'toUserId')::uuid = v_user_id then
      raise exception 'cannot hand over to the leaving member' using errcode = '22023';
    end if;

    insert into handover_items
      (approval_id, asset_type, asset_id, from_user_id, to_user_id)
    values
      (v_request_id, v_item->>'assetType', v_item->>'assetId', v_user_id,
       (v_item->>'toUserId')::uuid);
  end loop;

  update memberships
     set status = 'pending_removal'
   where id = p_membership_id;

  -- 只有该用户不再拥有其他 active 任用时才冻结账号，避免多任用用户被误锁
  update users u
     set status = 'pending_handover'
   where u.id = v_user_id
     and u.status = 'active'
     and not exists (
       select 1 from memberships m2
        where m2.user_id = v_user_id
          and m2.status = 'active'
     );

  return v_request_id;
end
$fn$;

-- ---------------------------------------------------------------------------
-- 审批通过：资产明细标记已转移 → 任用 removed → 用户 disabled
-- ---------------------------------------------------------------------------
create or replace function app.approve_membership_removal(p_approval_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tenant_id uuid;
  v_subject_id uuid;
  v_requester_id uuid;
  v_user_id uuid;
  v_department_id uuid;
begin
  if coalesce(app.current_access_level(), '') <> 'L1' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  select ar.tenant_id, ar.subject_id, ar.requester_id
    into v_tenant_id, v_subject_id, v_requester_id
    from approval_requests ar
   where ar.id = p_approval_id
     and ar.type = 'membership_removal'
     and ar.status = 'pending'
   for update;

  if not found then
    raise exception 'approval not pending' using errcode = 'P0002';
  end if;

  select m.user_id, m.department_id
    into v_user_id, v_department_id
    from memberships m
   where m.id = v_subject_id
     and m.status = 'pending_removal'
   for update;

  if not found then
    raise exception 'membership not pending removal' using errcode = 'P0002';
  end if;

  update handover_items
     set transferred_at = now()
   where approval_id = p_approval_id
     and transferred_at is null;

  update memberships
     set status = 'removed', removed_at = now()
   where id = v_subject_id;

  update users u
     set status = 'disabled'
   where u.id = v_user_id
     and not exists (
       select 1 from memberships m2
        where m2.user_id = v_user_id
          and m2.status = 'active'
     );

  update approval_requests
     set status = 'approved',
         decided_at = now(),
         decided_by = app.current_user_id()
   where id = p_approval_id;

  return jsonb_build_object(
    'approvalId', p_approval_id,
    'membershipId', v_subject_id,
    'userId', v_user_id,
    'departmentId', v_department_id,
    'requesterId', v_requester_id
  );
end
$fn$;

-- ---------------------------------------------------------------------------
-- 驳回：还原任用与账号，保留审批记录（含驳回原因）
-- ---------------------------------------------------------------------------
create or replace function app.reject_membership_removal(
  p_approval_id uuid,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_subject_id uuid;
  v_user_id uuid;
  v_department_id uuid;
begin
  if coalesce(app.current_access_level(), '') <> 'L1' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  select ar.subject_id into v_subject_id
    from approval_requests ar
   where ar.id = p_approval_id
     and ar.type = 'membership_removal'
     and ar.status = 'pending'
   for update;

  if not found then
    raise exception 'approval not pending' using errcode = 'P0002';
  end if;

  select m.user_id, m.department_id
    into v_user_id, v_department_id
    from memberships m
   where m.id = v_subject_id
   for update;

  update memberships
     set status = 'active'
   where id = v_subject_id
     and status = 'pending_removal';

  update users u
     set status = 'active'
   where u.id = v_user_id
     and u.status = 'pending_handover';

  -- 未转移的交接明细直接作废，避免下次审批误带旧资产
  delete from handover_items
   where approval_id = p_approval_id
     and transferred_at is null;

  update approval_requests
     set status = 'rejected',
         decided_at = now(),
         decided_by = app.current_user_id(),
         payload = payload || jsonb_build_object('reason', coalesce(p_reason, ''))
   where id = p_approval_id;

  return jsonb_build_object(
    'approvalId', p_approval_id,
    'membershipId', v_subject_id,
    'userId', v_user_id,
    'departmentId', v_department_id
  );
end
$fn$;

-- ---------------------------------------------------------------------------
-- 撤回：申请人或 L1 可撤回待审批申请，状态回滚
-- ---------------------------------------------------------------------------
create or replace function app.cancel_membership_removal(p_approval_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_subject_id uuid;
  v_requester_id uuid;
  v_user_id uuid;
  v_department_id uuid;
begin
  select ar.subject_id, ar.requester_id
    into v_subject_id, v_requester_id
    from approval_requests ar
   where ar.id = p_approval_id
     and ar.type = 'membership_removal'
     and ar.status = 'pending'
   for update;

  if not found then
    raise exception 'approval not pending' using errcode = 'P0002';
  end if;

  if coalesce(app.current_access_level(), '') <> 'L1'
     and v_requester_id <> app.current_user_id() then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  select m.user_id, m.department_id
    into v_user_id, v_department_id
    from memberships m
   where m.id = v_subject_id
   for update;

  update memberships
     set status = 'active'
   where id = v_subject_id
     and status = 'pending_removal';

  update users u
     set status = 'active'
   where u.id = v_user_id
     and u.status = 'pending_handover';

  delete from handover_items
   where approval_id = p_approval_id
     and transferred_at is null;

  update approval_requests
     set status = 'cancelled',
         decided_at = now(),
         decided_by = app.current_user_id()
   where id = p_approval_id;

  return jsonb_build_object(
    'approvalId', p_approval_id,
    'membershipId', v_subject_id,
    'userId', v_user_id,
    'departmentId', v_department_id
  );
end
$fn$;

-- ---------------------------------------------------------------------------
-- 顶栏待审批数量（非 L1 恒为 0）
-- ---------------------------------------------------------------------------
create or replace function app.pending_approval_count()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
    when coalesce(app.current_access_level(), '') = 'L1' then (
      select count(*)::int
        from approval_requests ar
       where ar.tenant_id = app.current_tenant_id()
         and ar.type = 'membership_removal'
         and ar.status = 'pending'
    )
    else 0
  end
$fn$;

revoke all on function app.create_membership_removal_request(uuid, jsonb) from public;
revoke all on function app.approve_membership_removal(uuid) from public;
revoke all on function app.reject_membership_removal(uuid, text) from public;
revoke all on function app.cancel_membership_removal(uuid) from public;
revoke all on function app.pending_approval_count() from public;

grant execute on function app.create_membership_removal_request(uuid, jsonb) to jxf_app;
grant execute on function app.approve_membership_removal(uuid) to jxf_app;
grant execute on function app.reject_membership_removal(uuid, text) to jxf_app;
grant execute on function app.cancel_membership_removal(uuid) to jxf_app;
grant execute on function app.pending_approval_count() to jxf_app;
