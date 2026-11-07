/**
 * M3 worker 入口：只做队列消费与执行，不承担 HTTP。
 *
 * 循环：claim（SKIP LOCKED + 租约）→ 执行 → 落事件 / 用量 → finish。
 * 启动时把「不属于本进程」的 running 收口为 interrupted，避免假装还在跑。
 *
 * 运行：
 *   npm run worker          （本地：node --env-file=.env --import tsx src/worker/main.ts）
 *   容器：worker-app 服务，使用 WORKER_DATABASE_URL（app_worker 受限角色）
 */

import os from "node:os";

import { Pool } from "pg";

import { chatCompletionStreamDetailed, chatCompletionWithTools, type ChatUsage, type ToolChatMessage } from "@/lib/ai/openai";
import { log, errorMessage } from "@/lib/logger";
import {
  executePlannedTool,
  loadWorkerToolPlan,
  type WorkerToolPlan,
} from "@/lib/mcp/worker-tools";
import { claimRun, heartbeatRun, sweepExhausted, type ClaimedRun } from "@/lib/runtime/claim";
import { isCancelRequested } from "@/lib/runtime/cancel";
import { emitEvent, savePartialText } from "@/lib/runtime/emit";
import { markInterruptedForOthers, sweepStaleHeartbeat } from "@/lib/runtime/recover";
import { recordUsage } from "@/lib/runtime/usage";

const WORKER_ID = `worker-${os.hostname()}-${process.pid}`;
const IDLE_SLEEP_MS = 800;
const HEARTBEAT_MS = 30_000;
const SWEEP_EVERY_MS = 60_000;

let stopping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface EmployeeSnapshot {
  id?: string;
  name?: string;
  persona?: string | null;
  systemPrompt?: string | null;
  modelConfig?: Record<string, unknown>;
  /** 形如 mcp:<serverId>:<toolName> */
  allowedTools?: string[];
}

function systemPromptFor(run: ClaimedRun): string {
  const employee = (run.input.employee ?? null) as EmployeeSnapshot | null;
  if (employee?.systemPrompt && employee.systemPrompt.trim().length > 0) {
    return employee.systemPrompt.trim();
  }
  const parts = ["你是企业内部的 AI 助手，回答必须基于已知信息，不确定就如实说明。"];
  if (run.kind === "task") {
    parts.push(
      "这是一项被派发的工作任务：请直接产出可验收的交付物，结构清晰、结论明确，不要反问用户；无法确定的信息要标注出来。",
    );
  }
  if (employee?.name) {
    parts.push(`你的身份是「${employee.name}」。`);
  }
  if (employee?.persona && employee.persona.trim().length > 0) {
    parts.push(`人格设定：${employee.persona.trim()}`);
  }
  return parts.join("\n");
}

/** 把附件正文拼进本轮用户消息；附件只在执行上下文里，不改变界面上的提问 */
function userContentFor(run: ClaimedRun, question: string): string {
  const raw = Array.isArray(run.input.attachments) ? run.input.attachments : [];
  const files = raw
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "附件";
      const text = typeof record.text === "string" ? record.text.trim() : "";
      return text ? { name: name || "附件", text } : null;
    })
    .filter((item): item is { name: string; text: string } => item !== null)
    .slice(0, 5);

  if (files.length === 0) {
    return question;
  }

  const blocks = files.map(
    (file, index) => `【附件 ${index + 1}：${file.name}】\n${file.text}`,
  );
  return [question, "以下是用户随消息上传的附件内容，请结合附件回答：", ...blocks].join("\n\n");
}

/** 把执行状态同步回工作项；chat 没有 workItemId 时为 no-op；成功路径走 completeWorkItem */
async function syncWorkItem(
  pool: Pool,
  workItemId: string | null,
  status: "running" | "failed" | "cancelled",
  deliverable?: Record<string, unknown> | null,
): Promise<void> {
  if (!workItemId) {
    return;
  }
  try {
    await pool.query(
      `update work_items
          set status = $2::work_item_status,
              deliverable = case when $3::jsonb is null then deliverable else $3::jsonb end,
              updated_at = now()
        where id = $1`,
      [workItemId, status, deliverable ? JSON.stringify(deliverable) : null],
    );
  } catch (error) {
    log("warn", "work_item_sync_failed", {
      work_item_id: workItemId,
      status,
      error: errorMessage(error),
    });
  }
}

/** 自动验收：出现这些标记说明交付物还有未决信息，必须转人工 */
const AUTO_BLOCKERS = ["待确认", "待补充", "无法确定", "不确定", "TODO"];
const DEFAULT_AUTO_MIN_CHARS = 120;

/**
 * 交付物回写：按工作项快照的验收方式决定「自动通过」还是「待人工验收」。
 * 自动通过只做门槛校验（字数 + 无未决标记），不替代人工判断。
 */
