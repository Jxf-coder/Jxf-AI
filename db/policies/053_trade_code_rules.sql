-- 053 编号规则：前缀可维护 + 取号读取规则
--
-- - trade_code_rules：租户内可读，应用不可直接写，只能调 app.save_trade_code_rule()
-- - 只有 L1 能改前缀；未配置的类型继续用内置前缀，存量编码格式不变
-- - 规则只影响之后生成的新编号，不回溯已发出的编号

alter table trade_code_rules enable row level security;

drop policy if exists trade_code_rules_read on trade_code_rules;
create policy trade_code_rules_read on trade_code_rules
  for select
  to jxf_app
  using (tenant_id = app.current_tenant_id());

revoke insert, update, delete, truncate on trade_code_rules from jxf_app;

create or replace function app.save_trade_code_rule(p_code_type text, p_prefix text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_tenant uuid := app.current_tenant_id();
  v_user uuid := app.current_user_id();
  v_prefix text := upper(btrim(coalesce(p_prefix, '')));
begin
  if v_tenant is null or v_user is null then
    raise exception 'missing identity' using errcode = '42501';
  end if;
  if app.current_access_level() <> 'L1' then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_code_type not in ('customer', 'quote', 'contract', 'sample') then
    raise exception 'unknown code type: %', p_code_type using errcode = '22023';
  end if;
  if v_prefix = '' or char_length(v_prefix) > 4 then
    raise exception 'prefix must be 1-4 characters' using errcode = '22023';
  end if;

  insert into trade_code_rules (tenant_id, code_type, prefix, updated_by)
  values (v_tenant, p_code_type, v_prefix, v_user)
  on conflict (tenant_id, code_type) do update
    set prefix = excluded.prefix,
        updated_by = excluded.updated_by,
        updated_at = now();
end;
$fn$;

revoke all on function app.save_trade_code_rule(text, text) from public;
grant execute on function app.save_trade_code_rule(text, text) to jxf_app;

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

  select r.prefix
    into v_prefix
    from trade_code_rules r
   where r.tenant_id = p_tenant_id
     and r.code_type = p_code_type;

  if v_prefix is null then
    v_prefix := case p_code_type
      when 'customer' then 'C'
      when 'quote' then 'Q'
      when 'contract' then 'CT'
      when 'sample' then 'S'
      else null
    end;
  end if;

  if v_prefix is null then
    raise exception '未知编号类型：%', p_code_type using errcode = '22023';
  end if;

  insert into trade_sequences (tenant_id, code_type, prefix, period, seq)
  values (p_tenant_id, p_code_type, v_prefix, v_period, 1)
  on conflict (tenant_id, code_type, period)
  do update set seq = trade_sequences.seq + 1,
                prefix = excluded.prefix,
                updated_at = now()
  returning seq into v_seq;

  return v_prefix || v_period || lpad(v_seq::text, 4, '0');
end;
$fn$;

revoke all on function app.next_trade_code(uuid, text) from public;
grant execute on function app.next_trade_code(uuid, text) to jxf_app;
