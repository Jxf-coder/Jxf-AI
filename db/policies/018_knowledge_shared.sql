-- ---------------------------------------------------------------------------
-- 018 公司资料共享区 + 岗位 / 目录维度
--
-- 目标：
--   1. 读：部门子树不变；额外放行 visibility = 'shared' 的跨部门读取。
--   2. 写：完全不变，仍由 app.can_write(department_id) 约束。
--   3. 证据 / 原件（assets）跟着共享文档一起可读，否则共享区文件点开是 404。
--
-- 注意：knowledge_cards.visibility 在 0010 之前从未参与策略，历史值全是 'shared'；
--       0010 已统一收回为 'department'，共享必须显式设置。
-- ---------------------------------------------------------------------------

drop policy if exists documents_read on documents;
create policy documents_read on documents
  for select
  using (
    tenant_id = app.current_tenant_id()
    and (app.can_read(department_id) or visibility = 'shared')
  );

drop policy if exists doc_chunks_read on doc_chunks;
create policy doc_chunks_read on doc_chunks
  for select
  using (
    tenant_id = app.current_tenant_id()
    and (
      app.can_read(department_id)
      or exists (
        select 1 from documents d
         where d.id = doc_chunks.document_id
           and d.visibility = 'shared'
      )
    )
  );

drop policy if exists knowledge_cards_read on knowledge_cards;
create policy knowledge_cards_read on knowledge_cards
  for select
  using (
    tenant_id = app.current_tenant_id()
    and (app.can_read(department_id) or visibility = 'shared')
  );

drop policy if exists card_evidence_read on card_evidence;
create policy card_evidence_read on card_evidence
  for select
  using (
    exists (
      select 1 from knowledge_cards k
       where k.id = card_evidence.card_id
         and k.tenant_id = app.current_tenant_id()
         and (app.can_read(k.department_id) or k.visibility = 'shared')
    )
  );

drop policy if exists assets_read on assets;
create policy assets_read on assets
  for select
  using (
    tenant_id = app.current_tenant_id()
    and (
      app.can_read(department_id)
      or exists (
        select 1 from documents d
         where d.asset_id = assets.id
           and d.visibility = 'shared'
      )
    )
  );
