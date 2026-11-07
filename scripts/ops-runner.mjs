/**
 * P5 切片 2：运维任务 runner（宿主机常驻进程）。
 *
 * Web 容器不持有 docker 权限，只负责往 ops_tasks 落单；
 * 本脚本用 owner 连接领取任务，执行白名单内的固定命令，再回写状态。
 *
 * 用法：
 *   npm run ops:runner            # 常驻轮询（3 秒一次）
 *   npm run ops:runner -- --once  # 执行一轮后退出，可交给 cron / systemd timer
 *
 * 安全边界：
 * - 只支持 backup / restore_verify 两种类型，参数只有 cold；
 * - 不拼接 shell，不执行来自数据库的任意命令或路径；
 * - 恢复演练固定使用最近一次备份，永不覆盖生产库。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { Client } from "pg";

import { ROOT, latestBackupDir, parseArgs } from "./lib/delivery.mjs";

const HOST = process.env.SEED_DB_HOST ?? "127.0.0.1";
const PORT = process.env.SEED_DB_PORT ?? process.env.POSTGRES_PORT ?? "5432";
const DB = process.env.POSTGRES_DB;
const OWNER_URL = `postgresql://${process.env.JXF_OWNER_USER}:${process.env.JXF_OWNER_PASSWORD}@${HOST}:${PORT}/${DB}`;
const POLL_MS = 3_000;

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

  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  log("已启动", { once: args.once === true, poll_ms: POLL_MS });

  try {
    while (!stopping) {
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
