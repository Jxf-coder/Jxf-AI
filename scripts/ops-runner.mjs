/**
 * P5 切片 2：运维任务 runner（宿主机常驻进程）。
 *
 * Web 容器不持有 docker 权限，只负责往 ops_tasks 落单；
 * 本脚本用 owner 连接领取任务，执行白名单内的固定命令，再回写状态。
 *
 * 用法：
 *   npm run ops:runner            # 常驻轮询（3 秒一次）+ 连接器心跳 + 产线推进
 *   npm run ops:runner -- --once  # 执行一轮任务后退出，可交给 cron / systemd timer
 *   npm run ops:runner -- --health-once   # 只做一次连接器体检后退出
 *   npm run ops:runner -- --pipelines-once # 只推进一轮产线后退出
 *   npm run ops:runner -- --no-health     # 关闭周期性连接器体检
 *   npm run ops:runner -- --no-pipelines  # 关闭产线定时触发与链式推进
 *
 * 依赖：宿主机已 `npm install`（runner 通过 tsx 直接加载 src/lib 下的 TS 模块）。
 *
 * 安全边界：
 * - 只支持 backup / restore_verify 两种类型，参数只有 cold；
 * - 不拼接 shell，不执行来自数据库的任意命令或路径；
 * - 恢复演练固定使用最近一次备份，永不覆盖生产库；
 * - 产线推进仍走 assignWork（jxf_app + RLS），使用产线发起人的用户上下文。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { Client } from "pg";

import { checkConnectorsAsOwner, sendHealthWebhook } from "../src/lib/mcp/health.ts";
import { resolveUserContext } from "../src/lib/db/user-context.ts";
import { advancePipelineRuns, sweepScheduledPipelines } from "../src/lib/pipeline-runner.ts";
import {
  dispatchPipelineEvents,
  publishPipelineEventSafe,
} from "../src/lib/pipeline-events.ts";
import {
  notifyHealthAlert,
  notifyOpsTaskFailure,
  notifyPipelineFailure,
} from "../src/lib/notifications/events.ts";
import { ROOT, latestBackupDir, parseArgs } from "./lib/delivery.mjs";

const HOST = process.env.SEED_DB_HOST ?? "127.0.0.1";
const PORT = process.env.SEED_DB_PORT ?? process.env.POSTGRES_PORT ?? "5432";
const DB = process.env.POSTGRES_DB;
const OWNER_URL = `postgresql://${process.env.JXF_OWNER_USER}:${process.env.JXF_OWNER_PASSWORD}@${HOST}:${PORT}/${DB}`;
const POLL_MS = 3_000;
const HEALTH_INTERVAL_MS =
  Number.parseInt(process.env.MCP_HEALTH_INTERVAL_MS ?? "300000", 10) || 300_000;
const PIPELINE_TICK_MS =
  Number.parseInt(process.env.PIPELINE_TICK_MS ?? "60000", 10) || 60_000;

let stopping = false;

function log(message, fields = {}) {
  const suffix = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  console.log(`[ops-runner] ${new Date().toISOString()} ${message}${suffix}`);
}

function tail(text, lines = 20) {
  return String(text ?? "")
    .trim()
    .split(/\r?\n/)
    .slice(-lines)
    .join("\n");
}

function runScript(script, args) {
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    ["--env-file=.env", path.join(ROOT, "scripts", script), ...args],
    {
      cwd: ROOT,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: Date.now() - startedAt,
  };
}

async function execute(task) {
  const cold = task.params?.cold === true;
  log("开始执行", { id: task.id, kind: task.kind, cold });

  if (task.kind === "backup") {
    const args = cold ? ["--cold"] : [];
    const result = runScript("backup.mjs", args);
    if (result.status !== 0) {
      throw new Error(`备份失败（exit ${result.status}）：${tail(result.stderr || result.stdout)}`);
    }
    const dir = latestBackupDir();
    if (!dir) {
      throw new Error("备份命令成功，但未找到 manifest.json 产物");
    }
    log("备份完成", { dir: path.relative(ROOT, dir), duration_ms: result.durationMs });
    return {
      backup_dir: path.relative(ROOT, dir).replace(/\\/g, "/"),
      duration_ms: result.durationMs,
    };
  }

  if (task.kind === "restore_verify") {
    const dir = latestBackupDir();
    if (!dir) {
      throw new Error("没有可用的备份产物，请先执行备份任务");
    }
    const from = path.relative(ROOT, dir);
    const result = runScript("restore.mjs", ["--from", from, "--verify"]);
    if (result.status !== 0) {
      throw new Error(`恢复演练失败（exit ${result.status}）：${tail(result.stderr || result.stdout)}`);
    }
    log("恢复演练完成", { from, duration_ms: result.durationMs });
    return { from: from.replace(/\\/g, "/"), duration_ms: result.durationMs };
  }

  throw new Error(`不支持的任务类型：${task.kind}`);
}

async function claimTask(client) {
  const { rows } = await client.query(
    `update ops_tasks
        set status = 'running', started_at = now(), error = null
      where id = (
        select id from ops_tasks
         where status = 'queued'
         order by requested_at
         limit 1
         for update skip locked
      )
     returning id, kind, params`,
  );
  return rows[0] ?? null;
}

async function finishTask(client, id, status, result, error) {
  await client.query(
    `update ops_tasks
        set status = $1, result = $2::jsonb, error = $3, finished_at = now()
      where id = $4`,
    [status, JSON.stringify(result ?? {}), error, id],
  );
}

/** 连接器心跳：连续失败 ≥3 次标记熔断，状态迁移写审计、推 webhook 并发邮件 */
async function runHealthSweep(client) {
  const startedAt = Date.now();
  try {
    const results = await checkConnectorsAsOwner(client, {
      onAlert: async (alert) => {
        await sendHealthWebhook(alert);
        await notifyHealthAlert(alert);
      },
    });
    const down = results.filter((item) => item.status === "down").length;
    const degraded = results.filter((item) => item.status === "degraded").length;
    log("连接器体检完成", {
      total: results.length,
      healthy: results.length - down - degraded,
      degraded,
      down,
      duration_ms: Date.now() - startedAt,
    });

    // 状态迁移投递到内部事件总线，供产线订阅
    for (const result of results) {
      if (!result.transition) {
        continue;
      }
      await publishPipelineEventSafe(client, {
        tenantId: result.tenantId,
        eventType: "mcp.connector_changed",
        payload: {
          connector_id: result.serverId,
          name: result.name,
          status: result.status,
          transition: result.transition,
          error: result.error,
        },
      });
    }
  } catch (error) {
    log("连接器体检失败", { error: error instanceof Error ? error.message : String(error) });
  }
}

