-- ============================================================================
-- W1-10 · 客户交互时间线（联系记录）
--
-- 一条记录 = 一次沟通或一个跟进计划。next_follow_at 是「计划跟进」的时间点，
-- W5 的提醒规则按它生成 crm.next_follow_due，本阶段先把数据与页面跑通。
-- ============================================================================

create table if not exists crm_interactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  department_id uuid not null references departments(id) on delete restrict,
  account_id uuid not null references crm_accounts(id) on delete cascade,
  contact_id uuid references crm_contacts(id) on delete set null,
  owner_user_id uuid references users(id) on delete set null,
  purpose text,
  direction text not null default 'out' check (direction in ('in', 'out', 'internal')),
  channel text not null default 'note'
    check (channel in ('call', 'mail', 'wechat', 'whatsapp', 'meeting', 'note', 'task')),
  occurred_at timestamptz not null default now(),
  next_follow_at timestamptz,
  subject text,
  content text,
  remark text,
  status text not null default 'followed' check (status in ('followed', 'pending')),
  is_opportunity boolean not null default false,
  interested_products text,
  category text,
  source_ref text,
  source_run_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
--> statement-breakpoint

create index if not exists crm_interactions_account_idx
  on crm_interactions (tenant_id, account_id, occurred_at desc);
--> statement-breakpoint

-- 计划跟进待办：W5 提醒扫描走这个部分索引
create index if not exists crm_interactions_follow_idx
  on crm_interactions (tenant_id, owner_user_id, next_follow_at)
  where next_follow_at is not null and status = 'pending';
