# Milestone 3：AI 运行时数据模型（threads / runs / steps / events / tool_calls / token_usages）

> 前置：M1 的 RLS 骨架、M2 的知识表已落地。
> 本里程碑的目标不是"编排引擎"，而是**让每一次执行都可受理、可续流、可中止、可收口、可算钱**。
> 明确不做：DAG / 工作流模板引擎 / 跨机调度 / 事件重放重建状态。

---

## 1. 边界：三种"run"不要混

| 概念 | 表 | 语义 |
|---|---|---|
| 会话 | `threads` | 一段连续对话的容器 |
| 执行 | `runs` | **一次** Agent 执行（一个对话回合 / 一个后台任务 / 一个产线步骤） |
| 知识入库 | `ingest_runs`（M2） | 一次资料入库批次，有自己的 files/counts/decision 结构 |

**决策：不合并。** `ingest_runs` 的强结构（逐文件决策、counts）不适合塞进通用 `runs`。
但它本身也是一次执行（有 worker、有耗时、会失败重试），所以**反向引用**：

```sql
-- M3 对 M2 的唯一改动
alter table ingest_runs add column run_id uuid references runs(id) on delete set null;
create index ingest_runs_run_idx on ingest_runs (run_id);
```

同理，M2 的 `qa_logs.run_id` 从此指向 `runs.id`（此前是裸 uuid），补上外键。

---

## 2. 进程模型（先定这个，表才定得对）

```
web 进程（Next.js）        → 只做受理：建 run、返回 run_id、订阅事件
worker 进程（同镜像，不同 command）→ 从 runs 表拉任务执行，写 events / tool_calls / token_usages
```

**铁律：长任务不在 web 进程里跑。** 原项目用 `void runChatTurn(...)` 把回合挂在请求生命周期上，容器重启即静默中断且无法续跑。这里改为：

- 请求只负责 `insert into runs (status='queued')` 并立即返回 `run_id`
- 前端用 `run_id` 订阅事件流
- worker 用 `FOR UPDATE SKIP LOCKED` + 租约领取任务

compose 里新增 `worker-app` 服务（TypeScript，与 web 同一镜像）。它与 `worker`（Python 媒体）不是一回事，不要混名。

---

## 3. 表设计

### 3.1 threads（会话）

```sql
create table threads (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  role_id         uuid not null references roles(id) on delete cascade,
  title           text,
  created_by      uuid not null,
  pinned          boolean not null default false,
  archived_at     timestamptz,
  last_run_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index threads_role_idx on threads (role_id, last_run_at desc nulls last)
  where archived_at is null;
```

### 3.2 runs（一次执行 + 自带队列）

```sql
create type run_kind   as enum ('chat', 'task', 'workflow_step', 'ingest', 'regression');
create type run_status as enum ('queued', 'running', 'interrupted', 'done', 'failed', 'cancelled');

create table runs (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  role_id            uuid not null references roles(id) on delete cascade,
  thread_id          uuid references threads(id) on delete set null,
  kind               run_kind not null,
  status             run_status not null default 'queued',

  -- 幂等：同一个客户端回合 id 只会产生一个 run
  client_turn_id     text,

  principal_id       uuid not null,
  input              jsonb not null default '{}',      -- 用户输入 / 任务参数
  result             jsonb not null default '{}',      -- 终态摘要（不是全文）

  -- 队列与租约
  worker_id          text,
  lease_until        timestamptz,
  heartbeat_at       timestamptz,
  attempts           int not null default 0,

  -- 续流：事件序号游标 + 累积文本快照
  last_seq           bigint not null default 0,
  partial_text       text not null default '',
  partial_updated_at timestamptz,

  cancel_requested_at timestamptz,
  error              text,

  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz not null default now(),

  -- 用量冗余（列表页不必扫 token_usages）
  prompt_tokens      bigint not null default 0,
  completion_tokens  bigint not null default 0,
  cost_micros        bigint not null default 0
);

create unique index runs_client_turn_idx
  on runs (tenant_id, principal_id, client_turn_id)
  where client_turn_id is not null;

-- 队列取任务的支撑索引
create index runs_queue_idx on runs (status, lease_until)
  where status in ('queued', 'running');

create index runs_thread_idx on runs (thread_id, created_at desc);
create index runs_role_idx   on runs (role_id, created_at desc);
```

**为什么队列不单独建表**：`runs` 本身就是队列。状态 + 租约 + 尝试次数三个字段足够，避免"任务表和业务表不一致"这类经典问题。

### 3.3 run_steps（一次模型调用 = 一步）

```sql
create table run_steps (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references runs(id) on delete cascade,
  ord           int  not null,
  phase         text not null,            -- think | answer | tool_loop | compact
  model         text,
  provider      text,
  finish_reason text,
  duration_ms   int,
  created_at    timestamptz not null default now(),
  unique (run_id, ord)
);

create index run_steps_run_idx on run_steps (run_id, ord);
```

存在的理由：模型进度、思考档位、压缩重启这些 UI 需求都要"第几步"这个粒度；原项目靠前端解析 SSE 猜，不可靠。

