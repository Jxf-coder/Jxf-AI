-- ============================================================================
-- P6 · 权限管理写入函数
-- 目的：
--   · 授权表仍然对 jxf_app 撤销 INSERT / UPDATE / DELETE
--   · 所有授权变更只能通过 SECURITY DEFINER 函数完成
--   · 每次变更同步 bump permission_revisions，让下一次请求拿到新快照
-- 幂等：create or replace
-- ============================================================================

-- 版本号自增：快照失效的唯一依据
create or replace function app.bump_permission_revision(p_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_version bigint;
begin
  insert into permission_revisions (user_id, version)
  values (p_user_id, 1)
  on conflict (user_id) do update
    set version = permission_revisions.version + 1,
        updated_at = now()
  returning version into v_version;

  return v_version;
end
$fn$;

-- 覆盖某个成员的授权行；p_grants = [{ permissionKey, scope, effect }]
create or replace function app.save_user_permission_grants(
  p_target_user_id uuid,
  p_scope_department_id uuid,
  p_grants jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_grant jsonb;
  v_key text;
  v_scope text;
  v_effect text;
  v_version bigint;
begin
  if coalesce(app.current_access_level(), '') <> 'L1' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from memberships m
     where m.user_id = p_target_user_id
       and m.tenant_id = app.current_tenant_id()
       and m.status = 'active'
  ) then
    raise exception 'target user not found' using errcode = 'P0002';
  end if;

  if jsonb_typeof(coalesce(p_grants, '[]'::jsonb)) <> 'array' then
    raise exception 'grants must be an array' using errcode = '22023';
  end if;

  delete from user_permission_grants
   where tenant_id = app.current_tenant_id()
     and user_id = p_target_user_id;

  for v_grant in select * from jsonb_array_elements(coalesce(p_grants, '[]'::jsonb))
  loop
    v_key := nullif(btrim(v_grant ->> 'permissionKey'), '');
    v_scope := v_grant ->> 'scope';
    v_effect := coalesce(nullif(v_grant ->> 'effect', ''), 'allow');

    if v_key is null then
      raise exception 'permission key required' using errcode = '22023';
    end if;
    if v_scope not in ('ALL', 'DEPT_TREE', 'DEPT', 'SELF') then
      raise exception 'invalid scope: %', v_scope using errcode = '22023';
    end if;
    if v_effect not in ('allow', 'deny') then
      raise exception 'invalid effect: %', v_effect using errcode = '22023';
    end if;
    if v_scope in ('DEPT', 'DEPT_TREE') and p_scope_department_id is null then
      raise exception 'scope department required' using errcode = '22023';
    end if;

    insert into user_permission_grants (
      tenant_id, user_id, permission_key, scope_type, scope_id, effect, granted_by, updated_at
    )
    values (
      app.current_tenant_id(),
      p_target_user_id,
      v_key,
      v_scope,
      case when v_scope in ('DEPT', 'DEPT_TREE') then p_scope_department_id else null end,
      v_effect,
      app.current_user_id(),
      now()
    )
    on conflict (tenant_id, user_id, permission_key) do update
      set scope_type = excluded.scope_type,
          scope_id = excluded.scope_id,
          effect = excluded.effect,
          granted_by = excluded.granted_by,
          updated_at = now();
  end loop;

  v_version := app.bump_permission_revision(p_target_user_id);
  return v_version;
end
$fn$;

-- 恢复成员默认：清空个人覆盖，回到角色模板
create or replace function app.clear_user_permission_grants(p_target_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_version bigint;
begin
  if coalesce(app.current_access_level(), '') <> 'L1' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from memberships m
     where m.user_id = p_target_user_id
       and m.tenant_id = app.current_tenant_id()
       and m.status = 'active'
  ) then
    raise exception 'target user not found' using errcode = 'P0002';
  end if;

  delete from user_permission_grants
   where tenant_id = app.current_tenant_id()
     and user_id = p_target_user_id;

  v_version := app.bump_permission_revision(p_target_user_id);
  return v_version;
end
$fn$;

-- 覆盖某个角色模板的授权行；L1 模板是隐式全量，不允许改
create or replace function app.save_role_template_grants(
  p_template_id text,
  p_grants jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_level access_level;
  v_grant jsonb;
  v_key text;
  v_scope text;
  v_effect text;
  v_count integer;
begin
  if coalesce(app.current_access_level(), '') <> 'L1' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  select level into v_level from role_templates where id = p_template_id;
  if not found then
    raise exception 'template not found' using errcode = 'P0002';
  end if;
  if v_level = 'L1' then
    raise exception 'L1 template is implicit' using errcode = '22023';
  end if;

  if jsonb_typeof(coalesce(p_grants, '[]'::jsonb)) <> 'array' then
    raise exception 'grants must be an array' using errcode = '22023';
  end if;

  delete from role_template_grants where template_id = p_template_id;

  for v_grant in select * from jsonb_array_elements(coalesce(p_grants, '[]'::jsonb))
  loop
    v_key := nullif(btrim(v_grant ->> 'permissionKey'), '');
    v_scope := v_grant ->> 'scope';
    v_effect := coalesce(nullif(v_grant ->> 'effect', ''), 'allow');

    if v_key is null then
      raise exception 'permission key required' using errcode = '22023';
    end if;
    if v_scope not in ('ALL', 'DEPT_TREE', 'DEPT', 'SELF') then
      raise exception 'invalid scope: %', v_scope using errcode = '22023';
    end if;
    if v_effect not in ('allow', 'deny') then
      raise exception 'invalid effect: %', v_effect using errcode = '22023';
    end if;

    insert into role_template_grants (template_id, permission_key, scope_type, effect, updated_at)
    values (p_template_id, v_key, v_scope, v_effect, now())
    on conflict (template_id, permission_key) do update
      set scope_type = excluded.scope_type,
          effect = excluded.effect,
          updated_at = now();
  end loop;

  v_count := jsonb_array_length(coalesce(p_grants, '[]'::jsonb));

  -- 模板变更影响该等级所有有效任用成员
  insert into permission_revisions (user_id, version)
  select distinct m.user_id, 1
    from memberships m
   where m.status = 'active'
     and m.access_level = v_level
  on conflict (user_id) do update
    set version = permission_revisions.version + 1,
        updated_at = now();

  return v_count;
end
$fn$;

revoke all on function app.bump_permission_revision(uuid) from public;
revoke all on function app.save_user_permission_grants(uuid, uuid, jsonb) from public;
revoke all on function app.clear_user_permission_grants(uuid) from public;
revoke all on function app.save_role_template_grants(text, jsonb) from public;

grant execute on function app.bump_permission_revision(uuid) to jxf_app;
grant execute on function app.save_user_permission_grants(uuid, uuid, jsonb) to jxf_app;
grant execute on function app.clear_user_permission_grants(uuid) to jxf_app;
grant execute on function app.save_role_template_grants(text, jsonb) to jxf_app;