/** 产线推进：派发内部事件、触发定时产线，并推动已完成运行进入下一步 */
async function runPipelineTick(client) {
  const startedAt = Date.now();
  const hooks = { resolveContext: (userId) => resolveUserContext(userId) };
  try {
    const events = await dispatchPipelineEvents(client, hooks);
    for (const event of events) {
      if (event.status !== "processed" || event.errors.length > 0) {
        log("事件派发异常", {
          event: event.eventType,
          triggered: event.triggered,
          status: event.status,
          error: event.errors.join("; ").slice(0, 300),
        });
      }
    }

    const scheduled = await sweepScheduledPipelines(client, hooks);
    const advanced = await advancePipelineRuns(client, hooks);

    for (const item of scheduled) {
      if (item.error) {
        log("定时产线触发失败", { pipeline: item.pipelineName, error: item.error });
        await notifyPipelineFailure({
          pipelineName: item.pipelineName,
          step: null,
          error: item.error,
          runId: item.runId,
        });
      }
    }
    for (const item of advanced) {
      if (item.action === "failed") {
        log("产线推进失败", {
          pipeline: item.pipelineName,
          step: item.failedStep,
          error: item.error,
        });
        await notifyPipelineFailure({
          pipelineName: item.pipelineName,
          step: item.failedStep,
          error: item.error,
          runId: item.runId,
        });
      }
    }

    const moved = advanced.filter((item) => item.action !== "waiting").length;
    if (scheduled.length > 0 || moved > 0 || events.length > 0) {
      log("产线推进完成", {
        events: events.length,
        scheduled: scheduled.length,
        advanced: moved,
        waiting: advanced.length - moved,
        duration_ms: Date.now() - startedAt,
      });
    }
  } catch (error) {
    log("产线推进失败", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!DB || !process.env.JXF_OWNER_USER || !process.env.JXF_OWNER_PASSWORD) {
    throw new Error("缺少数据库 owner 环境变量，请用 npm run ops:runner 执行");
  }

  const client = new Client({ connectionString: OWNER_URL, application_name: "jxf-ops-runner" });
  await client.connect();

  // 上一个 runner 异常退出时，running 任务不会自己结束，启动时统一收口
  const swept = await client.query(
    `update ops_tasks
        set status = 'failed', error = 'runner 重启前中断，请重新发起', finished_at = now()
      where status = 'running'`,
  );
  if (swept.rowCount > 0) {
    log("已收口中断任务", { count: swept.rowCount });
  }

  // 只推进一轮产线（可交给 cron / systemd timer）
  if (args["pipelines-once"] === true) {
    await runPipelineTick(client);
    await client.end().catch(() => undefined);
    log("已退出");
    return;
  }

  // 只做一次连接器体检（可交给 cron / systemd timer）
  if (args["health-once"] === true) {
    await runHealthSweep(client);
    await client.end().catch(() => undefined);
    log("已退出");
    return;
  }

  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  const healthEnabled = args["no-health"] !== true;
  const pipelineEnabled = args["no-pipelines"] !== true;
  let lastHealthAt = args.once === true ? Date.now() : 0;
  let lastPipelineAt = args.once === true ? Date.now() : 0;

  log("已启动", {
    once: args.once === true,
    poll_ms: POLL_MS,
    health_enabled: healthEnabled,
    health_interval_ms: HEALTH_INTERVAL_MS,
    pipelines_enabled: pipelineEnabled,
    pipeline_tick_ms: PIPELINE_TICK_MS,
  });

  try {
    while (!stopping) {
      if (healthEnabled && Date.now() - lastHealthAt >= HEALTH_INTERVAL_MS) {
        lastHealthAt = Date.now();
        await runHealthSweep(client);
      }

      if (pipelineEnabled && Date.now() - lastPipelineAt >= PIPELINE_TICK_MS) {
        lastPipelineAt = Date.now();
        await runPipelineTick(client);
      }

      let task = null;
      try {
        task = await claimTask(client);
      } catch (error) {
        log("领取任务失败", { error: error instanceof Error ? error.message : String(error) });
      }

      if (!task) {
        if (args.once === true) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        continue;
      }

      try {
        const result = await execute(task);
        await finishTask(client, task.id, "done", result, null);
        log("任务完成", { id: task.id, kind: task.kind });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finishTask(client, task.id, "failed", null, message.slice(0, 2000));
        log("任务失败", { id: task.id, kind: task.kind, error: message.slice(0, 300) });
        await notifyOpsTaskFailure({ id: task.id, kind: task.kind, error: message.slice(0, 2000) });
      }

      if (args.once === true) {
        break;
      }
    }
  } finally {
    await client.end().catch(() => {});
    log("已退出");
  }
}

main().catch((error) => {
  console.error(`[ops-runner] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
