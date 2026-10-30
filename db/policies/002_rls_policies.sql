-- ============================================================================
-- P1 · RLS 策略（幂等：drop policy if exists → create policy）
-- 红线：应用角色 jxf_app 非 owner / 非 superuser；未注入身份时所有策略均不命中
-- ============================================================================

alter table roles         enable row level security;
alter table role_closure  enable row level security;
alter table memberships   enable row level security;
alter table role_packs    enable row level security;
alter table audit_events  enable row level security;

-- ---------------------------------------------------------------------------
-- roles：读自身 + 子孙；写要求 L1
-- ---------------------------------------------------------------------------
drop policy if exists roles_read on roles;
create policy roles_read on roles
  for select
  using (
    tenant_id = app.current_tenant_id()
    and app.can_read(id)
  );

drop policy if exists roles_insert on roles;
create policy roles_insert on roles
  for insert
  with check (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
    and (parent_id is null or app.can_read(parent_id))
  );

drop policy if exists roles_update on roles;
create policy roles_update on roles
  for update
  using (app.current_access_level() = 'L1' and app.can_write(id))
  with check (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
    and (parent_id is null or app.can_read(parent_id))
  );

drop policy if exists roles_delete on roles;
create policy roles_delete on roles
  for delete
  using (app.current_access_level() = 'L1' and app.can_write(id));

-- ---------------------------------------------------------------------------
-- memberships：读自身岗位成员（或本人条目）；写要求 L1
-- 更新 / 删除通过 app.remove_membership() 收口，因此撤销直接 UPDATE / DELETE 权限
-- ---------------------------------------------------------------------------
drop policy if exists memberships_read on memberships;
create policy memberships_read on memberships
  for select
  using (
    tenant_id = app.current_tenant_id()
    and (app.can_read(role_id) or user_id = app.current_user_id())
  );

drop policy if exists memberships_insert on memberships;
create policy memberships_insert on memberships
  for insert
  with check (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
    and app.can_read(role_id)
  );

drop policy if exists memberships_update on memberships;
create policy memberships_update on memberships
  for update
  using (app.current_access_level() = 'L1' and app.can_read(role_id))
  with check (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
    and app.can_read(role_id)
  );

drop policy if exists memberships_delete on memberships;
create policy memberships_delete on memberships
  for delete
  using (app.current_access_level() = 'L1' and app.can_read(role_id));

revoke update, delete on memberships from jxf_app;

-- ---------------------------------------------------------------------------
-- role_packs：子树可读；只能改自己岗位的包
-- ---------------------------------------------------------------------------
drop policy if exists role_packs_read on role_packs;
create policy role_packs_read on role_packs
  for select
  using (app.can_read(role_id));

drop policy if exists role_packs_insert on role_packs;
create policy role_packs_insert on role_packs
  for insert
  with check (app.current_access_level() = 'L1' and app.can_write(role_id));

drop policy if exists role_packs_update on role_packs;
create policy role_packs_update on role_packs
  for update
  using (app.can_write(role_id))
  with check (app.can_write(role_id));

drop policy if exists role_packs_delete on role_packs;
create policy role_packs_delete on role_packs
  for delete
  using (app.can_write(role_id));

-- ---------------------------------------------------------------------------
-- role_closure：应用角色不可直接读写；仅能通过 SECURITY DEFINER 函数间接使用
-- ---------------------------------------------------------------------------
revoke all on role_closure from jxf_app;
