-- ============================================================================
-- W1-07 · 客户与联系人
--
-- 客户是 CRM 的第一张业务表：归属（负责人 + 部门）、公共池四态、合并指针、软删。
-- 信用额度等财务列先在表里预留，脱敏视图与财务权限在 W2 一起上线。
-- ============================================================================

create table if not exists crm_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  department_id uuid not null references departments(id) on delete restrict,
  code text not null,
  name text not null,
  name_norm text not null,
  customer_no text,
  region text,
  country text,
  address text,
  company_name text,
  email text,
  main_products text,
  competitors text,
  annual_revenue text,
  employee_count text,
  founded_year text,
  source text,
  interested_products text,
  grade text,
  customer_type text,
  market_contact text,
  website text,
  fax text,
  postal_code text,
  sales_region text,
  enterprise_type text,
  brand text,
  sales_channel text,
  purchase_frequency text,
  required_quality text,
  traffic_content text,
  analysis text,
  contact_status text not null default 'untouched'
    check (contact_status in ('untouched', 'mailed', 'wechat', 'replied', 'no_reply', 'unreachable')),
  deal_status text not null default 'potential'
    check (deal_status in ('potential', 'quoting', 'negotiating', 'won', 'lost')),
  pool_status text not null default 'private'
    check (pool_status in ('private', 'public', 'key_pending', 'key')),
  owner_user_id uuid references users(id) on delete set null,
  protection_until timestamptz,
  released_reason text,
  icp_score integer,
  credit_limit numeric(14, 2),
  credit_used numeric(14, 2),
  merged_into_id uuid references crm_accounts(id) on delete set null,
  legacy_ref text,
  extra jsonb not null default '{}'::jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint crm_accounts_code_unique unique (tenant_id, code)
);
--> statement-breakpoint

create index if not exists crm_accounts_dept_idx
  on crm_accounts (tenant_id, department_id);
--> statement-breakpoint

create index if not exists crm_accounts_owner_idx
  on crm_accounts (tenant_id, owner_user_id);
--> statement-breakpoint

create index if not exists crm_accounts_name_idx
  on crm_accounts (tenant_id, name_norm);
--> statement-breakpoint

create table if not exists crm_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  department_id uuid not null references departments(id) on delete restrict,
  account_id uuid not null references crm_accounts(id) on delete cascade,
  name text not null,
  job_title text,
  job_title_ai text,
  role_type text check (role_type in ('decision', 'tech', 'purchase', 'finance', 'other')),
  mobile text,
  phone text,
  email text,
  email_alt text,
  whatsapp text,
  wechat text,
  facebook text,
  twitter text,
  linkedin text,
  birthday date,
  is_primary boolean not null default false,
  consent_status text not null default 'unknown'
    check (consent_status in ('unknown', 'subscribed', 'unsubscribed')),
  email_status text not null default 'valid'
    check (email_status in ('valid', 'invalid', 'bounced')),
  extra jsonb not null default '{}'::jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
--> statement-breakpoint

create index if not exists crm_contacts_account_idx
  on crm_contacts (tenant_id, account_id);
--> statement-breakpoint

create index if not exists crm_contacts_email_idx
  on crm_contacts (tenant_id, email);
