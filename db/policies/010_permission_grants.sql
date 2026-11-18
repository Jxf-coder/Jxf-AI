-- ============================================================================
-- 权限系统 · 授权表 RLS 与系统角色模板
-- 幂等：drop policy if exists → create policy；模板用 on conflict 更新
-- 红线：
--   · 普通成员只能读自己的授权，L1 可读全部
--   · 授权表禁止应用角色直接 INSERT / UPDATE / DELETE（后续走 SECURITY DEFINER 函数）
--   · 财务 / 教学 / CRM 本轮不写入任何节点
-- ============================================================================

alter table role_templates           enable row level security;
alter table role_template_grants     enable row level security;
alter table user_permission_grants   enable row level security;
alter table permission_revisions     enable row level security;

-- ---------------------------------------------------------------------------
-- role_templates：系统模板全员可读，只有 L1 可改
-- ---------------------------------------------------------------------------
drop policy if exists role_templates_read on role_templates;
create policy role_templates_read on role_templates
  for select
  using (app.current_user_id() is not null);

drop policy if exists role_templates_write on role_templates;
create policy role_templates_write on role_templates
  for all
  using (app.current_access_level() = 'L1')
  with check (app.current_access_level() = 'L1');

-- ---------------------------------------------------------------------------
-- role_template_grants：全员可读，只有 L1 可改
-- ---------------------------------------------------------------------------
drop policy if exists role_template_grants_read on role_template_grants;
create policy role_template_grants_read on role_template_grants
  for select
  using (app.current_user_id() is not null);

drop policy if exists role_template_grants_write on role_template_grants;
create policy role_template_grants_write on role_template_grants
  for all
  using (app.current_access_level() = 'L1')
  with check (app.current_access_level() = 'L1');

-- ---------------------------------------------------------------------------
-- user_permission_grants：本人或 L1 可读；写入只走函数
-- ---------------------------------------------------------------------------
drop policy if exists user_permission_grants_read on user_permission_grants;
create policy user_permission_grants_read on user_permission_grants
  for select
  using (
    tenant_id = app.current_tenant_id()
    and (
      user_id = app.current_user_id()
      or app.current_access_level() = 'L1'
    )
  );

revoke insert, update, delete on user_permission_grants from jxf_app;

-- ---------------------------------------------------------------------------
-- permission_revisions：本人或 L1 可读；写入只走函数
-- ---------------------------------------------------------------------------
drop policy if exists permission_revisions_read on permission_revisions;
create policy permission_revisions_read on permission_revisions
  for select
  using (
    user_id = app.current_user_id()
    or app.current_access_level() = 'L1'
  );

revoke insert, update, delete on permission_revisions from jxf_app;

-- ---------------------------------------------------------------------------
-- 系统模板：L1 / L2 / L3
-- 说明：这里只写系统默认模板；成员级覆盖写 user_permission_grants。
-- ---------------------------------------------------------------------------
insert into role_templates (id, name, level, is_system, sort_order, beyond_level_ceiling)
values
  ('l1', 'L1 老板', 'L1', true, 10, false),
  ('l2', 'L2 部门管理者', 'L2', true, 20, false),
  ('l3', 'L3 普通成员', 'L3', true, 30, false),
  ('fd', 'Finance_Director 财务总监', 'L2', true, 40, true)
on conflict (id) do update
  set name = excluded.name,
      level = excluded.level,
      is_system = excluded.is_system,
      sort_order = excluded.sort_order,
      beyond_level_ceiling = excluded.beyond_level_ceiling;

