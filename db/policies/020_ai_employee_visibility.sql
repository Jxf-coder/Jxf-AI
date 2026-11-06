-- ---------------------------------------------------------------------------
-- 020 AI 员工 Fail-Closed 可见性
--
-- 覆盖 017 里「租户内全员可读」的临时策略（master-plan §3.1 红线 #5）：
--   1. draft：仅创建者与 L1 可见（草稿不上线，不向被授权部门暴露半成品）
--   2. active / disabled：由授权决定；未授权者连名称与描述都拿不到
--   3. 部门授权沿 department_closure 向下继承：授权父部门 = 覆盖其子树
--   4. 授权表本身也只暴露「与我有关」的行；L1 额外可见其可见员工的全部授权（管理需要）
--
-- 判定函数必须 SECURITY DEFINER：策略内不能直接读 department_closure
-- （该表已从 jxf_app 撤权），同时也避免 ai_employees ↔ grants 的策略递归。
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 授权部门是否是我所在部门或其祖先（true = 授权覆盖到我）
-- ---------------------------------------------------------------------------
create or replace function app.department_linked_to_me(p_department_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from department_closure dc
     where dc.ancestor_id = p_department_id
       and dc.descendant_id = any (app.my_department_ids())
  )
$fn$;

revoke all on function app.department_linked_to_me(uuid) from public;
grant execute on function app.department_linked_to_me(uuid) to jxf_app;

-- ---------------------------------------------------------------------------
-- 该 AI 员工是否与我有关：个人授权命中，或部门授权经子树命中
-- ---------------------------------------------------------------------------
create or replace function app.ai_employee_visible(p_ai_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
      from ai_employee_grants g
     where g.ai_employee_id = p_ai_employee_id
       and g.tenant_id = app.current_tenant_id()
       and (
         g.user_id = app.current_user_id()
         or (g.department_id is not null and app.department_linked_to_me(g.department_id))
       )
  )
$fn$;

revoke all on function app.ai_employee_visible(uuid) from public;
grant execute on function app.ai_employee_visible(uuid) to jxf_app;

-- ---------------------------------------------------------------------------
-- 读策略：草稿仅创建者 / L1；已上线与停用按授权
-- ---------------------------------------------------------------------------
drop policy if exists ai_employees_read on ai_employees;
create policy ai_employees_read on ai_employees
  for select
  using (
    tenant_id = app.current_tenant_id()
    and (
      (
        status = 'draft'
        and (
          created_by = app.current_user_id()
          or app.current_access_level() = 'L1'
        )
      )
      or (status <> 'draft' and app.ai_employee_visible(id))
    )
  );

-- ---------------------------------------------------------------------------
-- 授权表：普通用户只看与自己相关的行；L1 可看其可见员工的全部授权
-- 子查询读 ai_employees 会自动套用上面的策略，等价于「该员工对 L1 可见」
-- ---------------------------------------------------------------------------
drop policy if exists ai_employee_grants_read on ai_employee_grants;
create policy ai_employee_grants_read on ai_employee_grants
  for select
  using (
    tenant_id = app.current_tenant_id()
    and (
      user_id = app.current_user_id()
      or (department_id is not null and app.department_linked_to_me(department_id))
      or (
        app.current_access_level() = 'L1'
        and exists (
          select 1 from ai_employees e
           where e.id = ai_employee_grants.ai_employee_id
        )
      )
    )
  );
