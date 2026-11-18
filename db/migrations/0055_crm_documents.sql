-- ============================================================================
-- W1-17 · 客户相关文档
--
-- 一条记录 = 客户详情「相关文档」页签里的一个附件。
-- 文件本体走本地分级存储（public/uploads/...），库里只存相对 key；
-- 可见性与写权限完全跟随所属客户，由 RLS 子查询继承 crm_accounts 的策略。
-- ============================================================================

create table if not exists crm_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  account_id uuid not null references crm_accounts(id) on delete cascade,
  name text not null,
  storage_key text not null,
  mime text,
  size_bytes bigint not null default 0,
  uploaded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
--> statement-breakpoint

create index if not exists crm_documents_account_idx
  on crm_documents (tenant_id, account_id, created_at desc);
