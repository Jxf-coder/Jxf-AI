-- ============================================================================
-- M2-A2 · 知识库 RLS + 确认门槛视图 + 混合检索
--
-- 1. 14 张知识库表启用 RLS：读走子树（app.can_read），写限本部门（app.can_write）
-- 2. v_confirmable_cards：确认门槛只由视图表达（人工编辑过 或 有已核对证据，
--    且无冲突、未过期），应用层只允许操作视图内的行
-- 3. 中文关键词索引：pg_bigm（gin_bigm_ops）。不使用 tsvector——实测
--    to_tsvector('simple', '食品接触材料的迁移量要求') 会把整句当成一个 token
-- 4. app.hybrid_search：切片级混合检索（RRF），embedding 为空时自动降级为纯关键词
-- 5. app.hybrid_search_cards：卡片级混合检索，供单轮 RAG 引用（只召回 confirmed）
--
-- 幂等：create or replace / drop policy if exists / create index if not exists
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 读范围：当前部门上下文的子树（L1 的 my_department_ids 已是全租户）
-- 显式给出 uuid[] 而不是逐行调用 can_read，让 department_id 过滤能吃到索引
-- ---------------------------------------------------------------------------
create or replace function app.read_scope_ids() returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(array_agg(distinct dc.descendant_id), '{}'::uuid[])
    from department_closure dc
   where dc.ancestor_id = any (app.my_department_ids())
$fn$;

revoke all on function app.read_scope_ids() from public;
grant execute on function app.read_scope_ids() to jxf_app;

-- ---------------------------------------------------------------------------
-- 关键词模式：把中文问题切成 pg_bigm 可用的「%词%」模式
--   长度 ≤ 4 的片段整体作为关键词；更长的片段按二元组切分（pg_bigm 最小匹配单元）
-- ---------------------------------------------------------------------------
create or replace function app.keyword_patterns(p_query text) returns text[]
language sql
immutable
as $fn$
  with seg as (
    select btrim(t.s) as s
      from regexp_split_to_table(coalesce(p_query, ''), '[^0-9A-Za-z一-龥]+') as t(s)
     where char_length(btrim(t.s)) >= 2
  ),
  parts as (
    select s as p from seg where char_length(s) <= 4
    union
    select substr(s, i, 2)
      from seg, lateral generate_series(1, char_length(s) - 1) as i
     where char_length(s) > 4
  ),
  picked as (
    select distinct p from parts where char_length(p) >= 2 limit 16
  )
  select coalesce(array_agg('%' || p || '%'), '{}'::text[]) from picked
$fn$;

revoke all on function app.keyword_patterns(text) from public;
grant execute on function app.keyword_patterns(text) to jxf_app;

-- ---------------------------------------------------------------------------
-- 中文关键词索引
-- ---------------------------------------------------------------------------
create index if not exists doc_chunks_text_bigm_idx
  on doc_chunks using gin (text gin_bigm_ops);

create index if not exists knowledge_cards_title_bigm_idx
  on knowledge_cards using gin (title gin_bigm_ops);

create index if not exists knowledge_cards_body_bigm_idx
  on knowledge_cards using gin (body gin_bigm_ops);

-- ============================================================================
-- RLS
-- ============================================================================
alter table assets                enable row level security;
alter table ingest_runs           enable row level security;
alter table ingest_files          enable row level security;
alter table documents             enable row level security;
alter table doc_chunks            enable row level security;
alter table knowledge_cards       enable row level security;
alter table card_evidence         enable row level security;
alter table knowledge_gaps        enable row level security;
alter table qa_logs               enable row level security;
alter table regression_questions  enable row level security;
alter table regression_runs       enable row level security;
alter table regression_items      enable row level security;
alter table ai_employees          enable row level security;
alter table ai_employee_grants    enable row level security;

-- ---------------------------------------------------------------------------
-- assets：子树可读；写限本部门，且 created_by 必须是调用者本人
-- ---------------------------------------------------------------------------
drop policy if exists assets_read on assets;
create policy assets_read on assets
  for select
  using (tenant_id = app.current_tenant_id() and app.can_read(department_id));

drop policy if exists assets_insert on assets;
create policy assets_insert on assets
  for insert
  with check (
    tenant_id = app.current_tenant_id()
    and app.can_write(department_id)
    and created_by = app.current_user_id()
  );

drop policy if exists assets_update on assets;
create policy assets_update on assets
  for update
  using (tenant_id = app.current_tenant_id() and app.can_write(department_id))
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists assets_delete on assets;
create policy assets_delete on assets
  for delete
  using (tenant_id = app.current_tenant_id() and app.can_write(department_id));

