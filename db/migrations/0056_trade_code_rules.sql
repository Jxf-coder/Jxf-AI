-- ============================================================================
-- W1-17 · 编号规则
--
-- trade_code_rules：按编号类型保存前缀，覆盖 app.next_trade_code() 的内置前缀。
-- 应用角色不可直接读写，只能经 app.save_trade_code_rule() 维护；
-- 未配置的类型继续用内置前缀（C / Q / CT / S），保证存量行为不变。
-- ============================================================================

create table if not exists trade_code_rules (
  tenant_id uuid not null,
  code_type text not null check (code_type in ('customer', 'quote', 'contract', 'sample')),
  prefix text not null check (char_length(prefix) between 1 and 4),
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint trade_code_rules_pkey primary key (tenant_id, code_type)
);
