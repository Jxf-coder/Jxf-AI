-- 0039 会话记忆：用户在某条会话里手动置顶的记忆条目。
-- 仅本人可见、可删除；不进入知识卡片库，也不参与跨会话召回。

create table if not exists thread_memories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  thread_id uuid not null references threads(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint thread_memories_content_length check (char_length(content) between 1 and 2000)
);

create index if not exists thread_memories_owner_idx
  on thread_memories (tenant_id, user_id, thread_id, created_at);
