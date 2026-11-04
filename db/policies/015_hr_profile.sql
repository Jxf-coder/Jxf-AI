-- ============================================================================
-- Step 2 · HR 基础资料扩展 + 审批单转交
--
-- 1. 工号序列：留空时由系统自动生成 JXF-0001 形式工号
-- 2. app.update_member_hr_profile：更新工号 / 入职日期 / 岗位（memberships 写权限已收口）
-- 3. app.reassign_pending_approvals：员工停用前，把其待处理审批单转交给临时接管人
--
-- 幂等：create sequence if not exists / create or replace
-- ============================================================================

create sequence if not exists employee_no_seq start with 1 increment by 1;
grant usage, select on sequence employee_no_seq to jxf_app;

-- ---------------------------------------------------------------------------
-- HR 档案字段更新（工号 / 入职日期 / 岗位）
-- 权限与业务岗位一致：L1 可改所有人；L2 仅可改下级 L3；L3 只读
-- ---------------------------------------------------------------------------
create or replace function app.update_member_hr_profile(
  p_membership_id uuid,
  p_employee_no text,
  p_hire_date date,
  p_position text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor_level text := coalesce(app.current_access_level(), '');
  v_actor_id uuid := app.current_user_id();
  v_department_id uuid;
  v_target_user uuid;
  v_target_level access_level;
begin
  select m.department_id, m.user_id, m.access_level
    into v_department_id, v_target_user, v_target_level
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

  if v_actor_level = 'L1' then
    null;
  elsif v_actor_level = 'L2' and v_target_level = 'L3' and v_target_user <> v_actor_id
        and app.can_write(v_department_id) then
    null;
  else
    raise exception 'permission denied' using errcode = '42501';
  end if;

  if p_employee_no is not null then
    if char_length(btrim(p_employee_no)) > 32 then
      raise exception 'invalid employee no' using errcode = '22023';
    end if;
    update memberships
       set employee_no = nullif(btrim(p_employee_no), '')
     where id = p_membership_id;
  end if;

  if p_hire_date is not null then
    update memberships
       set hire_date = p_hire_date
     where id = p_membership_id;
  end if;

  if p_position is not null then
    if char_length(btrim(p_position)) > 40 then
      raise exception 'invalid position' using errcode = '22023';
    end if;
    -- position 为 HR 岗位字段；title 同步更新，兼容组织架构 / 审批中心既有展示
    update memberships
       set position = nullif(btrim(p_position), ''),
           title = coalesce(nullif(btrim(p_position), ''), title)
     where id = p_membership_id;
  end if;
end
$fn$;

revoke all on function app.update_member_hr_profile(uuid, text, date, text) from public;
grant execute on function app.update_member_hr_profile(uuid, text, date, text) to jxf_app;

-- ---------------------------------------------------------------------------
-- 待处理审批单转交：员工停用前指定临时接管人，避免审批流悬挂
-- 仅 L1 可执行；目标必须是本租户在职成员
-- ---------------------------------------------------------------------------
create or replace function app.reassign_pending_approvals(
  p_from_user_id uuid,
  p_to_user_id uuid
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_count integer;
begin
  if coalesce(app.current_access_level(), '') <> 'L1' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  if p_from_user_id = p_to_user_id then
    raise exception 'cannot reassign to the same user' using errcode = '22023';
  end if;

  if not exists (
    select 1 from memberships m
     where m.user_id = p_to_user_id
       and m.tenant_id = app.current_tenant_id()
       and m.status = 'active'
  ) then
    raise exception 'target user is not active' using errcode = 'P0002';
  end if;

  update approval_requests
     set requester_id = p_to_user_id
   where tenant_id = app.current_tenant_id()
     and requester_id = p_from_user_id
     and status = 'pending';

  get diagnostics v_count = row_count;
  return v_count;
end
$fn$;

revoke all on function app.reassign_pending_approvals(uuid, uuid) from public;
grant execute on function app.reassign_pending_approvals(uuid, uuid) to jxf_app;
