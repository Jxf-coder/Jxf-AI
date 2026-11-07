/**
 * M5 交付底座 · 升级。
 *
 * 流程：备份 → 旧镜像打回滚标签 → 构建 → migrate 门禁 → 拉起 → 健康检查 → 写状态文件。
 * 失败时不会拉起新 web/worker；按输出提示执行 rollback。
 *
 * 用法：
 *   npm run upgrade
 *   npm run upgrade -- --skip-backup      # 已有近期备份时
 *   npm run upgrade -- --skip-build       # 只执行迁移与重启（演练）
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  compose,
  dbVersion,
  docker,
  ensureDir,
  log,
  parseArgs,
  resolveFromRoot,
  ROOT,
  timestamp,
  waitForHealth,
  waitForMigrate,
  writeJson,
} from "./lib/delivery.mjs";

const BUILD_IMAGES = ["jxf-ai/migrate:0.1.0", "jxf-ai/web:0.1.0", "jxf-ai/worker:0.1.0"];

function rollbackTag(image, stamp) {
  return `${image.split(":")[0]}:rollback-${stamp}`;
}

function backup(stamp, cold) {
  const outDir = path.join(ROOT, "backups", `backup-${stamp}-pre-upgrade`);
  const scriptArgs = [path.join(ROOT, "scripts/backup.mjs"), "--out", outDir];
  if (cold) {
    scriptArgs.push("--cold");
  }
  const result = spawnSync(process.execPath, scriptArgs, {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("升级前备份失败，已中止升级");
  }
  return outDir;
}

function tagPreviousImages(stamp) {
  const images = {};
  for (const image of BUILD_IMAGES) {
    const inspected = docker(["image", "inspect", image], { allowFailure: true });
    if (inspected.status !== 0) {
      continue;
    }
    const tag = rollbackTag(image, stamp);
    docker(["tag", image, tag], { inherit: true });
    images[image] = tag;
  }
  return images;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = timestamp();
  ensureDir(path.join(ROOT, "backups"));
  const statePath = path.join(ROOT, "backups", `upgrade-${stamp}.json`);
  const previous = dbVersion();

  log("开始升级", {
    app_version: process.env.JXF_VERSION || "0.1.0",
    db_version: previous?.version ?? "(未知)",
  });

  const state = {
    format: 1,
    started_at: new Date().toISOString(),
    status: "in_progress",
    backup_dir: null,
    images: {},
    previous_db_version: previous,
    next_db_version: null,
    error: null,
  };
  writeJson(statePath, state);

  try {
    if (!args["skip-backup"]) {
      state.backup_dir = backup(stamp, args["cold-backup"] === true);
      writeJson(statePath, state);
      log("升级前备份完成", { dir: path.relative(ROOT, state.backup_dir) });
    } else {
      log("跳过升级前备份（回滚将不可用）");
    }

    state.images = tagPreviousImages(stamp);
    writeJson(statePath, state);
    log("旧镜像已打回滚标签", { tags: Object.keys(state.images).length });

    if (!args["skip-build"]) {
      compose(["build", "migrate", "web", "worker-app"], { inherit: true });
    } else {
      log("跳过镜像构建");
    }

    log("执行迁移");
    waitForMigrate();
    state.next_db_version = dbVersion();
    writeJson(statePath, state);

    log("拉起应用");
    compose(["up", "-d", "--no-deps", "web", "worker-app", "caddy"], { inherit: true });
    const report = await waitForHealth();

    state.status = "succeeded";
    state.finished_at = new Date().toISOString();
    state.next_db_version = report.db_version ?? state.next_db_version;
    writeJson(statePath, state);

    log("升级完成", {
      db_version: report.db_version?.version ?? "(未知)",
      web_version: report.version,
      state: path.relative(ROOT, statePath),
    });
  } catch (error) {
    state.status = "failed";
    state.finished_at = new Date().toISOString();
    state.error = error instanceof Error ? error.message : String(error);
    writeJson(statePath, state);

    console.error(`\n[delivery] 升级失败：${state.error}`);
    console.error("旧 web/worker 仍在运行；如需回滚执行：");
    console.error(`  npm run rollback -- --state ${path.relative(ROOT, statePath)} --yes`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[delivery] 升级失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