-- L1：全部非保护区节点
insert into role_template_grants (template_id, permission_key, scope_type, effect)
values
  ('l1', 'member:view', 'ALL', 'allow'),
  ('l1', 'member:profile', 'DEPT', 'allow'),
  ('l1', 'member:manage', 'DEPT', 'allow'),
  ('l1', 'member:level', 'DEPT', 'allow'),
  ('l1', 'member:ssh', 'DEPT', 'allow'),
  ('l1', 'org:view', 'ALL', 'allow'),
  ('l1', 'org:manage', 'DEPT', 'allow'),
  ('l1', 'org:grant', 'DEPT', 'allow'),
  ('l1', 'skill:use', 'ALL', 'allow'),
  ('l1', 'skill:edit', 'ALL', 'allow'),
  ('l1', 'skill:publish', 'ALL', 'allow'),
  ('l1', 'skill:create', 'ALL', 'allow'),
  ('l1', 'pipeline:use', 'ALL', 'allow'),
  ('l1', 'pipeline:manage', 'ALL', 'allow'),
  ('l1', 'knowledge:read', 'ALL', 'allow'),
  ('l1', 'knowledge:write', 'DEPT', 'allow'),
  ('l1', 'knowledge:confirm', 'DEPT', 'allow'),
  ('l1', 'knowledge:export', 'DEPT', 'allow'),
  ('l1', 'token:issue', 'ALL', 'allow'),
  ('l1', 'token:revoke', 'ALL', 'allow'),
  ('l1', 'audit:read', 'ALL', 'allow'),
  ('l1', 'platform:settings', 'ALL', 'allow'),
  ('l1', 'platform:tenant', 'ALL', 'allow'),
  ('l1', 'profile:view_self', 'SELF', 'allow'),
  ('l1', 'profile:edit_self', 'SELF', 'allow'),
  ('l1', 'crm:read', 'ALL', 'allow'),
  ('l1', 'crm:write', 'DEPT', 'allow'),
  ('l1', 'crm:assign', 'DEPT', 'allow'),
  ('l1', 'crm:claim', 'SELF', 'allow'),
  ('l1', 'crm:merge', 'DEPT', 'allow'),
  ('l1', 'crm:import', 'DEPT', 'allow'),
  ('l1', 'crm:export', 'DEPT', 'allow'),
  ('l1', 'crm:pool_policy', 'DEPT', 'allow'),
  ('l1', 'crm:holder_cap', 'DEPT', 'allow'),
  ('l1', 'crm:dict_manage', 'DEPT', 'allow'),
  ('l1', 'crm:reminder_read', 'ALL', 'allow'),
  ('l1', 'crm:reminder_urge', 'DEPT', 'allow'),
  ('l1', 'crm:reminder_manage', 'DEPT', 'allow'),
  ('l1', 'crm:alert_close', 'ALL', 'allow'),
  ('l1', 'crm:complaint_manage', 'DEPT', 'allow'),
  ('l1', 'trade:product_read', 'ALL', 'allow'),
  ('l1', 'trade:product_write', 'DEPT', 'allow'),
  ('l1', 'trade:quote_read', 'ALL', 'allow'),
  ('l1', 'trade:quote_write', 'DEPT', 'allow'),
  ('l1', 'trade:contract_read', 'ALL', 'allow'),
  ('l1', 'trade:contract_write', 'DEPT', 'allow'),
  ('l1', 'trade:contract_approve', 'DEPT', 'allow'),
  ('l1', 'trade:receivable_read', 'ALL', 'allow'),
  ('l1', 'trade:receivable_write', 'DEPT', 'allow'),
  ('l1', 'trade:export', 'DEPT', 'allow'),
  ('l1', 'trade:sample_read', 'ALL', 'allow'),
  ('l1', 'trade:sample_write', 'DEPT', 'allow'),
  ('l1', 'trade:price_read', 'ALL', 'allow'),
  ('l1', 'trade:credit_read', 'ALL', 'allow'),
  ('l1', 'trade:floor_price_read', 'ALL', 'allow'),
  ('l1', 'trade:fx_lock_read', 'ALL', 'allow'),
  ('l1', 'trade:credit_policy', 'ALL', 'allow'),
  ('l1', 'mail:account_read', 'ALL', 'allow'),
  ('l1', 'mail:account_manage', 'DEPT', 'allow'),
  ('l1', 'mail:send', 'DEPT', 'allow'),
  ('l1', 'mail:distribute', 'DEPT', 'allow'),
  ('l1', 'mail:campaign', 'DEPT', 'allow'),
  ('l1', 'mail:suppression_manage', 'DEPT', 'allow'),
  ('l1', 'mail:archive_export', 'ALL', 'allow')
on conflict (template_id, permission_key) do update
  set scope_type = excluded.scope_type,
      effect = excluded.effect,
      updated_at = now();

