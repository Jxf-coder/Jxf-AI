/**
 * Agent 会话（threads）：列表、详情与用户可管理动作。
 *
 * 边界：
 * - 列表只展示当前用户自己创建的会话（历史记录属于个人）；
 * - 详情按 RLS 可读范围加载，因此复制分享链接后同部门成员也能打开；
 * - 重命名 / 固定 / 删除 / 加入知识库只允许会话创建者；
 * - 删除是软删（archived_at），执行记录与审计保留。
 */

import type { PoolClient } from "pg";

import { auditInTx } from "@/lib/audit";
import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { createManualCard } from "@/lib/knowledge/cards";
import { PermissionDeniedError } from "@/lib/permissions/guard";
import { requireContextPermission } from "@/lib/permissions/server";

export interface ThreadUsage {
  promptTokens: number;
  completionTokens: number;
  costMicros: number;
}

export interface ThreadStepView {
  ord: number;
  phase: string;
  model: string | null;
  provider: string | null;
  durationMs: number | null;
}

export interface ThreadMessageView {
  runId: string;
  question: string;
  answer: string;
  status: string;
  error: string | null;
  usage: ThreadUsage;
  steps: ThreadStepView[];
}

export interface ThreadSummary {
  id: string;
  title: string;
  pinned: boolean;
  lastRunAt: string | null;
  createdAt: string;
  status: string | null;
}

export interface ThreadDetail {
  id: string;
  title: string;
  pinned: boolean;
  messages: ThreadMessageView[];
}

interface ThreadRow {
  id: string;
  title: string | null;
  pinned: boolean;
  department_id: string;
  created_by: string;
  last_run_at: Date | null;
  created_at: Date;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function displayTitle(raw: string | null): string {
  const title = (raw ?? "").trim();
  return title.length > 0 ? title : "未命名会话";
}

async function loadThreadRow(client: PoolClient, threadId: string): Promise<ThreadRow | null> {
  const { rows } = await client.query<ThreadRow>(
    `select id, title, pinned, department_id, created_by, last_run_at, created_at
       from threads
      where id = $1 and archived_at is null`,
    [threadId],
  );
  return rows[0] ?? null;
}

/** 会话写操作：先校验能力，再限制为创建者本人 */
async function requireOwnThread(
  client: PoolClient,
  context: UserContext,
  threadId: string,
): Promise<ThreadRow> {
  const thread = await loadThreadRow(client, threadId);
  if (!thread) {
    throw new Error("会话不存在或无权访问");
  }
  await requireContextPermission(client, context, "skill:use", {
    kind: "thread",
    id: thread.id,
    departmentId: thread.department_id,
    ownerUserId: thread.created_by,
  });
  if (thread.created_by !== context.userId) {
    throw new PermissionDeniedError({ allowed: false, reason: "只能管理自己创建的会话" });
  }
  return thread;
}

export async function listThreads(context: UserContext): Promise<ThreadSummary[]> {
  const departmentId = context.activeDepartmentId;
  if (!departmentId) {
    return [];
  }

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    const { rows } = await client.query<ThreadRow & { last_status: string | null }>(
      `select t.id, t.title, t.pinned, t.department_id, t.created_by,
              t.last_run_at, t.created_at,
              (select r.status from runs r
                where r.thread_id = t.id
                order by r.created_at desc
                limit 1) as last_status
         from threads t
        where t.created_by = $1 and t.archived_at is null
        order by t.pinned desc, coalesce(t.last_run_at, t.created_at) desc
        limit 80`,
      [context.userId],
    );

    return rows.map((row) => ({
      id: row.id,
      title: displayTitle(row.title),
      pinned: row.pinned,
      lastRunAt: toIso(row.last_run_at),
      createdAt: row.created_at.toISOString(),
      status: row.last_status,
    }));
  });
}

