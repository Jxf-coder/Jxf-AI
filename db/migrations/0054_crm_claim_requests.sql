-- ============================================================================
-- W1-13 · 公共池领用申请
--
-- L2 / L3 不能直接领用，只能提交申请；由上级（L1，或该申请部门的 L2）审批。
-- 申请表只记录意图与裁决，客户归属仍只由 crm_accounts 状态位表达；
-- 同一客户同一申请人同时只允许一条 pending。
-- ============================================================================

create table if not exists crm_claim_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  department_id uuid not null references departments(id) on delete restrict,
  account_id uuid not null references crm_accounts(id) on delete cascade,
  requester_user_id uuid not null references users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  note text,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now()
);
--> statement-breakpoint

create index if not exists crm_claim_requests_account_idx
  on crm_claim_requests (tenant_id, account_id, status, created_at);
--> statement-breakpoint

-- 同一客户同一申请人只保留一条待审批申请，避免重复点击堆叠
create unique index if not exists crm_claim_requests_pending_unique
  on crm_claim_requests (tenant_id, account_id, requester_user_id)
  where status = 'pending';
