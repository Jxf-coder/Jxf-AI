-- ============================================================================
-- W1-04 · 汇报线（直属主管）
--
-- - users.manager_user_id：一人一个直属主管，允许跨部门；由 L1 维护
-- - user_manager_closure：汇报线闭包，RLS 里只做等值 join，不写递归 CTE
-- 闭包由 policies/042 的触发器与重建函数维护。
-- ============================================================================

alter table users add column if not exists manager_user_id uuid;
--> statement-breakpoint

alter table users
  add constraint users_manager_fk
  foreign key (manager_user_id) references users(id)
  on delete set null on update cascade;
--> statement-breakpoint

create table if not exists user_manager_closure (
  tenant_id uuid not null,
  ancestor_user_id uuid not null,
  descendant_user_id uuid not null,
  depth integer not null,
  constraint user_manager_closure_pkey
    primary key (tenant_id, ancestor_user_id, descendant_user_id)
);
--> statement-breakpoint

create index if not exists user_manager_closure_desc_idx
  on user_manager_closure (tenant_id, descendant_user_id);
