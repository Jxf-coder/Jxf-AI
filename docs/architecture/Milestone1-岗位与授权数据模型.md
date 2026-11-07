# Milestone 1：岗位与授权数据模型（3 表 + RLS 骨架）

> 目标：用最小面积把「组织 / 岗位 / 最小授权」闭环跑通，并**用测试证明越权会失败**。
> 前提：私有化 Docker 部署、单个 Next.js 应用、PostgreSQL + Drizzle、不依赖云端 Supabase。
> 本里程碑**不包含** knowledge / runs / audit 表——它们必须套用本文件验证过的同一套模式扩展。
>
> **术语**：本文的 `roles` 指**企业人员岗位**（root / child / seat），不是 AI 员工。AI 员工是独立实体，不占岗位树、不计入岗位数，见 master-plan §2 术语边界与 Milestone2 §2.10。

---

> **实施记录（2026-10-30，P1 落地时调整）**：实际实现把组织模型拆为三维——`departments`（部门/小组树 + `department_closure`）、`memberships.title`（业务岗位自由文本）、`memberships.access_level`（L1/L2/L3 独立选择），成员直接挂在部门下。下方按「岗位」建模的 DDL 与策略仅作历史参考；实际结构与 RLS 以 `db/migrations/0001_p1_org_departments.sql` 与 `db/policies/*.sql` 为准。

---

## 1. 设计前提（先定死，后面所有表都依赖）

| 项 | 决策 | 理由 |
|---|---|---|
| 租户 | `tenant_id` 存在但恒为单值 | 私有化交付 = 一客户一套部署；留着是为了将来做 SaaS 时不必改表 |
| **隔离粒度** | **岗位（role）**，不是租户 | 真正需要隔离的是 root / child / seat 之间的数据可见性 |
| 读语义 | 岗位自身 + 全部子孙岗位（子树读） | 对应原项目「manager 可读整棵子树」 |
| 写语义 | **仅自身岗位** + 显式 grants 授权目录 | 原项目写侧不扩权，这是对的 |
| 身份注入 | 每个请求一个事务，`SET LOCAL app.user_id / app.role_ids` | 纯 PG 没有 `auth.uid()`，必须自己注入 |
| 身份来源 | 成熟可自托管 Auth 库（Better Auth / Auth.js v5），**不手写会话** | 手写必然重演原项目 10 年 TTL、无吊销的坑 |

---

## 2. 表设计

### 2.1 roles（岗位树）

```sql
create type role_kind as enum ('root', 'child', 'seat');

create table roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  parent_id   uuid references roles(id) on delete restrict,
  kind        role_kind not null,
  slug        text not null,
  name        text not null,
  created_at  timestamptz not null default now(),
  constraint roles_slug_unique unique (tenant_id, parent_id, slug)
);

create index roles_parent_idx on roles (parent_id);
create index roles_tenant_idx on roles (tenant_id);

-- 结构性约束：root 无父，child/seat 必须有父
alter table roles add constraint roles_parent_shape check (
  (kind = 'root'  and parent_id is null) or
  (kind <> 'root' and parent_id is not null)
);
```

### 2.2 role_closure（子树展开表，替代递归 CTE）

```sql
create table role_closure (
  ancestor_id   uuid not null references roles(id) on delete cascade,
  descendant_id uuid not null references roles(id) on delete cascade,
  depth         int  not null,
  primary key (ancestor_id, descendant_id)
);

create index role_closure_desc_idx on role_closure (descendant_id);
```

维护方式：`roles` 上 after insert/update 触发器重建受影响子树（岗位树规模是几十到几百，重建成本可忽略）。

```sql
create or replace function app.rebuild_role_closure() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from role_closure
   where ancestor_id in (select id from roles where tenant_id = new.tenant_id);

  insert into role_closure (ancestor_id, descendant_id, depth)
  with recursive t as (
    -- 每个岗位都是自身祖先（depth=0）；只从 root 起算会漏掉 child/seat 的自读与子树读
    select id as ancestor_id, id as descendant_id, 0 as depth, tenant_id
      from roles
     where tenant_id = new.tenant_id
    union all
    select t.ancestor_id, r.id, t.depth + 1, r.tenant_id
      from t join roles r on r.parent_id = t.descendant_id
  )
  select ancestor_id, descendant_id, depth from t;

  return null;
end $$;
```

