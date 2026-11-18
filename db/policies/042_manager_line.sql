-- 042 汇报线闭包：直属主管 → 全部下级的传递闭包
--
-- 规模是个位数到几百人，按租户整棵重建成本可忽略；
-- 用事务级 advisory lock 串行化同一租户的并发写入。
-- 只允许 SECURITY DEFINER 函数读写闭包表；应用角色只能通过 manager_subtree_user_ids() 取结果。

alter table user_manager_closure enable row level security;
revoke insert, update, delete, truncate on user_manager_closure from jxf_app;

create or replace function app.rebuild_user_manager_closure_for_tenant(p_tenant_id uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if p_tenant_id is null then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('user_manager_closure:' || p_tenant_id::text));

  delete from user_manager_closure where tenant_id = p_tenant_id;

  -- 每个在岗成员都是自己的祖先（depth=0），保证「本人」始终在范围内
  insert into user_manager_closure (tenant_id, ancestor_user_id, descendant_user_id, depth)
  select distinct p_tenant_id, m.user_id, m.user_id, 0
    from memberships m
   where m.tenant_id = p_tenant_id
     and m.status = 'active'
  on conflict do nothing;

  -- 主管链：只接受同租户内两人都有在岗任用的边，避免跨租户串线
  insert into user_manager_closure (tenant_id, ancestor_user_id, descendant_user_id, depth)
  with recursive edges as (
    select u.id as user_id, u.manager_user_id as manager_id
      from users u
     where u.manager_user_id is not null
       and exists (
         select 1 from memberships m
          where m.user_id = u.id and m.tenant_id = p_tenant_id and m.status = 'active'
       )
       and exists (
         select 1 from memberships m
          where m.user_id = u.manager_user_id and m.tenant_id = p_tenant_id and m.status = 'active'
       )
  ), walk as (
    select e.manager_id as ancestor, e.user_id as descendant, 1 as depth
      from edges e
    union
    select w.ancestor, e.user_id, w.depth + 1
      from walk w
      join edges e on e.manager_id = w.descendant
     where w.depth < 20
  )
  select p_tenant_id, ancestor, descendant, min(depth)
    from walk
   group by ancestor, descendant
  on conflict do nothing;
end
$fn$;

create or replace function app.users_manager_trigger() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  t uuid;
  v_user uuid;
begin
  v_user := coalesce(new.id, old.id);

  for t in
    select distinct m.tenant_id
      from memberships m
     where m.user_id = v_user
  loop
    perform app.rebuild_user_manager_closure_for_tenant(t);
  end loop;

  -- 主管变更同时影响旧主管所在租户的下级集合
  if tg_op = 'UPDATE' and old.manager_user_id is distinct from new.manager_user_id
     and old.manager_user_id is not null then
    for t in
      select distinct m.tenant_id
        from memberships m
       where m.user_id = old.manager_user_id
    loop
      perform app.rebuild_user_manager_closure_for_tenant(t);
    end loop;
  end if;

  return coalesce(new, old);
end
$fn$;

revoke all on function app.rebuild_user_manager_closure_for_tenant(uuid) from public;
revoke all on function app.users_manager_trigger() from public;

drop trigger if exists users_manager_closure_sync on users;
create trigger users_manager_closure_sync
  after insert or update of manager_user_id on users
  for each row execute function app.users_manager_trigger();

-- 汇报线下级（含本人）：供 CRM RLS 与记录范围计算使用
create or replace function app.manager_subtree_user_ids(p_user_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(array_agg(descendant_user_id), '{}'::uuid[])
    from user_manager_closure
   where ancestor_user_id = p_user_id;
$fn$;

revoke all on function app.manager_subtree_user_ids(uuid) from public;
grant execute on function app.manager_subtree_user_ids(uuid) to jxf_app;

-- 策略每次重放时重建一次，修复手工改过主管但闭包没跟上的数据
do $do$
declare
  t uuid;
begin
  for t in select distinct tenant_id from memberships loop
    perform app.rebuild_user_manager_closure_for_tenant(t);
  end loop;
end
$do$;
