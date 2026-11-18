-- ============================================================================
-- W1-08 · 客户公共池
--
-- 公共池不是一张"池表"，而是 crm_accounts.pool_status 的状态位 + 部门范围 + 功能权限。
-- 这里补三张支撑表：
--   crm_pool_policies  部门级池策略（持有上限 / 重点池阈值 / 候选 TTL / 领取方式）
--   crm_holder_caps    员工个体上限覆盖（可空，可带有效期）
--   crm_assignments    分派 / 领用 / 置公 / 重点池裁决的历史流水（只追加）
-- ============================================================================

create table if not exists crm_pool_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  department_id uuid not null references departments(id) on delete cascade,
  holder_cap integer not null default 150 check (holder_cap >= 0),
  manager_holder_cap integer not null default 500 check (manager_holder_cap >= 0),
  key_grade_threshold integer not null default 80 check (key_grade_threshold between 0 and 100),
  key_pending_ttl_days integer not null default 7 check (key_pending_ttl_days between 1 and 90),
  claim_mode text not null default 'self' check (claim_mode in ('self', 'assign')),
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_pool_policies_dept_unique unique (tenant_id, department_id)
);
--> statement-breakpoint

create table if not exists crm_holder_caps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  holder_cap integer check (holder_cap is null or holder_cap >= 0),
  reason text,
  updated_by uuid references users(id) on delete set null,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_holder_caps_user_unique unique (tenant_id, user_id),
  constraint crm_holder_caps_window check (valid_until is null or valid_until > valid_from)
);
--> statement-breakpoint

create table if not exists crm_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  account_id uuid not null references crm_accounts(id) on delete cascade,
  action text not null check (
    action in ('assign', 'claim', 'release', 'recall', 'key_confirm', 'key_downgrade', 'key_expired')
  ),
  from_user_id uuid references users(id) on delete set null,
  to_user_id uuid references users(id) on delete set null,
  from_pool_status text,
  to_pool_status text,
  reason text,
  operated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
--> statement-breakpoint

create index if not exists crm_assignments_account_idx
  on crm_assignments (tenant_id, account_id, created_at desc);
--> statement-breakpoint

create index if not exists crm_accounts_pool_idx
  on crm_accounts (tenant_id, pool_status);
