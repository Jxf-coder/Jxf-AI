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

import { chatCompletionStreamDetailed } from "@/lib/ai/openai";
import { log, errorMessage } from "@/lib/logger";
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
}

function systemPromptFor(run: ClaimedRun): string {
  const employee = (run.input.employee ?? null) as EmployeeSnapshot | null;
  if (employee?.systemPrompt && employee.systemPrompt.trim().length > 0) {
    return employee.systemPrompt.trim();
  }
  const parts = ["你是企业内部的 AI 助手，回答必须基于已知信息，不确定就如实说明。"];
  if (employee?.name) {
    parts.push(`你的身份是「${employee.name}」。`);
  }
  if (employee?.persona && employee.persona.trim().length > 0) {
    parts.push(`人格设定：${employee.persona.trim()}`);
  }
  return parts.join("\n");
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

async function execute(pool: Pool, run: ClaimedRun): Promise<void> {
  const question = typeof run.input.question === "string" ? run.input.question.trim() : "";
  const tier = run.input.modelTier === "fast" ? "fast" : "deep";

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

  if (question.length === 0) {
    await finish(pool, run.id, "failed", { error: "缺少 question 参数" });
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
    const completion = await chatCompletionStreamDetailed(
      [
        { role: "system", content: systemPromptFor(run) },
        { role: "user", content: question },
      ],
      { tier, temperature: 0.2 },
      { onDelta, signal: controller.signal },
    );
    const durationMs = Date.now() - startedAt;

    if (!completion) {
      if (controller.signal.aborted || (await isCancelRequested(pool, run.id))) {
        await finish(pool, run.id, "cancelled", { status: "cancelled", reason: "user_cancelled" });
        return;
      }
      await pool.query(
        `update run_steps set finish_reason = 'unavailable', duration_ms = $2 where id = $1`,
        [stepId, durationMs],
      );
      await finish(pool, run.id, "failed", { error: "AI 未启用或调用失败" });
      return;
    }

    // 取消优先于产出：模型可能已经返回，但用户已中止就不写入答案
    if (await isCancelRequested(pool, run.id)) {
      await finish(pool, run.id, "cancelled", { status: "cancelled", reason: "user_cancelled" });
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
    log("info", "runtime_run_done", { run_id: run.id, model: completion.model, duration_ms: durationMs });
  } catch (error) {
    const cancelled =
      controller.signal.aborted || (await isCancelRequested(pool, run.id).catch(() => false));
    if (cancelled) {
      log("info", "runtime_run_cancelled", { run_id: run.id });
      await finish(pool, run.id, "cancelled", { status: "cancelled", reason: "user_cancelled" }).catch(
        () => undefined,
      );
    } else {
      log("warn", "runtime_run_failed", { run_id: run.id, error: errorMessage(error) });
      await finish(pool, run.id, "failed", { error: errorMessage(error) }).catch(() => undefined);
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
