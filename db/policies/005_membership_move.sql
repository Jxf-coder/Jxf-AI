-- ============================================================================
-- P1 · 组织架构拖拽：成员跨部门调整
-- memberships 的 UPDATE 已对应用角色撤销，换部门统一走 SECURITY DEFINER 函数，
-- 以避免放开整表 UPDATE 权限；仅 L1 可操作，且源/目标部门都必须在可读子树内。
-- 幂等：create or replace，可重复执行
-- ============================================================================

create or replace function app.move_membership(
  p_membership_id uuid,
  p_target_department_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_department_id uuid;
begin
  if coalesce(app.current_access_level(), '') <> 'L1' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  select m.department_id
    into v_department_id
    from memberships m
   where m.id = p_membership_id
     and m.status = 'active'
   for update;

  if not found then
    raise exception 'membership not found' using errcode = 'P0002';
  end if;

  if not app.can_read(v_department_id) or not app.can_read(p_target_department_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  -- 部门未变化时直接返回，避免无意义的行更新
  if v_department_id = p_target_department_id then
    return;
  end if;

  update memberships
     set department_id = p_target_department_id
   where id = p_membership_id;
end
$fn$;

revoke all on function app.move_membership(uuid, uuid) from public;
grant execute on function app.move_membership(uuid, uuid) to jxf_app;
