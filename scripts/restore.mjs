/**
 * M5 交付底座 · 恢复。
 *
 * 两种模式：
 *   --verify       影子库演练：校验 manifest/校验和，把 dump 恢复进临时库并比对关键表行数；
 *   --yes          覆盖式恢复：停应用 → pg_restore 覆盖生产库 → 还原 MinIO / uploads 卷 →
 *                  migrate 补齐策略与版本 → 拉起并等待健康。
 *
 * 用法：
 *   npm run restore -- --from backups/backup-2026-... --verify
 *   npm run restore -- --from backups/backup-2026-... --yes
 */
import { existsSync } from "node:fs";
import path from "node:path";

import {
  compose,
  containerId,
  containerUser,
  DB_NAME,
  DB_USER,
  docker,
  extractVolume,
  latestBackupDir,
  listTar,
  log,
  parseArgs,
  psql,
  readJson,
  resolveFromRoot,
  sha256File,
  tableCounts,
  waitForHealth,
  waitForMigrate,
} from "./lib/delivery.mjs";

function resolveBackupDir(args) {
  if (args.from) {
    return resolveFromRoot(String(args.from));
  }
  const latest = latestBackupDir();
  if (!latest) {
    throw new Error("没有找到备份目录，请用 --from 指定");
  }
  return latest;
}

async function verifyManifest(dir) {
  const manifestFile = path.join(dir, "manifest.json");
  if (!existsSync(manifestFile)) {
    throw new Error(`缺少 manifest.json：${dir}`);
  }
  const manifest = readJson(manifestFile);
  if (manifest.format !== 1) {
    throw new Error(`不支持的备份格式：${manifest.format}`);
  }

  for (const [name, meta] of Object.entries(manifest.files ?? {})) {
    const file = path.join(dir, name);
    if (!existsSync(file)) {
      throw new Error(`备份文件缺失：${name}`);
    }
    const digest = await sha256File(file);
    if (digest !== meta.sha256) {
      throw new Error(`校验和不匹配：${name}`);
    }
  }

  for (const [key, volume] of Object.entries(manifest.volumes ?? {})) {
    const file = path.join(dir, volume.file);
    const entries = listTar(file);
    log("卷归档可读", { volume: key, entries: entries.length });
    if (entries.length === 0) {
      throw new Error(`卷归档为空：${volume.file}`);
    }
  }

  return manifest;
}

function compareCounts(expected, actual) {
  const diffs = [];
  for (const [table, value] of Object.entries(expected ?? {})) {
    if (Number(actual?.[table]) !== Number(value)) {
      diffs.push(`${table}: ${value} → ${actual?.[table]}`);
    }
  }
  return diffs;
}

async function verifyAgainstScratch(dir, manifest) {
  const pg = containerId("postgres");
  const scratch = `jxf_restore_check_${Date.now()}`;
  const remoteDump = `/tmp/${scratch}.dump`;

  psql(`create database "${scratch}"`);
  log("影子库已创建", { database: scratch });

  try {
    docker(["cp", path.join(dir, "postgres.dump"), `${pg}:${remoteDump}`]);
    docker(
      ["exec", pg, "pg_restore", "-U", DB_USER, "-d", scratch, "--no-owner", remoteDump],
      { inherit: true },
    );

    const counts = tableCounts(scratch);
    const diffs = compareCounts(manifest.counts, counts);
    if (diffs.length > 0) {
      throw new Error(`影子库行数不一致：${diffs.join("；")}`);
    }
    log("影子库恢复演练通过", { database: scratch, tables: Object.keys(counts).length });
    return counts;
  } finally {
    docker(["exec", pg, "rm", "-f", remoteDump], { allowFailure: true });
    try {
      psql(`drop database if exists "${scratch}"`);
      log("影子库已清理", { database: scratch });
    } catch (error) {
      log("影子库清理失败，请手工删除", {
        database: scratch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function restoreInPlace(dir, manifest) {
  const pg = containerId("postgres");
  const owner = process.env.JXF_OWNER_USER || DB_USER;
  const minioUid = manifest.volumes?.miniodata ? containerUser("minio") : null;
  const uploadsUid = manifest.volumes?.uploads ? containerUser("web") : null;
  const remoteDump = `/tmp/restore-${Date.now()}.dump`;

  log("停止应用与对象存储");
  compose(["stop", "caddy", "web", "worker-app", "minio"], { inherit: true });

  try {
    docker(["cp", path.join(dir, "postgres.dump"), `${pg}:${remoteDump}`]);

    // 直接重建数据库：比 --clean 更确定，避免扩展/自定义 schema 的依赖顺序问题
    psql(`drop database if exists "${DB_NAME}" with (force)`, "postgres");
    psql(`create database "${DB_NAME}" owner "${owner}"`, "postgres");
    log("数据库已重建", { database: DB_NAME, owner });

    docker(
      ["exec", pg, "pg_restore", "-U", DB_USER, "-d", DB_NAME, remoteDump],
      { inherit: true },
    );
    log("数据库已覆盖恢复", { database: DB_NAME });
  } finally {
    docker(["exec", pg, "rm", "-f", remoteDump], { allowFailure: true });
  }

  if (manifest.volumes?.miniodata) {
    log("恢复对象存储卷", { volume: manifest.volumes.miniodata.volume });
    extractVolume(
      manifest.volumes.miniodata.volume,
      path.join(dir, manifest.volumes.miniodata.file),
      minioUid,
    );
  }
  if (manifest.volumes?.uploads) {
    log("恢复上传目录卷", { volume: manifest.volumes.uploads.volume });
    extractVolume(
      manifest.volumes.uploads.volume,
      path.join(dir, manifest.volumes.uploads.file),
      uploadsUid,
    );
  }

  log("执行迁移补齐策略与版本");
  waitForMigrate();

  compose(["up", "-d", "--no-deps", "minio", "web", "worker-app", "caddy"], {
    inherit: true,
  });
  const report = waitForHealth();
  log("恢复完成，健康检查通过", { version: report.version, db_version: report.db_version?.version });
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = resolveBackupDir(args);
  const manifest = await verifyManifest(dir);
  log("备份校验通过", {
    from: path.relative(process.cwd(), dir),
    created_at: manifest.created_at,
    app_version: manifest.app_version,
  });

  if (args.verify) {
    await verifyAgainstScratch(dir, manifest);
    return;
  }

  if (!args.yes) {
    log("默认只做演练，未写入生产。确认覆盖请追加 --yes", {
      hint: `npm run restore -- --from ${path.relative(process.cwd(), dir)} --yes`,
    });
    return;
  }

  log("开始覆盖式恢复（生产库将被替换）", { database: DB_NAME });
  await restoreInPlace(dir, manifest);
}

main().catch((error) => {
  console.error(`[delivery] 恢复失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