### 3.4 run_events（durable 事件流）

```sql
create table run_events (
  run_id     uuid not null references runs(id) on delete cascade,
  seq        bigint not null,
  role_id    uuid not null,               -- 反范式，供 RLS 与索引直接使用
  type       text not null,               -- status | step | tool | done | error | cancelled | deposited
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key (run_id, seq)
);

create index run_events_role_idx on run_events (role_id, created_at desc);
```

**关键设计：事件分两类，只有 durable 才落库。**

| 类型 | 例子 | 落库 |
|---|---|---|
| durable | `status`、`step`、`tool`、`done`、`error`、`cancelled` | ✅ |
| transient | `text_delta`、`thinking_delta`、心跳 | ❌ 只走 SSE；断线用 `runs.partial_text` 快照恢复 |

原项目把**每个非瞬时事件都全量重写一次 JSON 文件**，产线回合每秒级写放大；这里只 insert 少量 durable 事件，delta 一律不落库。

### 3.5 tool_calls（工具调用与耗时）

```sql
create table tool_calls (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references runs(id) on delete cascade,
  step_id        uuid references run_steps(id) on delete set null,
  role_id        uuid not null,
  tool_name      text not null,
  args_redacted  jsonb not null default '{}',   -- 写库前脱敏
  status         text not null,                 -- ok | error | denied | timeout
  result_chars   int,
  result_preview text,                          -- ≤ 2000 字
  duration_ms    int,
  error          text,
  created_at     timestamptz not null default now()
);

create index tool_calls_run_idx  on tool_calls (run_id, created_at);
create index tool_calls_name_idx on tool_calls (role_id, tool_name, created_at desc);
```

`tool_calls` 同时是**审计的事件源**（M5 的 `audit_events` 可从它派生，不必双写）。

### 3.6 token_usages（成本账本）

```sql
create table token_usages (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  role_id           uuid not null references roles(id) on delete cascade,
  run_id            uuid references runs(id) on delete set null,
  step_id           uuid references run_steps(id) on delete set null,
  provider          text not null,
  model             text not null,
  prompt_tokens     int not null default 0,
  completion_tokens int not null default 0,
  cached_tokens     int not null default 0,
  cost_micros       bigint not null default 0,
  created_at        timestamptz not null default now()
);

create index token_usages_role_idx on token_usages (role_id, created_at desc);
create index token_usages_run_idx  on token_usages (run_id);
```

成本按整数微元存（`cost_micros`），不用浮点，避免报表累加误差。价格表放代码里的常量或 `model_prices` 表，不硬编码在调用处。

---

## 4. 关键机制

### 4.1 seq 原子递增（并发安全）

```sql
-- 写事件与取序号在同一语句族里完成，避免 max(seq)+1 竞态
update runs set last_seq = last_seq + 1 where id = $1 returning last_seq;
insert into run_events (run_id, seq, role_id, type, payload) values ($1, $seq, $role_id, $type, $payload);
```

两条语句必须在**同一事务**内。worker 是单个 run 的唯一写者，因此无锁竞争。

### 4.2 续流（不丢窗口的顺序）

```
1. 前端订阅（先建立监听）
2. 服务端：先推 runs.partial_text 快照（如果 status='running'）
3. 再按 after=<客户端最后 seq> 补发 durable 事件
4. 之后推实时的 durable 事件 + transient delta
```

顺序必须是 **先订阅、后补发**，否则补发与实时之间会丢事件。重连时携带 `lastSeq`，服务端据此补。

### 4.3 实时推送（单机）

- durable 事件写库后，通过**进程内 broadcaster** 推给订阅者（`run_id → Set<subscription>`）
- web 与 worker 是**不同进程**，所以 worker 写库后需要唤醒 web。单机做法：
  - 方案 A（推荐起步）：web 侧轮询 `run_events where seq > lastSeq`（间隔 300ms），简单可靠，代价可控
  - 方案 B：`LISTEN/NOTIFY`（payload ≤ 8000B，仅作唤醒信号，事件正文仍从库读）
  - 方案 C：横向扩展时才上 Redis Pub/Sub
- **绝不允许**把事件正文塞进 NOTIFY 的 payload

### 4.4 收口（重启与超时）

```sql
-- 启动时：把不属于本进程的 running 收口
update runs
   set status = 'interrupted', finished_at = now(),
       error = coalesce(error, 'worker restarted')
 where status = 'running'
   and (worker_id is distinct from $current_worker);

-- 心跳巡检：60s 未心跳视为失联
update runs
   set status = 'interrupted', finished_at = now(), error = 'heartbeat timeout'
 where status = 'running' and heartbeat_at < now() - interval '60 seconds';
```

`interrupted` 与 `failed` 必须分开：前者可"继续执行"，后者需要人介入。

### 4.5 租约与领取

```sql
with picked as (
  select id from runs
   where status = 'queued'
      or (status = 'running' and lease_until < now())      -- 过期回收
   order by created_at
   for update skip locked
   limit 1
)
update runs r
   set status = 'running',
       worker_id = $1,
       lease_until = now() + interval '90 seconds',
       attempts = attempts + 1,
       started_at = coalesce(started_at, now())
  from picked p
 where r.id = p.id
returning r.*;
```