export async function loadThread(context: UserContext, threadId: string): Promise<ThreadDetail | null> {
  return withUserContext(context, async (client) => {
    const thread = await loadThreadRow(client, threadId);
    if (!thread) {
      return null;
    }

    await requireContextPermission(client, context, "skill:use", {
      kind: "thread",
      id: thread.id,
      departmentId: thread.department_id,
      ownerUserId: thread.created_by,
    });

    const runs = await client.query<{
      id: string;
      status: string;
      error: string | null;
      input: Record<string, unknown> | null;
      result: Record<string, unknown> | null;
      partial_text: string;
      prompt_tokens: number | string;
      completion_tokens: number | string;
      cost_micros: number | string;
    }>(
      `select id, status, error, input, result, partial_text,
              prompt_tokens, completion_tokens, cost_micros
         from runs
        where thread_id = $1
        order by created_at asc
        limit 100`,
      [thread.id],
    );

    const runIds = runs.rows.map((row) => row.id);
    const steps = runIds.length
      ? await client.query<{
          run_id: string;
          ord: number;
          phase: string;
          model: string | null;
          provider: string | null;
          duration_ms: number | null;
        }>(
          `select run_id, ord, phase, model, provider, duration_ms
             from run_steps
            where run_id = any($1::uuid[])
            order by run_id, ord`,
          [runIds],
        )
      : { rows: [] };

    const stepsByRun = new Map<string, ThreadStepView[]>();
    for (const step of steps.rows) {
      const list = stepsByRun.get(step.run_id) ?? [];
      list.push({
        ord: step.ord,
        phase: step.phase,
        model: step.model,
        provider: step.provider,
        durationMs: step.duration_ms,
      });
      stepsByRun.set(step.run_id, list);
    }

    return {
      id: thread.id,
      title: displayTitle(thread.title),
      pinned: thread.pinned,
      messages: runs.rows.map((row) => ({
        runId: row.id,
        question:
          typeof row.input?.question === "string" && row.input.question.trim().length > 0
            ? row.input.question
            : "（该回合没有保存问题）",
        answer:
          (typeof row.result?.text === "string" ? row.result.text : "") ||
          row.partial_text ||
          "",
        status: row.status,
        error: row.error,
        usage: {
          promptTokens: Number(row.prompt_tokens),
          completionTokens: Number(row.completion_tokens),
          costMicros: Number(row.cost_micros),
        },
        steps: stepsByRun.get(row.id) ?? [],
      })),
    };
  });
}

export async function renameThread(
  context: UserContext,
  threadId: string,
  rawTitle: string,
): Promise<ThreadSummary> {
  const title = rawTitle.trim();
  if (title.length === 0) {
    throw new Error("会话标题不能为空");
  }
  if (title.length > 60) {
    throw new Error("会话标题过长（≤ 60 字）");
  }

  return withUserContext(context, async (client) => {
    const thread = await requireOwnThread(client, context, threadId);
    const updated = await client.query<{ last_run_at: Date | null; created_at: Date }>(
      `update threads set title = $2 where id = $1 returning last_run_at, created_at`,
      [thread.id, title],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "runtime.thread_renamed",
      targetType: "thread",
      targetId: thread.id,
      departmentId: thread.department_id,
    });
    return {
      id: thread.id,
      title,
      pinned: thread.pinned,
      lastRunAt: toIso(updated.rows[0]?.last_run_at ?? thread.last_run_at),
      createdAt: (updated.rows[0]?.created_at ?? thread.created_at).toISOString(),
      status: null,
    };
  });
}

export async function setThreadPinned(
  context: UserContext,
  threadId: string,
  pinned: boolean,
): Promise<void> {
  await withUserContext(context, async (client) => {
    const thread = await requireOwnThread(client, context, threadId);
    await client.query(`update threads set pinned = $2 where id = $1`, [thread.id, pinned]);
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: pinned ? "runtime.thread_pinned" : "runtime.thread_unpinned",
      targetType: "thread",
      targetId: thread.id,
      departmentId: thread.department_id,
    });
  });
}

/** 软删：只从会话列表移除，执行记录与审计保留 */
export async function archiveThread(context: UserContext, threadId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    const thread = await requireOwnThread(client, context, threadId);
    await client.query(`update threads set archived_at = now(), pinned = false where id = $1`, [
      thread.id,
    ]);
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "runtime.thread_archived",
      targetType: "thread",
      targetId: thread.id,
      departmentId: thread.department_id,
    });
  });
}

/** 把整段会话整理成一张待确认知识卡（kind = faq） */
export async function addThreadToKnowledge(
  context: UserContext,
  threadId: string,
): Promise<{ cardId: string; created: boolean }> {
  const detail = await loadThread(context, threadId);
  if (!detail) {
    throw new Error("会话不存在或无权访问");
  }
  if (detail.messages.length === 0) {
    throw new Error("会话还没有问答内容，无法加入知识库");
  }

  const transcript = detail.messages
    .map((message) => `问：${message.question}\n答：${message.answer.trim() || "（无回答）"}`)
    .join("\n\n");
  const body = transcript.slice(0, 4000);

  const result = await createManualCard(context, {
    kind: "faq",
    title: detail.title.slice(0, 120),
    body,
    source: "Agent 会话",
  });

  return { cardId: result.id, created: result.created };
}