async function completeWorkItem(
  pool: Pool,
  workItemId: string | null,
  deliverable: Record<string, unknown>,
  text: string,
): Promise<void> {
  if (!workItemId) {
    return;
  }
  try {
    const { rows } = await pool.query<{ mode: string | null; min_chars: number | null }>(
      `select input->'review'->>'mode' as mode,
              nullif(input->'review'->>'minChars', '')::int as min_chars
         from work_items
        where id = $1`,
      [workItemId],
    );
    const config = rows[0];
    const chars = text.trim().length;
    const minChars = config?.min_chars ?? DEFAULT_AUTO_MIN_CHARS;
    const blocker = AUTO_BLOCKERS.find((marker) => text.includes(marker)) ?? null;
    const autoApproved = config?.mode === "auto" && chars >= minChars && !blocker;

    if (autoApproved) {
      await pool.query(
        `update work_items
            set status = 'done',
                deliverable = $2::jsonb,
                review_note = $3,
                reviewed_at = now(),
                updated_at = now()
          where id = $1`,
        [workItemId, JSON.stringify(deliverable), `自动验收通过（${chars} 字 ≥ ${minChars} 字）`],
      );
      log("info", "work_item_auto_approved", { work_item_id: workItemId, chars });
      return;
    }

    const fallbackNote =
      config?.mode === "auto"
        ? blocker
          ? `自动验收未通过：交付物含「${blocker}」，需人工确认`
          : `自动验收未通过：${chars} 字 < ${minChars} 字门槛`
        : null;

    await pool.query(
      `update work_items
          set status = 'waiting_review',
              deliverable = $2::jsonb,
              review_note = $3,
              updated_at = now()
        where id = $1`,
      [workItemId, JSON.stringify(deliverable), fallbackNote],
    );
  } catch (error) {
    log("warn", "work_item_complete_failed", {
      work_item_id: workItemId,
      error: errorMessage(error),
    });
  }
}

