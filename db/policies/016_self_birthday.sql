-- ============================================================================
-- P1 · 生日自助修改
-- users 表的写入此前只有应用层校验；这里补一个 SECURITY DEFINER 函数，
-- 把「只能改自己 + 必须有有效任用 + 不能填未来日期」下沉到数据库，
-- 避免任何调用方绕过应用层直接改他人档案。
-- 幂等：create or replace
-- ============================================================================

create or replace function app.update_self_birthday(
  p_user_id uuid,
  p_birthday date
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_actor uuid := app.current_user_id();
begin
  if v_actor is null or v_actor <> p_user_id then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  if not app.has_active_membership(p_user_id) then
    raise exception 'membership not found' using errcode = 'P0002';
  end if;

  if p_birthday is not null and p_birthday > current_date then
    raise exception 'invalid birthday' using errcode = '22023';
  end if;

  update users set birthday = p_birthday where id = p_user_id;
end
$fn$;

revoke all on function app.update_self_birthday(uuid, date) from public;
grant execute on function app.update_self_birthday(uuid, date) to jxf_app;