> 实施记录：P1 联调时发现，若锚点仅取 `parent_id is null`，闭包只会生成 root 出发的路径，child / seat 将读不到自身与下属。已在迁移 `003_role_closure.sql` 中按上述「全量锚点」版本修正。

### 2.3 memberships（任用 + 等级）

```sql
create type access_level as enum ('L1', 'L2', 'L3');
create type membership_status as enum ('active', 'removed');

create table memberships (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  user_id      uuid not null,        -- 指向 Auth 库的 users.id
  role_id      uuid not null references roles(id) on delete cascade,
  access_level access_level not null default 'L3',
  status       membership_status not null default 'active',
  ssh_enabled  boolean not null default false,
  created_at   timestamptz not null default now(),
  removed_at   timestamptz
);

create unique index memberships_active_unique
  on memberships (user_id, role_id) where status = 'active';

create index memberships_user_idx on memberships (user_id) where status = 'active';
create index memberships_role_idx on memberships (role_id) where status = 'active';

-- 离岗必须留痕
alter table memberships add constraint memberships_removed_shape check (
  (status = 'active'  and removed_at is null) or
  (status = 'removed' and removed_at is not null)
);
```

**业务不变量：任何时刻至少保留一个 L1。**
不要用触发器做（会造成长事务锁），在应用层用事务内校验：

```sql
-- 在同一事务里执行，命中 0 行则回滚
select 1 from memberships
 where tenant_id = $1 and status = 'active' and access_level = 'L1'
   and id <> $2
 for update;
```

### 2.4 role_packs（角色包 = 能看见什么）

```sql
create table role_packs (
  role_id      uuid primary key references roles(id) on delete cascade,
  skill_ids    text[] not null default '{}',
  pipeline_ids text[] not null default '{}',
  updated_at   timestamptz not null default now(),
  updated_by   uuid
);

create index role_packs_skills_idx   on role_packs using gin (skill_ids);
create index role_packs_pipelines_idx on role_packs using gin (pipeline_ids);
```

关键点：**角色包是数据不是代码**（原项目最值得保留的设计）。改权限不发版，改一行 JSON 即可。

---

## 3. RLS 骨架

### 3.1 身份读取函数（STABLE，避免每行子查询）

```sql
create schema if not exists app;

-- 请求开始时由连接层注入一次
create or replace function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- 一次算好、写进 setting，策略里直接读，避免逐行 join memberships
create or replace function app.my_role_ids() returns uuid[]
language sql stable as $$
  select coalesce(nullif(current_setting('app.role_ids', true), '')::uuid[], '{}')
$$;
```

> 性能要点：**把 `my_role_ids` 在请求入口算一次**并 `SET LOCAL`，而不是在策略里每次 join。这比"不敢用 SECURITY DEFINER"重要一百倍。

### 3.2 读/写判定（SECURITY DEFINER 是为了打破递归，不是性能手段）

```sql
-- 读：自身岗位 + 全部子孙
create or replace function app.can_read(target_role uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from role_closure rc
     where rc.descendant_id = target_role
       and rc.ancestor_id = any (app.my_role_ids())
  )
$$;

-- 写：仅自身岗位（不扩权）
create or replace function app.can_write(target_role uuid) returns boolean
language sql stable as $$
  select target_role = any (app.my_role_ids())
$$;

revoke all on function app.can_read(uuid)  from public;
revoke all on function app.can_write(uuid) from public;
grant execute on function app.can_read(uuid), app.can_write(uuid) to app_rw;
```

### 3.3 策略