-- ---------------------------------------------------------------------------
-- ingest_runs / ingest_files：批次是入库的操作单元，读子树、写本部门
-- ingest_files 无 tenant/department，统一经 run 判定
-- ---------------------------------------------------------------------------
drop policy if exists ingest_runs_read on ingest_runs;
create policy ingest_runs_read on ingest_runs
  for select
  using (tenant_id = app.current_tenant_id() and app.can_read(department_id));

drop policy if exists ingest_runs_insert on ingest_runs;
create policy ingest_runs_insert on ingest_runs
  for insert
  with check (
    tenant_id = app.current_tenant_id()
    and app.can_write(department_id)
    and created_by = app.current_user_id()
  );

drop policy if exists ingest_runs_update on ingest_runs;
create policy ingest_runs_update on ingest_runs
  for update
  using (tenant_id = app.current_tenant_id() and app.can_write(department_id))
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists ingest_files_read on ingest_files;
create policy ingest_files_read on ingest_files
  for select
  using (
    exists (
      select 1 from ingest_runs r
       where r.id = ingest_files.run_id
         and r.tenant_id = app.current_tenant_id()
         and app.can_read(r.department_id)
    )
  );

drop policy if exists ingest_files_insert on ingest_files;
create policy ingest_files_insert on ingest_files
  for insert
  with check (
    exists (
      select 1 from ingest_runs r
       where r.id = ingest_files.run_id
         and r.tenant_id = app.current_tenant_id()
         and app.can_write(r.department_id)
    )
  );

drop policy if exists ingest_files_update on ingest_files;
create policy ingest_files_update on ingest_files
  for update
  using (
    exists (
      select 1 from ingest_runs r
       where r.id = ingest_files.run_id
         and r.tenant_id = app.current_tenant_id()
         and app.can_write(r.department_id)
    )
  )
  with check (
    exists (
      select 1 from ingest_runs r
       where r.id = ingest_files.run_id
         and r.tenant_id = app.current_tenant_id()
         and app.can_write(r.department_id)
    )
  );

-- ---------------------------------------------------------------------------
-- documents / doc_chunks：读子树、写本部门
-- ---------------------------------------------------------------------------
drop policy if exists documents_read on documents;
create policy documents_read on documents
  for select
  using (tenant_id = app.current_tenant_id() and app.can_read(department_id));

