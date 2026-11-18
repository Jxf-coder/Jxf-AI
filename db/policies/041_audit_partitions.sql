-- 041 审计分区维护：预建后续月份的 audit_events 分区。
--
-- 应用角色不能建表，预建只允许 owner 执行；宿主机 ops:runner 每日调用一次即可。
-- 新分区单独开启 RLS，避免绕过父表直接读分区数据。

create or replace function app.ensure_audit_partitions(months_ahead integer default 4)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_created integer := 0;
  v_month date := date_trunc('month', now())::date;
  v_last date;
  v_part text;
begin
  if months_ahead is null or months_ahead < 0 or months_ahead > 36 then
    raise exception 'months_ahead 必须在 0 到 36 之间' using errcode = '22023';
  end if;

  v_last := (v_month + make_interval(months => months_ahead))::date;

  while v_month <= v_last loop
    v_part := 'audit_events_' || to_char(v_month, 'YYYYMM');
    if to_regclass(v_part) is null then
      execute format(
        'create table %I partition of audit_events for values from (%L) to (%L)',
        v_part,
        v_month,
        (v_month + interval '1 month')::date
      );
      execute format('alter table %I enable row level security', v_part);
      v_created := v_created + 1;
    end if;
    v_month := (v_month + interval '1 month')::date;
  end loop;

  return v_created;
end;
$fn$;

revoke all on function app.ensure_audit_partitions(integer) from public;
grant execute on function app.ensure_audit_partitions(integer) to jxf_owner;
