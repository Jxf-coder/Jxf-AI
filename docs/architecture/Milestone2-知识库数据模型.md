# Milestone 2：知识库数据模型（知识卡 + 证据链 + 混合检索 + 入库血缘）

> 前置：Milestone 1 的部门树 / 闭包 / 成员表与 RLS 骨架已跑通，越权测试全部通过。
> 本里程碑所有表**套用 M1 的同一套 RLS 模式**，不另立机制。
> 媒体产线（视频/音乐/数字人）本次不建业务表，只留 `assets` 与关联能力，等产线开工再扩。

---

## 1. 本里程碑要保住的四个资产

来自原项目审计，这四条是真正值钱、且竞品普遍缺失的：

| 资产 | 原项目出处 | 在新模型中的落点 |
|---|---|---|
| 证据链（逐字核对 + 页码定位） | `knowledge/evidence.ts` | `card_evidence(quote, char_start, char_end, verified)` |
| 确认门槛（AI 卡必须有人改过或已核对证据） | `knowledge/store.ts#L227-L234` | `knowledge_cards.confirmable` 视图 + 应用层双保险 |
| 批次血缘（按 runId 整批撤回） | `ingest_runs` 概念 | `ingest_runs / ingest_files` + `cards.ingest_run_id` |
| 回归评测（基线保留率） | `knowledge/regression.ts` | `regression_questions.baseline_ids` + `regression_items` |

明确不做（原项目的问题所在）：文件系统当库、全量读 `cards.json`、TF-IDF 字面检索、`_order.json`、两套知识卡并存。

---

## 2. 表设计

### 2.1 assets（通用对象存储引用，媒体产线的唯一入口）

```sql
create table assets (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  department_id uuid not null references departments(id) on delete cascade,
  storage_key  text not null,          -- MinIO / volume 内的相对路径
  mime         text not null,
  byte_size    bigint not null,
  sha256       text not null,
  kind         text not null,          -- source_doc | image | audio | video | export
  meta         jsonb not null default '{}',
  created_by   uuid not null,
  created_at   timestamptz not null default now()
);

create unique index assets_sha_idx on assets (tenant_id, sha256, department_id);
create index assets_department_idx on assets (department_id, kind);
```

去重靠 `sha256`：同一份资料在同一部门下重复上传只增引用。

### 2.2 ingest_runs / ingest_files（入库批次与血缘）

```sql
create type ingest_kind   as enum ('upload', 'scout', 'manual');
create type ingest_status as enum ('draft', 'running', 'done', 'failed', 'revoked');
create type file_decision as enum ('pending', 'rule_keep', 'rule_skip', 'model_keep', 'model_skip', 'ask', 'error');

create table ingest_runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  department_id uuid not null references departments(id) on delete cascade,
  kind        ingest_kind not null,
  goal        text,
  status      ingest_status not null default 'draft',
  counts      jsonb not null default '{}',   -- 目录数/文件数/保留/丢弃/待定/生成卡/冲突
  created_by  uuid not null,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz,
  error       text
);

create table ingest_files (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references ingest_runs(id) on delete cascade,
  asset_id    uuid references assets(id) on delete set null,
  source_path text not null,
  decision    file_decision not null default 'pending',
  reason      text,
  error       text,
  document_id uuid,
  created_at  timestamptz not null default now()
);

create index ingest_files_run_idx on ingest_files (run_id, decision);
```

> 注：M3 会为 `ingest_runs` 增加 `run_id uuid references runs(id)`——入库本身也是一次执行，需要耗时、重试与事件记录。见 [Milestone3-运行态数据模型.md](./Milestone3-运行态数据模型.md) §8。

撤回语义：`revoke_ingest_run(run_id)` 事务内把该批 `pending` 卡置 `dropped`、`documents` 置 `revoked`、run 置 `revoked`。**已确认的卡不回滚**（人工确认过的不能被一批撤回误伤）。

### 2.3 documents（解析后的文档）