```sql
alter table roles       enable row level security;
alter table memberships enable row level security;
alter table role_packs  enable row level security;

-- roles：能看到自己和子孙；只有 L1 能建/改岗位结构
create policy roles_read on roles for select
  using (tenant_id = current_setting('app.tenant_id')::uuid and app.can_read(id));

create policy roles_write on roles for all
  using (current_setting('app.access_level') = 'L1')
  with check (current_setting('app.access_level') = 'L1');

-- memberships：能看自己岗位的成员；只有 L1 能改任用与等级
create policy memberships_read on memberships for select
  using (app.can_read(role_id));

create policy memberships_write on memberships for all
  using (current_setting('app.access_level') = 'L1')
  with check (current_setting('app.access_level') = 'L1');

-- role_packs：能读自己子树；子岗位可改自己的包，父岗位不可代改（原项目语义）
create policy role_packs_read on role_packs for select
  using (app.can_read(role_id));

create policy role_packs_write on role_packs for all
  using (app.can_write(role_id))
  with check (app.can_write(role_id));
```

### 3.4 连接层必须做的三件事

1. 每个请求开一个事务，事务内依次执行：
   ```sql
   set local app.user_id      = '<uuid>';
   set local app.tenant_id    = '<uuid>';
   set local app.access_level = '<L1|L2|L3>';
   set local app.role_ids     = '{uuid,uuid}';
   ```
2. **应用连接必须使用非 superuser、非表 owner 的角色（`app_rw`）**，否则 RLS 对 owner 默认不生效。
3. 用 PgBouncer 时只能用 **transaction pooling**（`SET LOCAL` 随事务结束失效，安全）；**session pooling 会把上一个用户身份泄漏给下一个请求**。

---

## 4. 验收测试（这才是 Milestone 1 的完成标准）

| # | 场景 | 期望 |
|---|---|---|
| 1 | seat A 读 seat B 的知识/数据 | 0 行 |
| 2 | child 读自身及下属 seat 的数据 | 可见 |
| 3 | seat 读父岗位私有区 | 0 行 |
| 4 | 已离岗（`status='removed'`）用户发起任意读 | 0 行（不依赖 token 过期） |
| 5 | L3 读 `audit_events` | 拒绝 |
| 6 | L1 读 `audit_events` | 可见 |
| 7 | 显式传别人的 `role_id`（模拟 IDOR） | 0 行，且不报错泄露存在性 |
| 8 | 删除最后一个 L1 | 事务回滚 |
| 9 | 未设置 `app.user_id` 直接查询 | 0 行（不报 500，不降级放行） |
| 10 | 用表 owner / superuser 连接查询 | 必须无法通过（由部署配置保证 `DATABASE_URL` 不含高权账号） |

> 第 9 条尤其重要：原项目的教训是"漏配就走默认放行"。这里必须 fail-closed。

---

## 5. 迁移与文件组织

```
db/
  schema/roles.ts            # Drizzle 表定义（仅表与索引）
  schema/memberships.ts
  schema/role_packs.ts
  policies/001_app_functions.sql   # 函数 + grants（Drizzle 表达不了 RLS，走原生 SQL）
  policies/002_rls_policies.sql
  policies/003_role_closure.sql
  seed/dev.ts                # 一棵最小岗位树：root > 2 child > 3 seat
```

执行顺序：`drizzle-kit migrate` → 再跑 `policies/*.sql`（幂等，`create or replace`）。二者都进 `migrate` 容器，`docker compose up` 时自动执行。

---

## 6. 本里程碑明确不做

- knowledge / chunks / embeddings（下一里程碑，套用同一 RLS 模式）
- threads / runs / run_events / token_usages（运行态，第三里程碑）
- audit_events（事件字典已定，落表很轻，但依赖 roles 先稳定）
- grants（pack/channel 共享授权，等角色包跑通再加）
- 任何 UI

---

## 7. 一句话验收

> 一个 seat 账号拿着自己的会话，无论怎么改请求参数，都读不到兄弟 seat 的任何一行数据；
> 一旦被移出岗位，下一秒就失效；而 L1 能在同一个库里看到全部审计。
> 这三条成立，Milestone 1 才算完成。
