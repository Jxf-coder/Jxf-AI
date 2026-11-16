-- 037 经验来源文本保留期清理
--
-- 为什么放在 SECURITY DEFINER 函数里：
--   清理是跨租户的（worker 不持有部门的 app.department_ids 上下文），
--   而 knowledge_cards 的读策略依赖该上下文；若让 worker 直接查卡表，
--   要么放宽成“可读全部卡”，要么在无上下文时误判为“没有被引用”。
--   函数以 jxf_owner 身份运行，只暴露「置空过期 source_text」这一个动作，
--   worker 仅获得 execute，不获得任何表的额外读写权限。
--
-- 语义：
--   - 只清 source_text，不删除 job 行，状态、计数与来源元数据长期保留；
--   - 仍被 pending 卡引用（knowledge_cards.source_job_id）的 job 跳过；
--   - 返回 purged / skipped，供 worker 记录观测指标。

create or replace function app.purge_experience_source_text(p_retention_days integer default 90)
returns table(purged integer, skipped integer)
language sql
security definer
set search_path = public, pg_temp
as $fn$
  with expired as (
    select j.id,
           exists (
             select 1
               from knowledge_cards c
              where c.source_job_id = j.id
                and c.status = 'pending'
           ) as referenced
      from experience_jobs j
     where j.source_text is not null
       and j.created_at < now() - make_interval(days => p_retention_days)
  ),
  purged as (
    update experience_jobs j
       set source_text = null
      from expired e
     where j.id = e.id
       and e.referenced = false
    returning j.id
  )
  select (select count(*)::int from purged) as purged,
         (select count(*)::int from expired where referenced) as skipped
$fn$;

revoke all on function app.purge_experience_source_text(integer) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_worker') then
    execute 'grant execute on function app.purge_experience_source_text(integer) to app_worker';
  end if;
end $$;
