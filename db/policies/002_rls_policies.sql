-- ============================================================================
-- P1 · RLS 策略（部门模型）
-- 幂等：drop policy if exists → create policy
-- 红线：应用角色 jxf_app 非 owner / 非 superuser；未注入身份时所有策略均不命中
-- ============================================================================

alter table departments        enable row level security;
alter table department_closure enable row level security;
alter table memberships        enable row level security;
alter table department_packs   enable row level security;
alter table audit_events       enable row level security;

-- ---------------------------------------------------------------------------
-- departments：读自身 + 子部门；写要求 L1
-- ---------------------------------------------------------------------------
drop policy if exists departments_read on departments;
create policy departments_read on departments
  for select
  using (
    tenant_id = app.current_tenant_id()
    and app.can_read(id)
  );

drop policy if exists departments_insert on departments;
create policy departments_insert on departments
  for insert
  with check (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
    and (parent_id is null or app.can_read(parent_id))
  );

-- 根节点「老板」不可改名（parent_id is null）；其余部门 L1 在可读子树内可改
drop policy if exists departments_update on departments;
create policy departments_update on departments
  for update
  using (
    app.current_access_level() = 'L1'
    and app.can_read(id)
    and parent_id is not null
  )
  with check (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
    and parent_id is not null
    and app.can_read(parent_id)
  );

-- 根节点（parent_id is null）是系统控制权入口，任何角色都不可删除；
-- 其余部门：L1 可删除自己可读子树内的任意部门（新建时用的是 can_read(parent)，删除对称）
drop policy if exists departments_delete on departments;
create policy departments_delete on departments
  for delete
  using (
    app.current_access_level() = 'L1'
    and parent_id is not null
    and app.can_read(id)
  );

-- ---------------------------------------------------------------------------
-- memberships：读可见部门成员（或本人条目）；写要求 L1
-- 离岗统一走 app.remove_membership()，因此撤销直接 UPDATE / DELETE 权限
-- ---------------------------------------------------------------------------
drop policy if exists memberships_read on memberships;
create policy memberships_read on memberships
  for select
  using (
    tenant_id = app.current_tenant_id()
    and (app.can_read(department_id) or user_id = app.current_user_id())
  );

drop policy if exists memberships_insert on memberships;
create policy memberships_insert on memberships
  for insert
  with check (
    app.current_access_level() = 'L1'
    and tenant_id = app.current_tenant_id()
    and app.can_read(department_id)
  );

revoke update, delete on memberships from jxf_app;

-- ---------------------------------------------------------------------------
-- department_packs：子树可读；只能改自身部门的包
-- ---------------------------------------------------------------------------
drop policy if exists department_packs_read on department_packs;
create policy department_packs_read on department_packs
  for select
  using (app.can_read(department_id));

drop policy if exists department_packs_insert on department_packs;
create policy department_packs_insert on department_packs
  for insert
  with check (app.current_access_level() = 'L1' and app.can_write(department_id));

drop policy if exists department_packs_update on department_packs;
create policy department_packs_update on department_packs
  for update
  using (app.can_write(department_id))
  with check (app.can_write(department_id));

drop policy if exists department_packs_delete on department_packs;
create policy department_packs_delete on department_packs
  for delete
  using (app.can_write(department_id));

-- ---------------------------------------------------------------------------
-- department_closure：应用角色不可直接读写；仅能通过 SECURITY DEFINER 函数间接使用
-- ---------------------------------------------------------------------------
revoke all on department_closure from jxf_app;
