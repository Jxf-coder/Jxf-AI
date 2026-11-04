-- ============================================================================
-- P1 · 成员重新激活（软删除恢复）
-- memberships 的 UPDATE 已对应用角色撤销，恢复统一走 SECURITY DEFINER 函数；
-- 仅 L1 可在可读子树内恢复，且不会产生任何物理删除。
-- 幂等：create or replace，可重复执行
-- ============================================================================

create or replace function app.restore_membership(p_membership_id uuid) returns void
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
     and m.status = 'removed'
   for update;

  if not found then
    raise exception 'membership not found' using errcode = 'P0002';
  end if;

  if not app.can_read(v_department_id) then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  update memberships
     set status = 'active',
         removed_at = null
   where id = p_membership_id;
end
$fn$;

revoke all on function app.restore_membership(uuid) from public;
grant execute on function app.restore_membership(uuid) to jxf_app;
