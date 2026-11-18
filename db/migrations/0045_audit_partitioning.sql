-- ============================================================================
-- W1-01 · audit_events 分区化（按月 RANGE(created_at)）
--
-- 现有 audit_events 是普通表，无法就地 ALTER 成分区表，因此按「新建 → 回填 → 切换」推进：
--   1. 建新父表（主键必须包含分区键，故 PK 变为 (id, created_at)）
--   2. 从最早数据月建到当前月 + 6 个月，每个分区单独开启 RLS，防止绕过父表直读
--   3. 回填历史数据，重命名旧表索引后切换表名
--   4. 重建索引与序列归属，旧表降级为 audit_events_legacy（保留一个发布周期）
--
-- 分区策略由 app.ensure_audit_partitions() 在 ops:runner 中持续预建（见 policies/041）。
-- ============================================================================

create table audit_events_new (
  id bigint not null default nextval('audit_events_id_seq'),
  tenant_id uuid not null,
  actor_user_id uuid,
  department_id uuid,
  action text not null,
  target_type text,
  target_id uuid,
  request_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamp(3) with time zone not null default now(),
  constraint audit_events_new_pkey primary key (id, created_at)
) partition by range (created_at);
--> statement-breakpoint

alter table audit_events_new
  add constraint audit_events_new_actor_fk
  foreign key (actor_user_id) references users(id) on delete set null;
--> statement-breakpoint

do $$
declare
  cur_month date := date_trunc(
    'month',
    coalesce((select min(created_at) from audit_events), now())
  )::date;
  last_month date := (date_trunc('month', now()) + interval '6 months')::date;
  part_name text;
begin
  while cur_month <= last_month loop
    part_name := 'audit_events_' || to_char(cur_month, 'YYYYMM');
    execute format(
      'create table if not exists %I partition of audit_events_new for values from (%L) to (%L)',
      part_name,
      cur_month,
      (cur_month + interval '1 month')::date
    );
    execute format('alter table %I enable row level security', part_name);
    cur_month := (cur_month + interval '1 month')::date;
  end loop;
end $$;
--> statement-breakpoint

insert into audit_events_new (
  id, tenant_id, actor_user_id, department_id, action,
  target_type, target_id, request_id, payload, created_at
)
select
  id, tenant_id, actor_user_id, department_id, action,
  target_type, target_id, request_id, payload, created_at
from audit_events;
--> statement-breakpoint

-- 旧表索引改名，给新表的同名索引让位
alter index audit_events_pkey rename to audit_events_legacy_pkey;
--> statement-breakpoint
alter index audit_events_tenant_created_idx rename to audit_events_legacy_tenant_created_idx;
--> statement-breakpoint
alter index audit_events_actor_idx rename to audit_events_legacy_actor_idx;
--> statement-breakpoint
alter index audit_events_department_idx rename to audit_events_legacy_department_idx;
--> statement-breakpoint

alter table audit_events rename to audit_events_legacy;
--> statement-breakpoint
alter table audit_events_new rename to audit_events;
--> statement-breakpoint
alter table audit_events rename constraint audit_events_new_pkey to audit_events_pkey;
--> statement-breakpoint

create index audit_events_tenant_created_idx on audit_events (tenant_id, created_at);
--> statement-breakpoint
create index audit_events_actor_idx on audit_events (actor_user_id);
--> statement-breakpoint
create index audit_events_department_idx on audit_events (department_id);
--> statement-breakpoint

alter sequence audit_events_id_seq owned by audit_events.id;
--> statement-breakpoint

do $$
declare
  max_id bigint;
  seq_last bigint;
begin
  select coalesce(max(id), 0) into max_id from audit_events;
  select last_value into seq_last from audit_events_id_seq;
  if max_id > seq_last then
    perform setval('audit_events_id_seq', max_id, true);
  end if;
end $$;
--> statement-breakpoint

alter table audit_events enable row level security;
--> statement-breakpoint

revoke update, delete, truncate on audit_events from jxf_app;
--> statement-breakpoint

analyze audit_events;
