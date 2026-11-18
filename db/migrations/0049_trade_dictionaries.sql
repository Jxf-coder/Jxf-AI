-- ============================================================================
-- W1-06 · CRM 字典与编号
--
-- trade_dictionaries：区域、等级、客户类型、来源、行业、价格条款等全部可维护字典
-- trade_sequences：按「类型 + 年月」递增，生成 C/Q/CT/S 业务编号
-- 编号只能经 app.next_trade_code() 取得，应用不能直接改序列表。
-- ============================================================================

create table if not exists trade_dictionaries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  dict_type text not null,
  code text not null,
  label text not null,
  sort integer not null default 0,
  enabled boolean not null default true,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trade_dictionaries_unique unique (tenant_id, dict_type, code)
);
--> statement-breakpoint

create index if not exists trade_dictionaries_type_idx
  on trade_dictionaries (tenant_id, dict_type, sort);
--> statement-breakpoint

create table if not exists trade_sequences (
  tenant_id uuid not null,
  code_type text not null check (code_type in ('customer', 'quote', 'contract', 'sample')),
  prefix text not null,
  period text not null,
  seq integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint trade_sequences_pkey primary key (tenant_id, code_type, period)
);