-- L2：读子树 / 写本部门
insert into role_template_grants (template_id, permission_key, scope_type, effect)
values
  ('l2', 'member:view', 'DEPT_TREE', 'allow'),
  ('l2', 'member:profile', 'DEPT', 'allow'),
  ('l2', 'org:view', 'DEPT_TREE', 'allow'),
  ('l2', 'skill:use', 'ALL', 'allow'),
  ('l2', 'skill:edit', 'ALL', 'allow'),
  ('l2', 'pipeline:use', 'ALL', 'allow'),
  ('l2', 'knowledge:read', 'DEPT_TREE', 'allow'),
  ('l2', 'knowledge:write', 'DEPT', 'allow'),
  ('l2', 'knowledge:confirm', 'DEPT', 'allow'),
  ('l2', 'audit:read', 'DEPT_TREE', 'allow'),
  ('l2', 'profile:view_self', 'SELF', 'allow'),
  ('l2', 'profile:edit_self', 'SELF', 'allow'),
  ('l2', 'crm:read', 'DEPT_TREE', 'allow'),
  ('l2', 'crm:write', 'DEPT', 'allow'),
  ('l2', 'crm:assign', 'DEPT', 'allow'),
  ('l2', 'crm:claim', 'SELF', 'allow'),
  ('l2', 'crm:merge', 'DEPT', 'allow'),
  ('l2', 'crm:import', 'DEPT', 'allow'),
  ('l2', 'crm:export', 'DEPT', 'allow'),
  ('l2', 'crm:pool_policy', 'DEPT', 'allow'),
  ('l2', 'crm:holder_cap', 'DEPT', 'allow'),
  ('l2', 'crm:reminder_read', 'DEPT_TREE', 'allow'),
  ('l2', 'crm:reminder_urge', 'DEPT', 'allow'),
  ('l2', 'crm:complaint_manage', 'DEPT', 'allow'),
  ('l2', 'trade:product_read', 'DEPT_TREE', 'allow'),
  ('l2', 'trade:product_write', 'DEPT', 'allow'),
  ('l2', 'trade:quote_read', 'DEPT_TREE', 'allow'),
  ('l2', 'trade:quote_write', 'DEPT', 'allow'),
  ('l2', 'trade:contract_read', 'DEPT_TREE', 'allow'),
  ('l2', 'trade:contract_write', 'DEPT', 'allow'),
  ('l2', 'trade:contract_approve', 'DEPT', 'allow'),
  ('l2', 'trade:receivable_read', 'DEPT_TREE', 'allow'),
  ('l2', 'trade:receivable_write', 'DEPT', 'allow'),
  ('l2', 'trade:export', 'DEPT', 'allow'),
  ('l2', 'trade:sample_read', 'DEPT_TREE', 'allow'),
  ('l2', 'trade:sample_write', 'DEPT', 'allow'),
  ('l2', 'mail:account_read', 'DEPT_TREE', 'allow'),
  ('l2', 'mail:account_manage', 'DEPT', 'allow'),
  ('l2', 'mail:send', 'DEPT', 'allow'),
  ('l2', 'mail:distribute', 'DEPT', 'allow'),
  ('l2', 'mail:campaign', 'DEPT', 'allow'),
  ('l2', 'mail:suppression_manage', 'DEPT', 'allow')
on conflict (template_id, permission_key) do update
  set scope_type = excluded.scope_type,
      effect = excluded.effect,
      updated_at = now();

-- L3：基础能力
insert into role_template_grants (template_id, permission_key, scope_type, effect)
values
  ('l3', 'member:view', 'SELF', 'allow'),
  ('l3', 'org:view', 'DEPT', 'allow'),
  ('l3', 'skill:use', 'ALL', 'allow'),
  ('l3', 'pipeline:use', 'ALL', 'allow'),
  ('l3', 'knowledge:read', 'DEPT', 'allow'),
  ('l3', 'profile:view_self', 'SELF', 'allow'),
  ('l3', 'profile:edit_self', 'SELF', 'allow'),
  ('l3', 'crm:read', 'DEPT', 'allow'),
  ('l3', 'crm:write', 'SELF', 'allow'),
  ('l3', 'crm:claim', 'SELF', 'allow'),
  ('l3', 'crm:reminder_read', 'SELF', 'allow'),
  ('l3', 'trade:product_read', 'DEPT', 'allow'),
  ('l3', 'trade:quote_read', 'SELF', 'allow'),
  ('l3', 'trade:quote_write', 'SELF', 'allow'),
  ('l3', 'trade:contract_read', 'SELF', 'allow'),
  ('l3', 'trade:contract_write', 'SELF', 'allow'),
  ('l3', 'trade:sample_read', 'SELF', 'allow'),
  ('l3', 'trade:sample_write', 'SELF', 'allow'),
  ('l3', 'mail:account_read', 'SELF', 'allow'),
  ('l3', 'mail:send', 'SELF', 'allow')
on conflict (template_id, permission_key) do update
  set scope_type = excluded.scope_type,
      effect = excluded.effect,
      updated_at = now();

-- Finance_Director：财务视角，可突破 L2 天花板，但不含底价/锁汇与任何 protected:*
insert into role_template_grants (template_id, permission_key, scope_type, effect)
values
  ('fd', 'crm:read', 'ALL', 'allow'),
  ('fd', 'crm:reminder_read', 'ALL', 'allow'),
  ('fd', 'trade:product_read', 'ALL', 'allow'),
  ('fd', 'trade:quote_read', 'ALL', 'allow'),
  ('fd', 'trade:contract_read', 'ALL', 'allow'),
  ('fd', 'trade:contract_approve', 'DEPT', 'allow'),
  ('fd', 'trade:receivable_read', 'ALL', 'allow'),
  ('fd', 'trade:receivable_write', 'DEPT', 'allow'),
  ('fd', 'trade:export', 'DEPT', 'allow'),
  ('fd', 'trade:price_read', 'ALL', 'allow'),
  ('fd', 'trade:credit_read', 'ALL', 'allow'),
  ('fd', 'trade:credit_policy', 'ALL', 'allow')
on conflict (template_id, permission_key) do update
  set scope_type = excluded.scope_type,
      effect = excluded.effect,
      updated_at = now();

-- 清理模板中可能残留的未启用模块节点（财务 / 教学 / 投放）
delete from role_template_grants
 where permission_key like 'finance:%'
    or permission_key like 'teaching:%'
    or permission_key like 'ads:%';
