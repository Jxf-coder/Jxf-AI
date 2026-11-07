-- P5 后续切片：自动化产线（定义 + 批量派活运行）
--
-- 读取：租户内且部门在当前上下文可读范围；
-- 写入：应用层还需 pipeline:manage（L1 默认持有，可授权），RLS 兜底为部门可读；
-- 运行记录只追加，不允许修改 / 删除。

alter table pipelines enable row level security;

drop policy if exists pipelines_read on pipelines;
create policy pipelines_read on pipelines
  for select using (
    tenant_id = app.current_tenant_id()
    and app.can_read(department_id)
  );

drop policy if exists pipelines_insert on pipelines;
create policy pipelines_insert on pipelines
  for insert with check (
    tenant_id = app.current_tenant_id()
    and app.can_read(department_id)
    and created_by = app.current_user_id()
  );

drop policy if exists pipelines_update on pipelines;
create policy pipelines_update on pipelines
  for update using (
    tenant_id = app.current_tenant_id()
    and app.can_read(department_id)
  ) with check (
    tenant_id = app.current_tenant_id()
    and app.can_read(department_id)
  );

drop policy if exists pipelines_delete on pipelines;
create policy pipelines_delete on pipelines
  for delete using (
    tenant_id = app.current_tenant_id()
    and app.can_read(department_id)
  );

grant select, insert, update, delete on pipelines to jxf_app;

alter table pipeline_runs enable row level security;

drop policy if exists pipeline_runs_read on pipeline_runs;
create policy pipeline_runs_read on pipeline_runs
  for select using (
    tenant_id = app.current_tenant_id()
    and app.can_read(department_id)
  );

drop policy if exists pipeline_runs_insert on pipeline_runs;
create policy pipeline_runs_insert on pipeline_runs
  for insert with check (
    tenant_id = app.current_tenant_id()
    and app.can_read(department_id)
    and requested_by = app.current_user_id()
  );

grant select, insert on pipeline_runs to jxf_app;
revoke update, delete on pipeline_runs from jxf_app;
