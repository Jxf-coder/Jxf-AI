-- ---------------------------------------------------------------------------
-- 019 知识卡版本快照
--
-- 1. 读：跟随所属卡片的可见范围（子树可读，或卡片已加入公司共享）
-- 2. 写：仅本部门可插入；版本是历史事实，不提供 update / delete 策略
-- 3. 级联：卡片彻底删除时由外键 cascade 清理，不依赖应用角色权限
-- ---------------------------------------------------------------------------

alter table knowledge_card_versions enable row level security;

drop policy if exists knowledge_card_versions_read on knowledge_card_versions;
create policy knowledge_card_versions_read on knowledge_card_versions
  for select
  using (
    exists (
      select 1
        from knowledge_cards k
       where k.id = knowledge_card_versions.card_id
         and k.tenant_id = app.current_tenant_id()
         and (app.can_read(k.department_id) or k.visibility = 'shared')
    )
  );

drop policy if exists knowledge_card_versions_insert on knowledge_card_versions;
create policy knowledge_card_versions_insert on knowledge_card_versions
  for insert
  with check (
    tenant_id = app.current_tenant_id()
    and app.can_write(department_id)
  );