drop policy if exists documents_insert on documents;
create policy documents_insert on documents
  for insert
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists documents_update on documents;
create policy documents_update on documents
  for update
  using (tenant_id = app.current_tenant_id() and app.can_write(department_id))
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists documents_delete on documents;
create policy documents_delete on documents
  for delete
  using (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists doc_chunks_read on doc_chunks;
create policy doc_chunks_read on doc_chunks
  for select
  using (tenant_id = app.current_tenant_id() and app.can_read(department_id));

drop policy if exists doc_chunks_insert on doc_chunks;
create policy doc_chunks_insert on doc_chunks
  for insert
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists doc_chunks_update on doc_chunks;
create policy doc_chunks_update on doc_chunks
  for update
  using (tenant_id = app.current_tenant_id() and app.can_write(department_id))
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists doc_chunks_delete on doc_chunks;
create policy doc_chunks_delete on doc_chunks
  for delete
  using (tenant_id = app.current_tenant_id() and app.can_write(department_id));

-- ---------------------------------------------------------------------------
-- knowledge_cards / card_evidence
-- 确认动作不在此处拦截：由 v_confirmable_cards 表达门槛，应用层只操作视图内的行
-- ---------------------------------------------------------------------------
drop policy if exists knowledge_cards_read on knowledge_cards;
create policy knowledge_cards_read on knowledge_cards
  for select
  using (tenant_id = app.current_tenant_id() and app.can_read(department_id));

drop policy if exists knowledge_cards_insert on knowledge_cards;
create policy knowledge_cards_insert on knowledge_cards
  for insert
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists knowledge_cards_update on knowledge_cards;
create policy knowledge_cards_update on knowledge_cards
  for update
  using (tenant_id = app.current_tenant_id() and app.can_write(department_id))
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists knowledge_cards_delete on knowledge_cards;
create policy knowledge_cards_delete on knowledge_cards
  for delete
  using (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists card_evidence_read on card_evidence;
create policy card_evidence_read on card_evidence
  for select
  using (
    exists (
      select 1 from knowledge_cards k
       where k.id = card_evidence.card_id
         and k.tenant_id = app.current_tenant_id()
         and app.can_read(k.department_id)
    )
  );

drop policy if exists card_evidence_insert on card_evidence;
create policy card_evidence_insert on card_evidence
  for insert
  with check (
    exists (
      select 1 from knowledge_cards k
       where k.id = card_evidence.card_id
         and k.tenant_id = app.current_tenant_id()
         and app.can_write(k.department_id)
    )
  );

drop policy if exists card_evidence_update on card_evidence;
create policy card_evidence_update on card_evidence
  for update
  using (
    exists (
      select 1 from knowledge_cards k
       where k.id = card_evidence.card_id
         and k.tenant_id = app.current_tenant_id()
         and app.can_write(k.department_id)
    )
  )
  with check (
    exists (
      select 1 from knowledge_cards k
       where k.id = card_evidence.card_id
         and k.tenant_id = app.current_tenant_id()
         and app.can_write(k.department_id)
    )
  );

drop policy if exists card_evidence_delete on card_evidence;
create policy card_evidence_delete on card_evidence
  for delete
  using (
    exists (
      select 1 from knowledge_cards k
       where k.id = card_evidence.card_id
         and k.tenant_id = app.current_tenant_id()
         and app.can_write(k.department_id)
    )
  );

-- ---------------------------------------------------------------------------
-- knowledge_gaps：任何可读者提问都可能沉淀缺口；关闭缺口要求本部门写权限
-- ---------------------------------------------------------------------------
drop policy if exists knowledge_gaps_read on knowledge_gaps;
create policy knowledge_gaps_read on knowledge_gaps
  for select
  using (tenant_id = app.current_tenant_id() and app.can_read(department_id));

drop policy if exists knowledge_gaps_insert on knowledge_gaps;
create policy knowledge_gaps_insert on knowledge_gaps
  for insert
  with check (tenant_id = app.current_tenant_id() and app.can_read(department_id));

drop policy if exists knowledge_gaps_update on knowledge_gaps;
create policy knowledge_gaps_update on knowledge_gaps
  for update
  using (tenant_id = app.current_tenant_id() and app.can_write(department_id))
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists knowledge_gaps_delete on knowledge_gaps;
create policy knowledge_gaps_delete on knowledge_gaps
  for delete
  using (tenant_id = app.current_tenant_id() and app.can_write(department_id));

-- ---------------------------------------------------------------------------
-- qa_logs：问答审计，可读者可写自己的问答记录；不提供更新/删除策略
-- ---------------------------------------------------------------------------
drop policy if exists qa_logs_read on qa_logs;
create policy qa_logs_read on qa_logs
  for select
  using (tenant_id = app.current_tenant_id() and app.can_read(department_id));

drop policy if exists qa_logs_insert on qa_logs;
create policy qa_logs_insert on qa_logs
  for insert
  with check (tenant_id = app.current_tenant_id() and app.can_read(department_id));

-- ---------------------------------------------------------------------------
-- 回归题集 / 运行 / 明细
-- ---------------------------------------------------------------------------
drop policy if exists regression_questions_read on regression_questions;
create policy regression_questions_read on regression_questions
  for select
  using (tenant_id = app.current_tenant_id() and app.can_read(department_id));

drop policy if exists regression_questions_write on regression_questions;
create policy regression_questions_write on regression_questions
  for insert
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists regression_questions_update on regression_questions;
create policy regression_questions_update on regression_questions
  for update
  using (tenant_id = app.current_tenant_id() and app.can_write(department_id))
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists regression_questions_delete on regression_questions;
create policy regression_questions_delete on regression_questions
  for delete
  using (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists regression_runs_read on regression_runs;
create policy regression_runs_read on regression_runs
  for select
  using (tenant_id = app.current_tenant_id() and app.can_read(department_id));

drop policy if exists regression_runs_insert on regression_runs;
create policy regression_runs_insert on regression_runs
  for insert
  with check (tenant_id = app.current_tenant_id() and app.can_write(department_id));

drop policy if exists regression_items_read on regression_items;
create policy regression_items_read on regression_items
  for select
  using (
    exists (
      select 1 from regression_runs r
       where r.id = regression_items.run_id
         and r.tenant_id = app.current_tenant_id()
         and app.can_read(r.department_id)
    )
  );

drop policy if exists regression_items_insert on regression_items;
create policy regression_items_insert on regression_items
  for insert
  with check (
    exists (
      select 1 from regression_runs r
       where r.id = regression_items.run_id
         and r.tenant_id = app.current_tenant_id()
         and app.can_write(r.department_id)
    )
  );

-- ---------------------------------------------------------------------------
-- AI 员工：租户内可读；定义与授权属于组织治理，仅 L1 可写
-- ---------------------------------------------------------------------------
drop policy if exists ai_employees_read on ai_employees;
create policy ai_employees_read on ai_employees
  for select
  using (tenant_id = app.current_tenant_id());

drop policy if exists ai_employees_insert on ai_employees;
create policy ai_employees_insert on ai_employees
  for insert
  with check (tenant_id = app.current_tenant_id() and app.current_access_level() = 'L1');

drop policy if exists ai_employees_update on ai_employees;
create policy ai_employees_update on ai_employees
  for update
  using (tenant_id = app.current_tenant_id() and app.current_access_level() = 'L1')
  with check (tenant_id = app.current_tenant_id() and app.current_access_level() = 'L1');

drop policy if exists ai_employees_delete on ai_employees;
create policy ai_employees_delete on ai_employees
  for delete
  using (tenant_id = app.current_tenant_id() and app.current_access_level() = 'L1');

drop policy if exists ai_employee_grants_read on ai_employee_grants;
create policy ai_employee_grants_read on ai_employee_grants
  for select
  using (tenant_id = app.current_tenant_id());

drop policy if exists ai_employee_grants_insert on ai_employee_grants;
create policy ai_employee_grants_insert on ai_employee_grants
  for insert
  with check (tenant_id = app.current_tenant_id() and app.current_access_level() = 'L1');

drop policy if exists ai_employee_grants_update on ai_employee_grants;
create policy ai_employee_grants_update on ai_employee_grants
  for update
  using (tenant_id = app.current_tenant_id() and app.current_access_level() = 'L1')
  with check (tenant_id = app.current_tenant_id() and app.current_access_level() = 'L1');

drop policy if exists ai_employee_grants_delete on ai_employee_grants;
create policy ai_employee_grants_delete on ai_employee_grants
  for delete
  using (tenant_id = app.current_tenant_id() and app.current_access_level() = 'L1');

-- ============================================================================
-- 确认门槛视图
-- 四条门槛同时满足才可确认：
--   1. 仍是 pending（未确认 / 未废弃）
--   2. 无冲突卡（conflict_with 为空）
--   3. 未过期（valid_until 为空或 >= 今天）
--   4. 人工编辑过 或 至少一条已核对证据
-- security_invoker = true：视图裸奔会以 owner 身份绕过 RLS
-- ============================================================================
create or replace view v_confirmable_cards
with (security_invoker = true)
as
select c.*
  from knowledge_cards c
 where c.status = 'pending'
   and c.conflict_with = '{}'::uuid[]
   and (c.valid_until is null or c.valid_until >= current_date)
   and (
     c.human_edited
     or exists (
       select 1 from card_evidence e
        where e.card_id = c.id
          and e.verified
          and btrim(e.quote) <> ''
     )
   );

grant select on v_confirmable_cards to jxf_app;

-- ============================================================================
-- 切片级混合检索（RRF）
--   关键词通道：pg_bigm（gin_bigm_ops）
--   向量通道：hnsw（vector_cosine_ops）
--   p_embedding 为空（无 Key / 调用失败）时自动退化为纯关键词
-- ============================================================================
create or replace function app.hybrid_search(
  p_query text,
  p_embedding vector(1024) default null,
  p_limit integer default 8,
  p_rrf_k integer default 60
)
returns table (
  chunk_id uuid,
  document_id uuid,
  department_id uuid,
  doc_title text,
  page_no integer,
  char_start integer,
  char_end integer,
  body text,
  keyword_rank integer,
  vector_rank integer,
  score double precision
)
language sql
stable
as $fn$
  with patterns as (
    select app.keyword_patterns(p_query) as pats
  ),
  scope as (
    select app.read_scope_ids() as ids
  ),
  keyword_hits as (
    select c.id,
           c.document_id,
           c.department_id,
           c.page_no,
           c.char_start,
           c.char_end,
           c.text,
           (select count(*) from unnest(p.pats) as pat where c.text like pat) as hits
      from doc_chunks c
      join documents d0 on d0.id = c.document_id and d0.status <> 'revoked' and d0.deleted_at is null
      cross join patterns p
      cross join scope s
     where c.department_id = any (s.ids)
       and c.text like any (p.pats)
  ),
  keyword_ranked as (
    select k.*,
           row_number() over (order by k.hits desc, char_length(k.text) asc, k.id) as rnk
      from keyword_hits k
     order by hits desc, char_length(text) asc, id
     limit greatest(p_limit * 4, 20)
  ),
  vector_ranked as (
    select c.id,
           row_number() over (order by c.embedding <=> p_embedding) as rnk
      from doc_chunks c
      join documents d0 on d0.id = c.document_id and d0.status <> 'revoked' and d0.deleted_at is null
      cross join scope s
     where p_embedding is not null
       and c.embedding is not null
       and c.department_id = any (s.ids)
     order by c.embedding <=> p_embedding
     limit greatest(p_limit * 4, 20)
  ),
  fused as (
    select coalesce(k.id, v.id) as cid,
           k.rnk as krnk,
           v.rnk as vrnk,
           (coalesce(1.0 / (p_rrf_k + k.rnk), 0)
            + coalesce(1.0 / (p_rrf_k + v.rnk), 0))::double precision as rrf
      from keyword_ranked k
      full outer join vector_ranked v on v.id = k.id
  )
  select f.cid,
         c.document_id,
         c.department_id,
         d.title,
         c.page_no,
         c.char_start,
         c.char_end,
         c.text,
         f.krnk::integer,
         f.vrnk::integer,
         f.rrf
    from fused f
    join doc_chunks c on c.id = f.cid
    join documents d on d.id = c.document_id
   order by f.rrf desc, c.id
   limit p_limit
$fn$;

revoke all on function app.hybrid_search(text, vector, integer, integer) from public;
grant execute on function app.hybrid_search(text, vector, integer, integer) to jxf_app;

-- ============================================================================
-- 卡片级混合检索（单轮 RAG 的召回入口）
--   只召回 confirmed 卡片：pending 卡不得进入答案
--   关键词通道：卡片 title/body（pg_bigm）
--   向量通道：切片 → card_evidence → 卡片，取该卡最相近切片
-- ============================================================================
create or replace function app.hybrid_search_cards(
  p_query text,
  p_embedding vector(1024) default null,
  p_limit integer default 6,
  p_rrf_k integer default 60
)
returns table (
  card_id uuid,
  department_id uuid,
  kind card_kind,
  title text,
  body text,
  keyword_rank integer,
  vector_rank integer,
  score double precision
)
language sql
stable
as $fn$
  with patterns as (
    select app.keyword_patterns(p_query) as pats
  ),
  scope as (
    select app.read_scope_ids() as ids
  ),
  keyword_hits as (
    select k.id,
           (select count(*) from unnest(p.pats) as pat
             where k.title like pat or k.body like pat) as hits
      from knowledge_cards k
      cross join patterns p
      cross join scope s
     where k.status = 'confirmed'
       and k.department_id = any (s.ids)
       and (k.title like any (p.pats) or k.body like any (p.pats))
  ),
  keyword_ranked as (
    select h.id,
           row_number() over (order by h.hits desc, h.id) as rnk
      from keyword_hits h
     order by hits desc, id
     limit greatest(p_limit * 4, 20)
  ),
  vector_chunks as (
    select c.id,
           c.embedding <=> p_embedding as distance
      from doc_chunks c
      join documents d0 on d0.id = c.document_id and d0.status <> 'revoked' and d0.deleted_at is null
      cross join scope s
     where p_embedding is not null
       and c.embedding is not null
       and c.department_id = any (s.ids)
     order by c.embedding <=> p_embedding
     limit greatest(p_limit * 8, 40)
  ),
  vector_cards as (
    select ce.card_id,
           min(v.distance) as distance
      from vector_chunks v
      join card_evidence ce on ce.chunk_id = v.id
      join knowledge_cards k on k.id = ce.card_id and k.status = 'confirmed'
     group by ce.card_id
  ),
  vector_ranked as (
    select v.card_id as id,
           row_number() over (order by v.distance, v.card_id) as rnk
      from vector_cards v
     order by distance, card_id
     limit greatest(p_limit * 4, 20)
  ),
  fused as (
    select coalesce(k.id, v.id) as cid,
           k.rnk as krnk,
           v.rnk as vrnk,
           (coalesce(1.0 / (p_rrf_k + k.rnk), 0)
            + coalesce(1.0 / (p_rrf_k + v.rnk), 0))::double precision as rrf
      from keyword_ranked k
      full outer join vector_ranked v on v.id = k.id
  )
  select k.id,
         k.department_id,
         k.kind,
         k.title,
         k.body,
         f.krnk::integer,
         f.vrnk::integer,
         f.rrf
    from fused f
    join knowledge_cards k on k.id = f.cid
   where k.status = 'confirmed'
   order by f.rrf desc, k.id
   limit p_limit
$fn$;

revoke all on function app.hybrid_search_cards(text, vector, integer, integer) from public;
grant execute on function app.hybrid_search_cards(text, vector, integer, integer) to jxf_app;
