/**
 * M3 受理：把一次用户回合变成 queued run，立即返回 run_id。
 *
 * 红线：
 * - 长任务绝不挂在请求生命周期上：这里只建 run，不执行模型；
 * - 幂等：同一 principal + client_turn_id 只会产生一个 run，重复提交返回既有 run_id；
 * - AI 员工配置在受理时快照进 runs.input，worker 不持有业务表权限也能执行；
 * - 权限仍按调用者当前部门判定（skill:use + knowledge:read）。
 */

import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";

export type RuntimeRunKind = "chat" | "task" | "workflow_step" | "ingest" | "regression";

export interface AcceptRunInput {
  kind: RuntimeRunKind;
  /** 执行参数：chat 形如 { question, modelTier?, citationMode? } */
  input: Record<string, unknown>;
  threadId?: string | null;
  aiEmployeeId?: string | null;
  /** 前端回合 id：双击 / 重试只产生一个 run */
  clientTurnId?: string | null;
  /** 新建会话时的标题（缺省取问题前 40 字） */
  title?: string | null;
}

export interface AcceptedRun {
  runId: string;
  threadId: string | null;
  status: string;
  resumed: boolean;
}

interface EmployeeSnapshot {
  id: string;
  name: string;
  persona: string | null;
  systemPrompt: string | null;
  modelConfig: Record<string, unknown>;
}

function questionTitle(input: Record<string, unknown>): string | null {
  const question = typeof input.question === "string" ? input.question.trim() : "";
  return question.length > 0 ? question.slice(0, 40) : null;
}

export async function acceptRun(context: UserContext, request: AcceptRunInput): Promise<AcceptedRun> {
  const departmentId = context.activeDepartmentId;
  if (!departmentId) {
    throw new Error("当前账号没有有效部门上下文，无法受理执行");
  }

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    // AI 员工：RLS 已按授权过滤，读不到就是未授权 / 未上线
    let employee: EmployeeSnapshot | null = null;
    if (request.aiEmployeeId) {
      const row = await client.query<{
        id: string;
        name: string;
        persona: string | null;
        system_prompt: string | null;
        model_config: Record<string, unknown> | null;
        status: string;
      }>(
        `select id, name, persona, system_prompt, model_config, status
           from ai_employees where id = $1`,
        [request.aiEmployeeId],
      );
      const found = row.rows[0];
      if (!found || found.status !== "active") {
        throw new Error("AI 员工不存在、未上线或未授权给当前部门");
      }
      employee = {
        id: found.id,
        name: found.name,
        persona: found.persona,
        systemPrompt: found.system_prompt,
        modelConfig: found.model_config ?? {},
      };
    }

    // 会话：显式传入时校验可读；chat 未传则在 run 落库后新建（避免幂等冲突时产生孤儿会话）
    let threadId = request.threadId ?? null;
    if (threadId) {
      const thread = await client.query<{ id: string }>(
        `select id from threads where id = $1`,
        [threadId],
      );
      if (!thread.rows[0]) {
        throw new Error("会话不存在或无权访问");
      }
    }

    const input = {
      ...request.input,
      ...(employee ? { employee } : {}),
    };
    const clientTurnId = (request.clientTurnId ?? "").trim().slice(0, 100) || null;

    // 幂等受理：唯一索引兜底，冲突时返回既有 run
    const inserted = await client.query<{ id: string; status: string }>(
      `insert into runs
         (tenant_id, department_id, role_key, thread_id, ai_employee_id, kind,
          client_turn_id, principal_id, input)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       on conflict (tenant_id, principal_id, client_turn_id)
         where client_turn_id is not null
       do nothing
       returning id, status`,
      [
        context.tenantId,
        departmentId,
        context.activeMembership?.title ?? null,
        threadId,
        request.aiEmployeeId ?? null,
        request.kind,
        clientTurnId,
        context.userId,
        JSON.stringify(input),
      ],
    );

    if (!inserted.rows[0]) {
      const existing = await client.query<{ id: string; status: string; thread_id: string | null }>(
        `select id, status, thread_id from runs
          where tenant_id = $1 and principal_id = $2 and client_turn_id = $3
          limit 1`,
        [context.tenantId, context.userId, clientTurnId],
      );
      const row = existing.rows[0];
      if (!row) {
        throw new Error("受理失败：幂等冲突但找不到既有执行");
      }
      return { runId: row.id, threadId: row.thread_id, status: row.status, resumed: true };
    }

    const runId = inserted.rows[0].id;
    if (!threadId && request.kind === "chat") {
      const created = await client.query<{ id: string }>(
        `insert into threads (tenant_id, department_id, role_key, ai_employee_id, title, created_by)
         values ($1, $2, $3, $4, $5, $6)
         returning id`,
        [
          context.tenantId,
          departmentId,
          context.activeMembership?.title ?? null,
          request.aiEmployeeId ?? null,
          (request.title ?? "").trim() || questionTitle(request.input) || "新会话",
          context.userId,
        ],
      );
      threadId = created.rows[0].id;
      await client.query(`update runs set thread_id = $2 where id = $1`, [runId, threadId]);
    }

    if (threadId) {
      await client.query(`update threads set last_run_at = now() where id = $1`, [threadId]);
    }

    return {
      runId,
      threadId,
      status: inserted.rows[0].status,
      resumed: false,
    };
  });
}
