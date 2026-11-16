-- 会话记忆：仅创建者本人可读写，不按部门共享。
-- 记忆由受理运行的人读取并快照进 runs.input，worker 只消费快照，不直连本表。

alter table thread_memories enable row level security;

drop policy if exists thread_memories_owner on thread_memories;
create policy thread_memories_owner on thread_memories
  for all
  using (tenant_id = app.current_tenant_id() and user_id = app.current_user_id())
  with check (tenant_id = app.current_tenant_id() and user_id = app.current_user_id());

grant select, insert, update, delete on thread_memories to jxf_app;
