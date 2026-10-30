-- ============================================================================
-- P1 · role_closure 自动维护（幂等）
-- 岗位树规模是几十到几百，按租户整棵重建成本可忽略；
-- 使用事务级 advisory lock 串行化同一租户的并发写入。
-- ============================================================================

create or replace function app.rebuild_role_closure_for_tenant(p_tenant_id uuid) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if p_tenant_id is null then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('role_closure:' || p_tenant_id::text));

  delete from role_closure
   where ancestor_id in (select id from roles where tenant_id = p_tenant_id);

  insert into role_closure (ancestor_id, descendant_id, depth)
  with recursive tree as (
    -- 每个岗位都是自己的祖先（depth=0），否则 child / seat 读不到自身与下属
    select r.id as ancestor_id, r.id as descendant_id, 0 as depth
      from roles r
     where r.tenant_id = p_tenant_id
    union all
    select t.ancestor_id, child.id, t.depth + 1
      from tree t
      join roles child on child.parent_id = t.descendant_id
  )
  select ancestor_id, descendant_id, depth from tree;
end
$fn$;

create or replace function app.roles_closure_trigger() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'DELETE' then
    perform app.rebuild_role_closure_for_tenant(old.tenant_id);
    return old;
  end if;

  perform app.rebuild_role_closure_for_tenant(new.tenant_id);
  return new;
end
$fn$;

revoke all on function app.rebuild_role_closure_for_tenant(uuid) from public;
revoke all on function app.roles_closure_trigger() from public;

drop trigger if exists roles_closure_sync on roles;
create trigger roles_closure_sync
  after insert or update or delete on roles
  for each row execute function app.roles_closure_trigger();

-- 修复/初始化已有数据：策略每次 migrate 重放时顺带重建一次闭包
do $do$
declare
  t uuid;
begin
  for t in select distinct tenant_id from roles loop
    perform app.rebuild_role_closure_for_tenant(t);
  end loop;
end
$do$;