```sql
create type doc_status as enum ('parsed', 'needs_ocr', 'failed', 'revoked');

create table documents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  department_id uuid not null references departments(id) on delete cascade,
  asset_id    uuid references assets(id) on delete set null,
  ingest_run_id uuid references ingest_runs(id) on delete set null,
  title       text not null,
  mime        text not null,
  page_count  int,
  char_count  int not null default 0,
  lang        text default 'zh',
  status      doc_status not null default 'parsed',
  sha256      text not null,
  created_at  timestamptz not null default now()
);

create index documents_department_idx on documents (department_id, status);
```

`status = 'needs_ocr'` 必须显式存在——原项目对扫描件的诚实标注（不假装读过）要保留。

### 2.4 doc_chunks（检索单元 + 定位信息）

```sql
create table doc_chunks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  department_id uuid not null references departments(id) on delete cascade,
  document_id   uuid not null references documents(id) on delete cascade,
  ord           int not null,
  page_no       int,                    -- 来自 "【第 N 页】"
  paragraph_no  int,
  char_start    int not null,
  char_end      int not null,
  text          text not null,
  token_count   int,
  embedding     vector(1024),           -- 维度随 embedding 模型定，改动需重建索引
  tsv           tsvector generated always as (to_tsvector('simple', text)) stored,
  created_at    timestamptz not null default now(),
  unique (document_id, ord)
);

create index doc_chunks_doc_idx  on doc_chunks (document_id, ord);
create index doc_chunks_department_idx on doc_chunks (department_id);
create index doc_chunks_tsv_idx  on doc_chunks using gin (tsv);
create index doc_chunks_vec_idx  on doc_chunks using hnsw (embedding vector_cosine_ops)
  where embedding is not null;
```

**中文分词现实约束**：官方 `postgres:17` 镜像不含 `zhparser` / `pg_bigm`。

| 方案 | 代价 | 建议 |
|---|---|---|
| 自建镜像装 `zhparser` | 需编译 + 词典 | 数据量 > 10 万 chunk 时值得 |
| `pg_bigm` | 有预编译包，CJK 友好 | **推荐起步方案** |
| 只用 `'simple'` 配置 + 向量兜底 | 分词退化到按字，中文召回靠向量 | 可接受的最小可行 |

起步用 `pg_bigm`，`tsv` 那一列改成 `gin (text gin_bigm_ops)`，Drizzle 里用原生 SQL 建索引。

### 2.5 knowledge_cards（知识卡，含状态机）

```sql
create type card_kind   as enum ('object', 'decision', 'preference', 'fact', 'faq', 'case', 'viewpoint');
create type card_status as enum ('pending', 'confirmed', 'dropped');
create type card_origin as enum ('intake', 'distill', 'manual', 'scout');

create table knowledge_cards (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  department_id uuid not null references departments(id) on delete cascade,
  kind          card_kind not null,
  title         text not null,
  body          text not null,
  status        card_status not null default 'pending',
  origin        card_origin not null,
  product       text,
  category      text,
  visibility    text not null default 'shared',   -- shared | admins
  external_ok   boolean not null default false,
  valid_until   date,
  rev           int not null default 1,
  human_edited  boolean not null default false,
  confirmed_by  uuid,
  confirmed_at  timestamptz,
  conflict_with uuid[] not null default '{}',
  ingest_run_id uuid references ingest_runs(id) on delete set null,
  extra         jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index cards_department_status_idx on knowledge_cards (department_id, status);
create index cards_ingest_idx      on knowledge_cards (ingest_run_id);
create index cards_extra_idx       on knowledge_cards using gin (extra);
```

### 2.6 card_evidence（证据链，一次登录多处引用）

