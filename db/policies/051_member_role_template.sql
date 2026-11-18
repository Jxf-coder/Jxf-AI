-- 051 成员专用角色模板
--
-- memberships 对 jxf_app 撤销了 UPDATE，因此切换模板必须走 SECURITY DEFINER 函数。
-- 规则：
--   - 仅 L1 可以给成员套用 / 移除专用模板
--   - 模板等级必须与成员等级一致（等级上限仍由模板自身的 beyond_level_ceiling 决定）
--   - L1 固定使用隐式全量权限，不允许挂模板
--   - 变更后同步 bump permission_revision，下一次请求即按新模板解析

create or replace function app.set_member_role_template(
  p_membership_id uuid,
  p_template_key text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tenant uuid := app.current_tenant_id();
  v_membership record;
  v_template record;
  v_key text := nullif(btrim(coalesce(p_template_key, '')), '');
begin
  if app.current_user_id() is null or v_tenant is null then
    raise exception 'missing identity' using errcode = '42501';
  end if;
  if coalesce(app.current_access_level(), '') <> 'L1' then
    raise exception 'only L1 can assign role templates' using errcode = '42501';
  end if;

  select m.id, m.user_id, m.access_level
    into v_membership
    from memberships m
   where m.id = p_membership_id
     and m.tenant_id = v_tenant
     and m.status = 'active';
  if not found then
    raise exception 'membership not found' using errcode = 'P0002';
  end if;
  if v_membership.access_level = 'L1' then
    raise exception 'L1 uses implicit full permissions' using errcode = '22023';
  end if;

  if v_key is null then
    update memberships set role_template_key = null where id = v_membership.id;
  else
    select t.id, t.level
      into v_template
      from role_templates t
     where t.id = v_key;
    if not found then
      raise exception 'template not found' using errcode = 'P0002';
    end if;
    if v_template.level <> v_membership.access_level then
      raise exception 'template level mismatch' using errcode = '22023';
    end if;
    update memberships set role_template_key = v_template.id where id = v_membership.id;
  end if;

  return v_membership.user_id;
end;
$fn$;

revoke all on function app.set_member_role_template(uuid, text) from public;
grant execute on function app.set_member_role_template(uuid, text) to jxf_app;
