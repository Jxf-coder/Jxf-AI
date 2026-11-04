-- ============================================================================
-- P1 · 个人资料：业务岗位 / 所属部门 / 权限等级 更新
-- memberships 的 UPDATE 已对应用角色撤销，统一走 SECURITY DEFINER 函数：
--   · 业务岗位：L1 可改所有人；L2 仅可改下级 L3（不能改自己或同级 L2）；L3 只读
--   · 所属部门 / 权限等级：仅 L1
--   · 不允许把最后一位 L1 降级
-- 幂等：create or replace，可重复执行
-- ============================================================================

create or replace function app.update_membership_profile(
  p_membership_id uuid,
  p_title text,
  p_department_id uuid,
  p_access_level text
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
  v_tenant_id uuid;
  v_new_level access_level;
begin
  select m.department_id, m.user_id, m.access_level, m.tenant_id
    into v_department_id, v_target_user, v_target_level, v_tenant_id
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

  -- 业务岗位
  if p_title is not null then
    if char_length(btrim(p_title)) = 0 or char_length(p_title) > 40 then
      raise exception 'invalid title' using errcode = '22023';
    end if;

    if v_actor_level = 'L1' then
      null;
    elsif v_actor_level = 'L2' and v_target_level = 'L3' and v_target_user <> v_actor_id
          and app.can_write(v_department_id) then
      null;
    else
      raise exception 'permission denied' using errcode = '42501';
    end if;

    update memberships set title = btrim(p_title) where id = p_membership_id;
  end if;

  -- 所属部门 / 权限等级：仅 L1
  if p_department_id is not null or p_access_level is not null then
    if v_actor_level <> 'L1' then
      raise exception 'permission denied' using errcode = '42501';
    end if;

    if p_department_id is not null and not app.can_read(p_department_id) then
      raise exception 'permission denied' using errcode = '42501';
    end if;

    if p_access_level is not null then
      if p_access_level not in ('L1', 'L2', 'L3') then
        raise exception 'invalid access level' using errcode = '22023';
      end if;
      v_new_level := p_access_level::access_level;

      if v_target_level = 'L1' and v_new_level <> 'L1' then
        if not exists (
          select 1 from memberships m
           where m.tenant_id = v_tenant_id
             and m.status = 'active'
             and m.access_level = 'L1'
             and m.id <> p_membership_id
        ) then
          raise exception 'cannot demote the last L1' using errcode = '23514';
        end if;
      end if;
    end if;

    update memberships
       set department_id = coalesce(p_department_id, department_id),
           access_level = coalesce(v_new_level, access_level)
     where id = p_membership_id;
  end if;
end
$fn$;

revoke all on function app.update_membership_profile(uuid, text, uuid, text) from public;
grant execute on function app.update_membership_profile(uuid, text, uuid, text) to jxf_app;

-- ---------------------------------------------------------------------------
-- 数据修复：为已有邮箱身份补齐「默认主邮箱」
-- 历史数据（seed / 早期添加成员）只写邮箱未标记 is_primary，这里把每人最早的
-- 一个邮箱补为主邮箱；已是主邮箱的用户不会重复处理（幂等）。
-- ---------------------------------------------------------------------------
with first_identity as (
  select distinct on (user_id) id, user_id
    from user_email_identities
   order by user_id, created_at, id
)
update user_email_identities i
   set is_primary = true
  from first_identity f
 where i.id = f.id
   and not exists (
     select 1 from user_email_identities p
      where p.user_id = f.user_id and p.is_primary
   );

-- 仅有 users.email 但没有身份记录的历史账号，补一条主邮箱身份
insert into user_email_identities (tenant_id, user_id, email, is_primary)
select t.tenant_id, u.id, u.email, true
  from users u
  cross join (select tenant_id from departments order by created_at limit 1) t
 where u.email is not null
   and not exists (select 1 from user_email_identities i where i.user_id = u.id)
on conflict do nothing;