async function finish(
  pool: Pool,
  runId: string,
  status: "done" | "failed" | "cancelled",
  payload: Record<string, unknown>,
  result: Record<string, unknown> = {},
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await emitEvent(client, runId, status === "done" ? "done" : status === "cancelled" ? "cancelled" : "error", payload);
    await client.query(
      `update runs
          set status = $2::run_status,
              finished_at = now(),
              lease_until = null,
              result = $3::jsonb,
              error = case when $2::text = 'failed' then $4::text else error end
        where id = $1`,
      [runId, status, JSON.stringify(result), String(payload.error ?? "执行失败")],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const MAX_TOOL_ROUNDS = 4;
const MAX_TOOL_CALLS = 10;

interface ToolConversationResult {
  text: string;
  model: string;
  provider: string;
  usage: ChatUsage | null;
}

/**
 * 任务型执行里的工具对话：模型可多轮调用已授权的外部 MCP 工具。
 * 返回 null 表示调用失败或已取消，由调用方按原有失败 / 取消分支收口。
 */
async function runToolConversation(
  pool: Pool,
  run: ClaimedRun,
  plan: WorkerToolPlan,
  stepId: string,
  tier: "deep" | "fast",
  question: string,
): Promise<ToolConversationResult | null> {
  const conversation: ToolChatMessage[] = [
    {
      role: "system",
      content: `${systemPromptFor(run)}\n你可以调用已授权的工具获取事实；需要外部数据时先调用工具，不要臆造。`,
    },
    { role: "user", content: userContentFor(run, question) },
  ];

  let last: ToolConversationResult | null = null;
  let toolCallCount = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    if (await isCancelRequested(pool, run.id)) {
      return null;
    }

    const result = await chatCompletionWithTools(conversation, plan.definitions, {
      tier,
      temperature: 0.2,
    });
    if (!result) {
      return null;
    }
    last = { text: result.text, model: result.model, provider: result.provider, usage: result.usage };
    conversation.push(result.assistantMessage);

    if (result.toolCalls.length === 0) {
      return last;
    }

    for (const call of result.toolCalls.slice(0, 5)) {
      if (toolCallCount >= MAX_TOOL_CALLS) {
        break;
      }
      toolCallCount += 1;
      const text = await executePlannedTool(pool, plan, call.name, call.arguments, {
        tenantId: run.tenantId,
        departmentId: run.departmentId,
        runId: run.id,
        stepId,
      });
      conversation.push({ role: "tool", tool_call_id: call.id, content: text.slice(0, 8000) });
    }
  }

  log("warn", "worker_tool_budget_exhausted", { run_id: run.id, tool_calls: toolCallCount });
  if (!last) {
    return null;
  }
  return {
    ...last,
    text: last.text.trim() || "已达到工具调用上限，未能形成结论，请缩小问题范围后重试。",
  };
}

async function execute(pool: Pool, run: ClaimedRun): Promise<void> {
  const question = typeof run.input.question === "string" ? run.input.question.trim() : "";
  const tier = run.input.modelTier === "fast" ? "fast" : "deep";
  const workItemId = typeof run.input.workItemId === "string" ? run.input.workItemId : null;

  const initial = await pool.connect();
  try {
    await initial.query("begin");
    await emitEvent(initial, run.id, "status", { status: "running", worker: WORKER_ID });
    await initial.query("commit");
  } catch (error) {
    await initial.query("rollback").catch(() => {});
    throw error;
  } finally {
    initial.release();
  }

  await syncWorkItem(pool, workItemId, "running");

  if (question.length === 0) {
    await finish(pool, run.id, "failed", { error: "缺少 question 参数" });
    await syncWorkItem(pool, workItemId, "failed");
    return;
  }

  const heartbeat = setInterval(() => {
    void heartbeatRun(pool, run.id, WORKER_ID).catch((error) => {
      log("warn", "runtime_heartbeat_failed", { run_id: run.id, error: errorMessage(error) });
    });
  }, HEARTBEAT_MS);

  const controller = new AbortController();
  let cancelWatch: ReturnType<typeof setInterval> | null = null;

  try {
    // step 边界：先看是否已被取消，取消后不再产生新的模型调用
    if (await isCancelRequested(pool, run.id)) {
      await finish(pool, run.id, "cancelled", { status: "cancelled", reason: "user_cancelled" });
      await syncWorkItem(pool, workItemId, "cancelled");
      return;
    }

    const stepClient = await pool.connect();
    let stepId: string;
    let stepOrd: number;
    try {
      const ord = await stepClient.query<{ next: number }>(
        `select coalesce(max(ord), 0) + 1 as next from run_steps where run_id = $1`,
        [run.id],
      );
      stepOrd = Number(ord.rows[0]?.next ?? 1);
      const step = await stepClient.query<{ id: string }>(
        `insert into run_steps (run_id, ord, phase) values ($1, $2, 'answer') returning id`,
        [run.id, stepOrd],
      );
      stepId = step.rows[0].id;
    } finally {
      stepClient.release();
    }

    // 步开始事件：前端据此显示「思考中 · 第 N 步」，无需持久化思考正文
    const startClient = await pool.connect();
    try {
      await startClient.query("begin");
      await emitEvent(startClient, run.id, "step", {
        ord: stepOrd,
        phase: "answer",
        status: "started",
      });
      await startClient.query("commit");
    } catch (error) {
      await startClient.query("rollback").catch(() => {});
      throw error;
    } finally {
      startClient.release();
    }

    // 用户取消：1s 内中止上游流，已生成内容保留在 partial_text 供前端如实展示
    cancelWatch = setInterval(() => {
      void isCancelRequested(pool, run.id)
        .then((requested) => {
          if (requested) {
            controller.abort();
          }
        })
        .catch(() => undefined);
    }, 1_000);

    // 增量快照节流：400ms 一次，避免每个 token 都写库
    let snapshotAt = 0;
    let snapshotSaving = false;
    let snapshotPending: Promise<void> = Promise.resolve();
    const onDelta = (_delta: string, text: string) => {
      const now = Date.now();
      if (now - snapshotAt < 400 || snapshotSaving) {
        return;
      }
      snapshotAt = now;
      snapshotSaving = true;
      snapshotPending = pool
        .query(`update runs set partial_text = $2, partial_updated_at = now() where id = $1`, [run.id, text])
        .then(
          () => undefined,
          (error) => {
            log("warn", "runtime_partial_text_failed", { run_id: run.id, error: errorMessage(error) });
          },
        )
        .finally(() => {
          snapshotSaving = false;
        });
    };

    const startedAt = Date.now();
    const employeeSnapshot = (run.input.employee ?? null) as EmployeeSnapshot | null;
    const hasTools =
      run.kind === "task" && (employeeSnapshot?.allowedTools?.length ?? 0) > 0;
    let toolPlan: WorkerToolPlan = { definitions: [], tools: new Map() };
    if (hasTools) {
      try {
        toolPlan = await loadWorkerToolPlan(pool, run.tenantId, employeeSnapshot?.allowedTools ?? []);
      } catch (error) {
        log("warn", "worker_tool_plan_failed", { run_id: run.id, error: errorMessage(error) });
      }
    }

    const completion =
      toolPlan.definitions.length > 0
        ? await runToolConversation(pool, run, toolPlan, stepId, tier, question)
        : await chatCompletionStreamDetailed(
            [
              { role: "system", content: systemPromptFor(run) },
              { role: "user", content: userContentFor(run, question) },
            ],
            { tier, temperature: 0.2 },
            { onDelta, signal: controller.signal },
          );
    const durationMs = Date.now() - startedAt;

    if (!completion) {
      if (controller.signal.aborted || (await isCancelRequested(pool, run.id))) {
        await finish(pool, run.id, "cancelled", { status: "cancelled", reason: "user_cancelled" });
        await syncWorkItem(pool, workItemId, "cancelled");
        return;
      }
      await pool.query(
        `update run_steps set finish_reason = 'unavailable', duration_ms = $2 where id = $1`,
        [stepId, durationMs],
      );
      await finish(pool, run.id, "failed", { error: "AI 未启用或调用失败" });
      await syncWorkItem(pool, workItemId, "failed");
      return;
    }

    // 取消优先于产出：模型可能已经返回，但用户已中止就不写入答案
    if (await isCancelRequested(pool, run.id)) {
      await finish(pool, run.id, "cancelled", { status: "cancelled", reason: "user_cancelled" });
      await syncWorkItem(pool, workItemId, "cancelled");
      return;
    }

    await snapshotPending;
    await pool.query(
      `update run_steps
          set model = $2, provider = $3, finish_reason = 'stop', duration_ms = $4
        where id = $1`,
      [stepId, completion.model, completion.provider, durationMs],
    );

    if (completion.usage) {
      await recordUsage(pool, {
        tenantId: run.tenantId,
        departmentId: run.departmentId,
        runId: run.id,
        stepId,
        provider: completion.provider,
        model: completion.model,
        promptTokens: completion.usage.promptTokens,
        completionTokens: completion.usage.completionTokens,
        cachedTokens: completion.usage.cachedTokens,
      });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await savePartialText(client, run.id, completion.text);
      await emitEvent(client, run.id, "step", {
        ord: stepOrd,
        phase: "answer",
        model: completion.model,
        provider: completion.provider,
        duration_ms: durationMs,
        chars: completion.text.length,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    await finish(
      pool,
      run.id,
      "done",
      { status: "done" },
      { text: completion.text, model: completion.model, provider: completion.provider },
    );
    await completeWorkItem(
      pool,
      workItemId,
      {
        text: completion.text,
        model: completion.model,
        provider: completion.provider,
        usage: completion.usage ?? null,
        finishedAt: new Date().toISOString(),
      },
      completion.text,
    );
    log("info", "runtime_run_done", { run_id: run.id, model: completion.model, duration_ms: durationMs });
  } catch (error) {
    const cancelled =
      controller.signal.aborted || (await isCancelRequested(pool, run.id).catch(() => false));
    if (cancelled) {
      log("info", "runtime_run_cancelled", { run_id: run.id });
      await finish(pool, run.id, "cancelled", { status: "cancelled", reason: "user_cancelled" }).catch(
        () => undefined,
      );
      await syncWorkItem(pool, workItemId, "cancelled");
    } else {
      log("warn", "runtime_run_failed", { run_id: run.id, error: errorMessage(error) });
      await finish(pool, run.id, "failed", { error: errorMessage(error) }).catch(() => undefined);
      await syncWorkItem(pool, workItemId, "failed");
    }
  } finally {
    clearInterval(heartbeat);
    if (cancelWatch) {
      clearInterval(cancelWatch);
    }
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.WORKER_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("WORKER_DATABASE_URL 缺失：worker 必须使用 app_worker 受限角色");
  }

  const pool = new Pool({
    connectionString,
    application_name: "jxf-worker",
    max: 4,
  });

  log("info", "runtime_worker_started", { worker: WORKER_ID });

  const interrupted = await markInterruptedForOthers(pool, WORKER_ID);
  if (interrupted.length > 0) {
    log("warn", "runtime_runs_interrupted", { count: interrupted.length });
  }

  let lastSweep = 0;

  while (!stopping) {
    try {
      if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
        lastSweep = Date.now();
        await sweepStaleHeartbeat(pool);
        const exhausted = await sweepExhausted(pool);
        if (exhausted.length > 0) {
          log("warn", "runtime_runs_exhausted", { count: exhausted.length });
        }
      }

      const run = await claimRun(pool, WORKER_ID);
      if (!run) {
        await sleep(IDLE_SLEEP_MS);
        continue;
      }

      log("info", "runtime_run_claimed", { run_id: run.id, kind: run.kind, attempt: run.attempts });
      await execute(pool, run);
    } catch (error) {
      log("error", "runtime_worker_loop_failed", { error: errorMessage(error) });
      await sleep(IDLE_SLEEP_MS);
    }
  }

  await pool.end();
  log("info", "runtime_worker_stopped", { worker: WORKER_ID });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
    log("info", "runtime_worker_stopping", { signal });
  });
}

main().catch((error) => {
  log("error", "runtime_worker_crashed", { error: errorMessage(error) });
  process.exit(1);
});
