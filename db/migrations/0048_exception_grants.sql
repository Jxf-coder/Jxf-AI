-- ============================================================================
-- W1-05 · 例外授权
--
-- 两原语中的「授权表」：
--   data_scope_grants  跨人/跨部门的临时数据范围（谁可以看/写谁）
--   resource_shares    单条资源的例外共享（某个客户、某个邮箱）
-- 两张表都带有效期与授权人，到期由策略函数用 now() 实时判定，不做定时任务。
-- ============================================================================

create table if not exists data_scope_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  grantee_user_id uuid not null references users(id) on delete cascade,
  domain text not null check (domain in ('crm', 'trade', 'mail', 'reminder')),
  scope_type text not null check (scope_type in ('USERS', 'DEPARTMENTS', 'ALL')),
  scope_refs uuid[] not null default '{}'::uuid[],
  capability text not null check (capability in ('read', 'write', 'manage')),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  granted_by uuid references users(id) on delete set null,
  reason text,
  created_at timestamptz not null default now(),
  constraint data_scope_grants_shape check (
    (scope_type = 'ALL' and cardinality(scope_refs) = 0)
    or (scope_type in ('USERS', 'DEPARTMENTS') and cardinality(scope_refs) > 0)
  ),
  constraint data_scope_grants_window check (valid_until is null or valid_until > valid_from)
);
--> statement-breakpoint

create index if not exists data_scope_grants_grantee_idx
  on data_scope_grants (tenant_id, grantee_user_id, domain);
--> statement-breakpoint

create table if not exists resource_shares (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  resource_type text not null check (
    resource_type in ('mail_account', 'crm_account', 'quote', 'contract', 'sample')
  ),
  resource_id uuid not null,
  grantee_user_id uuid not null references users(id) on delete cascade,
  capability text not null check (
    capability in ('read', 'write', 'send', 'assign', 'manage')
  ),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  granted_by uuid references users(id) on delete set null,
  reason text,
  created_at timestamptz not null default now(),
  constraint resource_shares_window check (valid_until is null or valid_until > valid_from),
  constraint resource_shares_unique unique (
    tenant_id, resource_type, resource_id, grantee_user_id, capability
  )
);
--> statement-breakpoint

create index if not exists resource_shares_resource_idx
  on resource_shares (tenant_id, resource_type, resource_id);
--> statement-breakpoint

create index if not exists resource_shares_grantee_idx
  on resource_shares (tenant_id, grantee_user_id, resource_type);