```sql
create table card_evidence (
  id          uuid primary key default gen_random_uuid(),
  card_id     uuid not null references knowledge_cards(id) on delete cascade,
  chunk_id    uuid references doc_chunks(id) on delete set null,
  doc_id      uuid references documents(id) on delete set null,
  page_no     int,
  locator     text,
  quote       text not null,            -- 原文片段，≤600 字
  char_start  int,
  char_end    int,
  verified    boolean not null default false,
  verified_at timestamptz,
  unique (card_id, doc_id, char_start, char_end)
);

create index evidence_card_idx on card_evidence (card_id, verified);
```

### 2.7 确认门槛（用视图表达，避免把规则散在代码里）

```sql
create view v_confirmable_cards as
select c.*
  from knowledge_cards c
 where c.status = 'pending'
   and (
     c.human_edited
     or exists (select 1 from card_evidence e where e.card_id = c.id and e.verified)
   )
   and coalesce(cardinality(c.conflict_with), 0) = 0
   and (c.valid_until is null or c.valid_until >= current_date);
```

应用层 `confirm(card_id)` 只允许操作这个视图里的行——**规则进数据库，代码只调用**。

**人工通道的取舍（KB-01）**：手写建卡写入 `origin='manual'` 且 `human_edited=true`，因此不写任何 `card_evidence` 也能通过确认门槛。这是刻意设计——录入者本人就是证据来源，强制逐字证据会让会议记录、经验类知识无法入库。代价是「已确认」不等于「有可追溯引文」：需要可追溯时，应在工作区为卡片补一条证据；AI 通道（文档蒸馏、经验提炼）仍强制至少一条逐字证据，两者的门槛不同属预期行为。

### 2.8 knowledge_gaps / qa_logs（知识运营与回答审计）

```sql
create type gap_status as enum ('open', 'answered', 'closed');

create table knowledge_gaps (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  department_id uuid not null references departments(id) on delete cascade,
  question   text not null,
  status     gap_status not null default 'open',
  source     text,                      -- qa_miss | expired | manual
  created_at timestamptz not null default now()
);

create table qa_logs (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null,
  department_id      uuid not null references departments(id) on delete cascade,
  question           text not null,
  answer             text not null,
  cited_card_ids     uuid[] not null default '{}',
  invalid_cites      uuid[] not null default '{}',   -- 引用了本轮召回之外的卡
  unverified_numbers text[] not null default '{}',   -- 数字不在证据原文里
  gap_id             uuid references knowledge_gaps(id) on delete set null,
  run_id             uuid,                           -- 关联 M3 的 runs
  created_at         timestamptz not null default now()
);
```

`invalid_cites` / `unverified_numbers` 两道校验是原项目最有价值的设计之一：**编号必须在召回集合内、数字必须能在证据原文找到**。

### 2.9 regression（回归评测，CI 门禁）

```sql
create table regression_questions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  department_id uuid not null references departments(id) on delete cascade,
  q            text not null,
  source       text not null default 'manual',   -- intake | manual
  baseline_ids uuid[] not null default '{}',
  created_at   timestamptz not null default now()
);

create table regression_runs (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  department_id uuid not null references departments(id) on delete cascade,
  build_tag text not null,
  total     int not null,
  passed    int not null,
  retained  numeric(5,4) not null,
  created_at timestamptz not null default now()
);

create table regression_items (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references regression_runs(id) on delete cascade,
  question_id uuid not null references regression_questions(id) on delete cascade,
  hit_ids     uuid[] not null default '{}',
  retained    numeric(5,4) not null,
  pass        boolean not null
);
```

门禁规则：`retained < 0.9` 或 `pass < 全部` 时 CI 失败。换 embedding 模型、重建索引、改 chunk 策略都必须过这一关。

### 2.10 ai_employees / ai_employee_grants（P2 建基础，P3 补运行态）

> **本体边界**：AI 员工不是部门。它不进 `departments`、不进 `department_closure`、不参与部门数；它可被多个部门使用，且**自身不携带数据权限**，运行时继承调用者的部门上下文。

