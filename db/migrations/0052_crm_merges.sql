-- ============================================================================
-- W1-09 · 客户资料合并
--
-- 合并只做"软收编"：源客户保留编码与历史，打 archived_at + merged_into_id 指针，
-- 联系人与记录迁到目标客户，旧编码在 crm_merges 里留档，便于回溯与反查。
-- ============================================================================

create table if not exists crm_merges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  source_account_id uuid not null references crm_accounts(id) on delete cascade,
  target_account_id uuid not null references crm_accounts(id) on delete cascade,
  source_code text not null,
  target_code text not null,
  moved_contacts integer not null default 0,
  moved_counts jsonb not null default '{}'::jsonb,
  reason text,
  merged_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint crm_merges_distinct check (source_account_id <> target_account_id)
);
--> statement-breakpoint

create index if not exists crm_merges_source_idx
  on crm_merges (tenant_id, source_account_id);
--> statement-breakpoint

create index if not exists crm_merges_target_idx
  on crm_merges (tenant_id, target_account_id, created_at desc);
