/**
 * M5 交付底座 · 回滚。
 *
 * 依赖 upgrade 写下的状态文件：
 *   - 升级前备份目录（数据库 + MinIO/uploads 卷）
 *   - 旧镜像标签（<image>:rollback-<stamp>）
 *
 * 回滚 = 旧镜像改回正式标签 + 覆盖式恢复备份 + migrate 补齐策略 + 健康检查。
 *
 * 用法：
 *   npm run rollback -- --state backups/upgrade-2026-....json --yes
 *   npm run rollback -- --state backups/upgrade-2026-....json --dry-run
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  docker,
  latestUpgradeState,
  log,
  parseArgs,
  readJson,
  resolveFromRoot,
  ROOT,
  writeJson,
} from "./lib/delivery.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stateFile = args.state ? resolveFromRoot(String(args.state)) : latestUpgradeState();
  if (!stateFile || !existsSync(stateFile)) {
    throw new Error("没有找到升级状态文件，请用 --state 指定");
  }

  const state = readJson(stateFile);
  if (!state.backup_dir) {
    throw new Error("该次升级跳过了备份，无法回滚数据库");
  }
  const backupDir = resolveFromRoot(String(state.backup_dir));
  if (!existsSync(path.join(backupDir, "manifest.json"))) {
    throw new Error(`升级前备份不完整：${backupDir}`);
  }

  log("回滚计划", {
    state: path.relative(ROOT, stateFile),
    backup: path.relative(ROOT, backupDir),
    previous_db_version: state.previous_db_version?.version ?? "(未知)",
    images: Object.keys(state.images ?? {}).length,
  });

  if (args["dry-run"] || !args.yes) {
    for (const [image, tag] of Object.entries(state.images ?? {})) {
      log("将回退镜像", { image, tag });
    }
    log("未执行；确认回滚请追加 --yes", {
      hint: `npm run rollback -- --state ${path.relative(ROOT, stateFile)} --yes`,
    });
    return;
  }

  for (const [image, tag] of Object.entries(state.images ?? {})) {
    const exists = docker(["image", "inspect", tag], { allowFailure: true });
    if (exists.status !== 0) {
      log("回滚标签不存在，跳过（保持当前镜像）", { image, tag });
      continue;
    }
    docker(["tag", tag, image], { inherit: true });
    log("镜像已回退", { image, tag });
  }

  log("恢复升级前备份（数据库与卷）");
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts/restore.mjs"), "--from", backupDir, "--yes"],
    { cwd: ROOT, env: process.env, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error("备份恢复失败，请检查 restore 输出");
  }

  state.rolled_back_at = new Date().toISOString();
  writeJson(stateFile, state);
  log("回滚完成", {
    db_version: state.previous_db_version?.version ?? "(未知)",
    note: "请同步把 .env 的 JXF_VERSION 改回旧版本，避免后续迁移写错版本号",
  });
}

main().catch((error) => {
  console.error(`[delivery] 回滚失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