```sql
-- AI 员工：可复用的智能体定义（P3 再补 persona / system_prompt / skill_ids / allowed_tools / model_config）
create table ai_employees (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  slug        text not null,
  name        text not null,
  description text,
  status      text not null default 'draft',   -- draft | active | disabled
  created_by  uuid,
  created_at  timestamptz not null default now(),
  unique (tenant_id, slug)
);

-- 使用授权：部门授权为主，个人授权为例外（二选一）
create table ai_employee_grants (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  ai_employee_id uuid not null references ai_employees(id) on delete cascade,
  department_id  uuid references departments(id) on delete cascade,
  user_id        uuid references users(id) on delete cascade,
  capability     text not null default 'use',  -- use | manage
  created_by     uuid,
  created_at     timestamptz not null default now(),
  check (
    (department_id is not null and user_id is null) or
    (department_id is null and user_id is not null)
  )
);

create unique index ai_employee_grants_department_uq
  on ai_employee_grants (ai_employee_id, department_id) where department_id is not null;
create unique index ai_employee_grants_user_uq
  on ai_employee_grants (ai_employee_id, user_id) where user_id is not null;
create index ai_employee_grants_department_idx on ai_employee_grants (department_id);
create index ai_employee_grants_user_idx on ai_employee_grants (user_id);
```

**可见性：Fail-Closed 绝对隔离（不接受"目录全员可见"）**

```sql
-- SECURITY DEFINER：策略里不能直接读 department_closure（已从 jxf_app 撤权）
-- 判定「p_department_id 是否为我所在部门或其祖先」→ 授权给部门即覆盖其全部子部门
create or replace function app.department_linked_to_me(p_department_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from department_closure dc
     where dc.ancestor_id = p_department_id
       and dc.descendant_id = any(app.my_department_ids())
  )
$$;

create or replace function app.ai_employee_visible(p_ai_employee_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from ai_employee_grants g
     where g.ai_employee_id = p_ai_employee_id
       and (
         g.user_id = app.current_user_id()
         or (g.department_id is not null and app.department_linked_to_me(g.department_id))
       )
  )
$$;

create policy ai_employees_read on ai_employees for select using (
  tenant_id = app.current_tenant_id() and app.ai_employee_visible(id)
);

-- 授权表本身也只暴露"与我有关"的行：否则未授权者能从 grants 反推出 AI 员工存在
create policy ai_employee_grants_read on ai_employee_grants for select using (
  tenant_id = app.current_tenant_id()
  and (
    user_id = app.current_user_id()
    or (department_id is not null and app.department_linked_to_me(department_id))
  )
);
```

**授权语义**

| 项 | 规则 |
|---|---|
| 授权对象 | `department_id`（部门，含子树继承）为主；`user_id`（个人例外）为辅；二选一由 check 约束强制 |
| 子树继承 | 授权给某部门后，其全部子部门的成员可见可用（`department_closure` 判定） |
| 默认拒绝 | 无任何 grant → 列表与详情均 0 行，名称/描述不返回 |
| 写权限 | 目录与授权的增删改仅 L1；L1 也不能"看全部"，只能看到自己可读子树内被授权的项 |
| 运行时 | 调用 AI 员工时以调用者身份注入 `SET LOCAL`，知识检索仍受其部门子树限制 |

**验收**：未授权部门查询 `ai_employees` 返回 0 行；授权父部门后子部门成员立即可见；移出部门后下一次请求立即 0 行；`ai_employee_grants` 不泄露无关行。

---

## 3. 混合检索（RLS 之后仍要正确）

### 3.1 关键工程事实

**RLS 是在索引扫描之后过滤的。** 也就是说 `hnsw` 先取 top-k，再被 RLS 砍掉一部分，租户内部门一多，实际召回会掉。

**双保险做法：**

1. 显式加 `department_id = any($department_ids)` 作为**索引可用的前置条件**，让索引在正确集合内检索
2. 仍保留 RLS 作为兜底（防应用层漏条件）
3. 部门数很大时，按 `department_id` 建分区或 partial index

