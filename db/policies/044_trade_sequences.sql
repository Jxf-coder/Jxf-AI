-- 044 CRM 字典与编号：读策略、写收口与编号函数
--
-- - 字典：租户内可读，只有 L1（crm:dict_manage）可写
-- - 序列表：应用不可直接读写，只能调用 app.next_trade_code() 原子取号

alter table trade_dictionaries enable row level security;

drop policy if exists trade_dictionaries_read on trade_dictionaries;
create policy trade_dictionaries_read on trade_dictionaries
  for select
  to jxf_app
  using (tenant_id = app.current_tenant_id());

drop policy if exists trade_dictionaries_write on trade_dictionaries;
create policy trade_dictionaries_write on trade_dictionaries
  for all
  to jxf_app
  using (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  )
  with check (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  );

alter table trade_sequences enable row level security;
revoke insert, update, delete, truncate on trade_sequences from jxf_app;

create or replace function app.next_trade_code(p_tenant_id uuid, p_code_type text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_prefix text;
  v_period text := to_char(now(), 'YYYYMM');
  v_seq integer;
begin
  if p_tenant_id is null then
    raise exception '缺少租户上下文' using errcode = '42501';
  end if;

  v_prefix := case p_code_type
    when 'customer' then 'C'
    when 'quote' then 'Q'
    when 'contract' then 'CT'
    when 'sample' then 'S'
    else null
  end;

  if v_prefix is null then
    raise exception '未知编号类型：%', p_code_type using errcode = '22023';
  end if;

  insert into trade_sequences (tenant_id, code_type, prefix, period, seq)
  values (p_tenant_id, p_code_type, v_prefix, v_period, 1)
  on conflict (tenant_id, code_type, period)
  do update set seq = trade_sequences.seq + 1, updated_at = now()
  returning seq into v_seq;

  return v_prefix || v_period || lpad(v_seq::text, 4, '0');
end;
$fn$;

revoke all on function app.next_trade_code(uuid, text) from public;
grant execute on function app.next_trade_code(uuid, text) to jxf_app;