执行期间每 30 秒续租一次。`attempts` 超过上限（建议 3）直接置 `failed`，不再无限重试。

### 4.6 取消

- 前端点「中止」→ `update runs set cancel_requested_at = now()`
- worker 在每个 step 边界检查该字段，命中则写一条 `cancelled` 事件并结束
- **SSE 断开 ≠ 取消**（原项目在这点上做对了，语义要保留）

### 4.7 幂等受理

`client_turn_id` 唯一索引保证同一个前端回合重复提交（双击、重试）只产生一个 run；插入冲突时返回既有 `run_id` 并标记 `resumed: true`。

---

## 5. RLS

全部表按 `role_id` 走 M1 的函数，不引入新机制：

```sql
alter table threads      enable row level security;
alter table runs         enable row level security;
alter table run_events   enable row level security;
alter table run_steps    enable row level security;
alter table tool_calls   enable row level security;
alter table token_usages enable row level security;

create policy threads_read      on threads      for select using (app.can_read(role_id));
create policy runs_read         on runs         for select using (app.can_read(role_id));
create policy runs_write        on runs         for all using (app.can_write(role_id)) with check (app.can_write(role_id));
create policy run_events_read   on run_events   for select using (app.can_read(role_id));
create policy tool_calls_read   on tool_calls   for select using (app.can_read(role_id));
create policy token_usages_read on token_usages for select using (app.can_read(role_id));
```

注意两点：

1. `runs` 的**写**只允许本人岗位（`can_write`），但 worker 需要写别人的 run——因此 worker 连接使用**专用受限角色 `app_worker`**，仅授予这几张表所需权限，且**只允许 UPDATE 自己的 `worker_id`**（用 `with check` 约束）。不能让 worker 持有 owner 权限。
2. `run_steps` / `run_events` / `tool_calls` 无 delete 策略：事件流只追加，不允许业务侧删除。

---

## 6. 验收测试

| # | 场景 | 期望 |
|---|---|---|
| 1 | 杀掉 worker 进程后重启 | 该 run 变 `interrupted`（不是 `failed`），可继续执行 |
| 2 | 前端断线，30 秒后带 `lastSeq` 重连 | 不重复、不丢事件；先拿到 `partial_text` 快照 |
| 3 | 同一 `client_turn_id` 并发提交 5 次 | 只有 1 个 run，其余返回同一 `run_id` + `resumed` |
| 4 | 两个 worker 同时抢任务 | 只有一个领取成功（SKIP LOCKED） |
| 5 | 领取后不续租，90 秒后 | 任务被回收，`attempts` 递增 |
| 6 | `attempts` 达 3 | 置 `failed`，不再重试 |
| 7 | 点「中止」后 | 下一 step 边界停止，写 `cancelled` 事件，status=`cancelled` |
| 8 | 关闭浏览器（SSE 断开） | run 继续执行，不被取消 |
| 9 | 跑一次 300 事件的长任务 | `run_events` 只增 durable 行（不含 delta），行数可控 |
| 10 | 跨岗位读 `run_events` / `token_usages` | 0 行 |
| 11 | 每次模型调用 | `token_usages` 恰好一行，`runs.cost_micros` 等于其累加 |
| 12 | 运行列表页（该岗位 5 万条 run） | 不扫事件表，响应 < 200ms |

---

## 7. 文件组织

```
db/
  schema/runtime.ts              # threads / runs / run_steps / run_events / tool_calls / token_usages
  policies/020_runtime_rls.sql   # RLS + app_worker 角色授权
  policies/021_runtime_fns.sql   # claim_run / heartbeat / reclaim / finish 等函数
src/
  lib/runtime/
    accept.ts     # 受理：建 run、幂等、返回 run_id
    claim.ts      # 领取：SKIP LOCKED + 租约
    emit.ts       # 事件写入（seq 原子递增 + 分级）
    broker.ts     # 本地订阅与补发
    cancel.ts     # 取消检查
    usage.ts      # token 记账
  worker/
    main.ts       # worker-app 进程入口（循环 claim → execute → finish）
```

---

## 8. 对前序里程碑的改动（一次说清）

| 表 | 改动 | 原因 |
|---|---|---|
| `ingest_runs`（M2） | 增加 `run_id uuid references runs(id)` | 入库本身是一次执行，需要耗时/重试/事件记录 |
| `qa_logs`（M2） | `run_id` 补外键 | 回答审计要能回指到执行 |
| `runs`（新增） | — | — |

除此之外 M1/M2 的列不变。

---

## 9. 明确不做

- 工作流模板表 / DAG 定义（`kind='workflow_step'` 只作为分类，不含模板）
- 跨机调度与分片（单机，`worker_id` 仅用于区分进程）
- 事件重放重建状态（当前状态以 `runs.status` + `partial_text` 为准）
- 思考过程的持久化（transient，不落库）