```sql
with vec as (
  select id, row_number() over (order by embedding <=> $1) as rn
    from doc_chunks
   where department_id = any($2)      -- 关键：让索引吃到过滤
     and embedding is not null
   order by embedding <=> $1
   limit 50
),
kw as (
  select id, row_number() over (order by ts_rank(tsv, plainto_tsquery('simple', $3)) desc) as rn
    from doc_chunks
   where department_id = any($2)
     and tsv @@ plainto_tsquery('simple', $3)
   limit 50
)
select id, sum(1.0 / (60 + rn)) as rrf
  from (select * from vec union all select * from kw) u
 group by id
 order by rrf desc
 limit $4;
```

RRF 常数 60 是标准值，不需要调参。

### 3.2 检索结果必须带定位

返回给模型的不只是文本，还要带 `document_id / page_no / char_start / char_end`，这样：
- 回答能附出处（页码）
- `qa_logs.invalid_cites` 可自动校验
- 前端能高亮原文

---

## 4. 验收测试

| # | 场景 | 期望 |
|---|---|---|
| 1 | 部门 A 检索部门 B 的文档（含向量检索） | 0 条，且不因 RLS 过滤导致少召回同级部门数据 |
| 2 | 子部门检索下属部门的文档 | 命中 |
| 3 | 移出部门后发起检索 | 0 条 |
| 4 | 同一文件重复上传两次 | `assets` 一行，引用 2 次 |
| 5 | 扫描件 PDF | `documents.status = needs_ocr`，不生成 chunk |
| 6 | AI 生成的卡未人工编辑、无已核对证据 | 无法 `confirm`（视图里查不到） |
| 7 | 两张卡互相冲突 | 两张都不能 confirm，直到二选一 |
| 8 | 撤回一个 ingest_run | 该批 pending 卡变 dropped；已 confirmed 的不受影响 |
| 9 | 答案引用了不在召回集合里的卡 | `qa_logs.invalid_cites` 非空 |
| 10 | 换 chunk 策略后跑回归 | `retained` 低于 0.9 时 CI 失败 |
| 11 | 中文查询「食品接触材料」 | 能召回同义改写的内容（向量生效） |

第 11 条是判断这次迁移值不值的核心指标——原项目 TF-IDF 在这句话上必然失败。

---

## 5. 迁移与文件组织

```
db/
  schema/assets.ts
  schema/ingest.ts            # ingest_runs / ingest_files
  schema/documents.ts         # documents / doc_chunks
  schema/knowledge.ts         # knowledge_cards / card_evidence / gaps / qa_logs
  schema/regression.ts
  views/v_confirmable_cards.sql
  policies/010_knowledge_rls.sql       # 全部套用 app.can_read / app.can_write
  policies/011_hybrid_search.sql       # 检索函数
  seed/dev.ts                          # 一份 3 页 PDF + 5 条中文问题做冒烟
```

RLS 策略统一写成：

```sql
create policy <table>_read on <table> for select using (app.can_read(department_id));
create policy <table>_write on <table> for all
  using (app.can_write(department_id)) with check (app.can_write(department_id));
```

`doc_chunks` 与 `card_evidence` 冗余了 `department_id`（反范式），就是为了让 RLS 与索引都能直接用到，避免 join 拍平。

---

## 6. 明确不做

- 视频/音乐/数字人业务表（等产线开工，届时只增 `media_*` 表并复用 `assets`）
- OCR 能力（`needs_ocr` 状态先留着，Python worker 上线再接）
- 图谱/双链可视化（原项目的 `graph-extract` 可搬，但不是检索主路径，M4 再说）
- 交接包导出（`handover` 的 schema 值得保留，等知识表稳定后再做）

---

## 7. 一句话验收

> 员工问一个"文档里没原话说过、但换了个说法"的问题，系统能召回正确段落、给出页码、并保证引用的编号真实存在；
> 换一个部门的人问同样的问题，一条都召回不到。
