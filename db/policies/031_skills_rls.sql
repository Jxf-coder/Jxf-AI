-- 技能注册表 / 运行记录 / Meta 投放 / 多平台分发的行级安全
--
-- 原则：
--   - skills：内置技能（tenant_id is null）所有人可读；租户自建技能按租户隔离，
--     写入收紧为「本人创建」或 L1；
--   - skill_runs：按部门可见，写入必须绑定当前用户；
--   - Meta / 分发：按部门 can_read / can_write；
--   - 发布机令牌表只允许 L1 读写，令牌本身只存 SHA-256。

alter table "skills" enable row level security;
alter table "skill_runs" enable row level security;
alter table "skill_runtime_tokens" enable row level security;
alter table "skill_meta_connections" enable row level security;
alter table "skill_meta_drafts" enable row level security;
alter table "skill_distribute_groups" enable row level security;
alter table "skill_distribute_accounts" enable row level security;
alter table "skill_distribute_jobs" enable row level security;

drop policy if exists skills_read on "skills";
create policy skills_read on "skills"
  for select using (
    tenant_id is null or tenant_id = app.current_tenant_id()
  );

drop policy if exists skills_insert on "skills";
create policy skills_insert on "skills"
  for insert with check (
    tenant_id = app.current_tenant_id()
    and created_by = app.current_user_id()
  );

drop policy if exists skills_update on "skills";
create policy skills_update on "skills"
  for update using (
    tenant_id = app.current_tenant_id()
    and (created_by = app.current_user_id() or app.current_access_level() = 'L1')
  ) with check (
    tenant_id = app.current_tenant_id()
  );

drop policy if exists skills_delete on "skills";
create policy skills_delete on "skills"
  for delete using (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  );

drop policy if exists skill_runs_read on "skill_runs";
create policy skill_runs_read on "skill_runs"
  for select using (
    tenant_id = app.current_tenant_id()
    and app.can_read(department_id)
  );

drop policy if exists skill_runs_insert on "skill_runs";
create policy skill_runs_insert on "skill_runs"
  for insert with check (
    tenant_id = app.current_tenant_id()
    and created_by = app.current_user_id()
    and app.can_read(department_id)
  );

drop policy if exists skill_runs_update on "skill_runs";
create policy skill_runs_update on "skill_runs"
  for update using (
    tenant_id = app.current_tenant_id()
    and (created_by = app.current_user_id() or app.current_access_level() = 'L1')
  ) with check (
    tenant_id = app.current_tenant_id()
  );

drop policy if exists skill_runtime_tokens_read on "skill_runtime_tokens";
create policy skill_runtime_tokens_read on "skill_runtime_tokens"
  for select using (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  );

drop policy if exists skill_runtime_tokens_insert on "skill_runtime_tokens";
create policy skill_runtime_tokens_insert on "skill_runtime_tokens"
  for insert with check (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  );

drop policy if exists skill_runtime_tokens_update on "skill_runtime_tokens";
create policy skill_runtime_tokens_update on "skill_runtime_tokens"
  for update using (
    tenant_id = app.current_tenant_id()
    and app.current_access_level() = 'L1'
  ) with check (
    tenant_id = app.current_tenant_id()
  );

drop policy if exists skill_meta_connections_read on "skill_meta_connections";
create policy skill_meta_connections_read on "skill_meta_connections"
  for select using (
    tenant_id = app.current_tenant_id()
    and app.can_read(department_id)
  );

drop policy if exists skill_meta_connections_insert on "skill_meta_connections";
create policy skill_meta_connections_insert on "skill_meta_connections"
  for insert with check (
    tenant_id = app.current_tenant_id()
    and app.can_write(department_id)
  );

drop policy if exists skill_meta_connections_update on "skill_meta_connections";
create policy skill_meta_connections_update on "skill_meta_connections"
  for update using (
    tenant_id = app.current_tenant_id()
    and app.can_write(department_id)
  ) with check (
    tenant_id = app.current_tenant_id()
  );

drop policy if exists skill_meta_connections_delete on "skill_meta_connections";
create policy skill_meta_connections_delete on "skill_meta_connections"
  for delete using (
    tenant_id = app.current_tenant_id()
    and app.can_write(department_id)
  );

drop policy if exists skill_meta_drafts_read on "skill_meta_drafts";
create policy skill_meta_drafts_read on "skill_meta_drafts"
  for select using (
    tenant_id = app.current_tenant_id()
    and app.can_read(department_id)
  );

drop policy if exists skill_meta_drafts_insert on "skill_meta_drafts";
create policy skill_meta_drafts_insert on "skill_meta_drafts"
  for insert with check (
    tenant_id = app.current_tenant_id()
    and app.can_write(department_id)
  );

drop policy if exists skill_meta_drafts_update on "skill_meta_drafts";
create policy skill_meta_drafts_update on "skill_meta_drafts"
  for update using (
    tenant_id = app.current_tenant_id()
    and app.can_write(department_id)
  ) with check (
    tenant_id = app.current_tenant_id()
  );

drop policy if exists skill_distribute_groups_read on "skill_distribute_groups";
create policy skill_distribute_groups_read on "skill_distribute_groups"
  for select using (
    tenant_id = app.current_tenant_id()
    and app.can_read(department_id)
  );

drop policy if exists skill_distribute_groups_write on "skill_distribute_groups";
create policy skill_distribute_groups_write on "skill_distribute_groups"
  for all using (
    tenant_id = app.current_tenant_id()
    and app.can_write(department_id)
  ) with check (
    tenant_id = app.current_tenant_id()
    and app.can_write(department_id)
  );

drop policy if exists skill_distribute_accounts_read on "skill_distribute_accounts";
create policy skill_distribute_accounts_read on "skill_distribute_accounts"
  for select using (
    tenant_id = app.current_tenant_id()
    and app.can_read(department_id)
  );

drop policy if exists skill_distribute_accounts_write on "skill_distribute_accounts";
create policy skill_distribute_accounts_write on "skill_distribute_accounts"
  for all using (
    tenant_id = app.current_tenant_id()
    and app.can_write(department_id)
  ) with check (
    tenant_id = app.current_tenant_id()
    and app.can_write(department_id)
  );

drop policy if exists skill_distribute_jobs_read on "skill_distribute_jobs";
create policy skill_distribute_jobs_read on "skill_distribute_jobs"
  for select using (
    tenant_id = app.current_tenant_id()
    and app.can_read(department_id)
  );

drop policy if exists skill_distribute_jobs_insert on "skill_distribute_jobs";
create policy skill_distribute_jobs_insert on "skill_distribute_jobs"
  for insert with check (
    tenant_id = app.current_tenant_id()
    and created_by = app.current_user_id()
    and app.can_read(department_id)
  );

drop policy if exists skill_distribute_jobs_update on "skill_distribute_jobs";
create policy skill_distribute_jobs_update on "skill_distribute_jobs"
  for update using (
    tenant_id = app.current_tenant_id()
    and app.can_write(department_id)
  ) with check (
    tenant_id = app.current_tenant_id()
  );

grant select, insert, update, delete on "skills" to jxf_app;
grant select, insert, update, delete on "skill_runs" to jxf_app;
grant select, insert, update on "skill_runtime_tokens" to jxf_app;
grant select, insert, update, delete on "skill_meta_connections" to jxf_app;
grant select, insert, update, delete on "skill_meta_drafts" to jxf_app;
grant select, insert, update, delete on "skill_distribute_groups" to jxf_app;
grant select, insert, update, delete on "skill_distribute_accounts" to jxf_app;
grant select, insert, update, delete on "skill_distribute_jobs" to jxf_app;
