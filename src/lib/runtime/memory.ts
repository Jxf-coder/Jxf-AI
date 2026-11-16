/**
 * 会话记忆：用户在单条会话内手动置顶的短事实，仅本人可见。
 *
 * 边界：
 * - 不写入 knowledge_cards，不参与跨会话召回；
 * - 读取时只取创建者本人的条目，且只注入当前会话的运行；
 * - 每条长度与条数都有上限，拼接上下文再做一次总长截断。
 */

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";

export const MAX_MEMORY_ITEMS = 10;
export const MAX_MEMORY_CHARS = 500;
export const MAX_MEMORY_CONTEXT_CHARS = 2000;

export interface ThreadMemoryView {
  id: string;
  content: string;
  createdAt: string;
}

interface MemoryRow {
  id: string;
  content: string;
  created_at: Date;
}

interface Queryable {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

export async function listThreadMemories(
  context: UserContext,
  threadId: string,
): Promise<ThreadMemoryView[]> {
  return withUserContext(context, async (client) => {
    const thread = await client.query(`select id from threads where id = $1 and created_by = $2`, [
      threadId,
      context.userId,
    ]);
    if (!thread.rows[0]) {
      return [];
    }

    const { rows } = await client.query<MemoryRow>(
      `select id, content, created_at
         from thread_memories
        where thread_id = $1 and user_id = $2
        order by created_at`,
      [threadId, context.userId],
    );
    return rows.map(toView);
  });
}

export async function addThreadMemory(
  context: UserContext,
  threadId: string,
  rawContent: string,
): Promise<ThreadMemoryView> {
  const content = rawContent.trim();
  if (content.length === 0) {
    throw new Error("记忆内容不能为空");
  }
  if (content.length > MAX_MEMORY_CHARS) {
    throw new Error(`单条记忆不能超过 ${MAX_MEMORY_CHARS} 字`);
  }

  return withUserContext(context, async (client) => {
    const thread = await client.query<{ id: string }>(
      `select id from threads
        where id = $1 and created_by = $2 and archived_at is null`,
      [threadId, context.userId],
    );
    if (!thread.rows[0]) {
      throw new Error("会话不存在、已归档或无权操作");
    }

    const count = await client.query<{ count: number }>(
      `select count(*)::int as count from thread_memories where thread_id = $1 and user_id = $2`,
      [threadId, context.userId],
    );
    if (Number(count.rows[0]?.count ?? 0) >= MAX_MEMORY_ITEMS) {
      throw new Error(`每条会话最多 ${MAX_MEMORY_ITEMS} 条记忆`);
    }

    const inserted = await client.query<MemoryRow>(
      `insert into thread_memories (tenant_id, user_id, thread_id, content)
       values ($1, $2, $3, $4)
       returning id, content, created_at`,
      [context.tenantId, context.userId, threadId, content],
    );
    const row = inserted.rows[0];
    if (!row) {
      throw new Error("记忆写入失败");
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "chat.memory_added",
      targetType: "thread_memory",
      targetId: row.id,
      departmentId: context.activeDepartmentId,
      payload: { thread_id: threadId, chars: content.length },
    });

    return toView(row);
  });
}

export async function deleteThreadMemory(context: UserContext, memoryId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    const deleted = await client.query<{ id: string; thread_id: string }>(
      `delete from thread_memories where id = $1 and user_id = $2 returning id, thread_id`,
      [memoryId, context.userId],
    );
    const row = deleted.rows[0];
    if (!row) {
      return;
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "chat.memory_deleted",
      targetType: "thread_memory",
      targetId: row.id,
      departmentId: context.activeDepartmentId,
      payload: { thread_id: row.thread_id },
    });
  });
}

/** 把当前会话的记忆拼成提示词片段；没有记忆返回 null */
export async function readMemoryContext(
  client: Queryable,
  threadId: string,
  userId: string,
): Promise<string | null> {
  const { rows } = await client.query(
    `select content from thread_memories
      where thread_id = $1 and user_id = $2
      order by created_at
      limit ${MAX_MEMORY_ITEMS}`,
    [threadId, userId],
  );
  const lines = (rows as Array<{ content?: string }>)
    .map((row) => (typeof row.content === "string" ? row.content.trim() : ""))
    .filter((line) => line.length > 0)
    .map((line) => `- ${line}`);
  if (lines.length === 0) {
    return null;
  }
  return lines.join("\n").slice(0, MAX_MEMORY_CONTEXT_CHARS);
}

function toView(row: MemoryRow): ThreadMemoryView {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at.toISOString(),
  };
}
