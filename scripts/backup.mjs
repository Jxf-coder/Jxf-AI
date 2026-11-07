/**
 * M5 交付底座 · 备份。
 *
 * 产物：
 *   backups/backup-<stamp>/postgres.dump   PG 逻辑备份（custom format）
 *   backups/backup-<stamp>/miniodata.tgz   对象存储命名卷
 *   backups/backup-<stamp>/uploads.tgz     public/uploads 命名卷
 *   backups/backup-<stamp>/manifest.json   版本、校验和、关键表行数
 *
 * 用法：
 *   npm run backup -- --out backups/manual-1
 *   npm run backup -- --cold           # 停应用与 MinIO 做一致性快照，完成后自动拉起
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import path from "node:path";

import {
  compose,
  containerId,
  containerMountVolume,
  dbVersion,
  DB_NAME,
  docker,
  ensureDir,
  gitSha,
  log,
  parseArgs,
  resolveFromRoot,
  sha256File,
  tableCounts,
  tarVolume,
  timestamp,
  writeJson,
} from "./lib/delivery.mjs";

const APPS = ["caddy", "web", "worker-app", "minio"];
const DB_USER = process.env.POSTGRES_USER || "postgres";

/** pg_dump 输出直接流式写入文件，避免把整个库读进内存 */
function dumpDatabaseToFile(pgContainer, outFile) {
  const fd = openSync(outFile, "w");
  try {
    const result = spawnSync(
      "docker",
      ["exec", pgContainer, "pg_dump", "-U", DB_USER, "-d", DB_NAME, "-Fc", "-Z", "6"],
      { stdio: ["ignore", fd, "pipe"], maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      const detail = (result.stderr || "").toString().trim().slice(0, 800);
      throw new Error(`pg_dump 退出码 ${result.status}：${detail}`);
    }
  } finally {
    closeSync(fd);
  }
}

function postgresVersion() {
  try {
    return docker([
      "exec",
      containerId("postgres"),
      "psql",
      "-U",
      DB_USER,
      "-d",
      DB_NAME,
      "-At",
      "-c",
      "show server_version",
    ]).stdout.trim();
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = timestamp();
  const outDir = ensureDir(
    resolveFromRoot(args.out ? String(args.out) : path.join("backups", `backup-${stamp}`)),
  );
  const cold = args.cold === true;

  // 先解析容器与卷，再停服务：冷备后 `compose ps -q` 看不到已停止的服务
  const pgContainer = containerId("postgres");
  const minioVolume = containerMountVolume("minio", "/bitnami/minio/data");
  const uploadsVolume = containerMountVolume("web", "/app/public/uploads");

  log("开始备份", { out: path.relative(process.cwd(), outDir), cold });
  if (cold) {
    compose(["stop", ...APPS], { inherit: true });
  }

  try {
    const dumpFile = path.join(outDir, "postgres.dump");
    dumpDatabaseToFile(pgContainer, dumpFile);
    log("数据库备份完成", { file: path.basename(dumpFile) });

    const volumes = {};
    if (minioVolume) {
      tarVolume(minioVolume, path.join(outDir, "miniodata.tgz"));
      volumes.miniodata = { volume: minioVolume, file: "miniodata.tgz" };
      log("对象存储卷打包完成", { volume: minioVolume });
    } else {
      log("跳过对象存储卷（未找到挂载）");
    }

    if (uploadsVolume) {
      tarVolume(uploadsVolume, path.join(outDir, "uploads.tgz"));
      volumes.uploads = { volume: uploadsVolume, file: "uploads.tgz" };
      log("上传目录卷打包完成", { volume: uploadsVolume });
    } else {
      log("跳过上传目录卷（未找到挂载）");
    }

    const files = {};
    for (const name of ["postgres.dump", "miniodata.tgz", "uploads.tgz"]) {
      const file = path.join(outDir, name);
      if (!existsSync(file)) {
        continue;
      }
      files[name] = { sha256: await sha256File(file), bytes: statSync(file).size };
    }

    const manifest = {
      format: 1,
      created_at: new Date().toISOString(),
      cold,
      app_version: process.env.JXF_VERSION || "0.1.0",
      git_sha: gitSha(),
      db_version: dbVersion(),
      postgres_version: postgresVersion(),
      database: DB_NAME,
      files,
      volumes,
      counts: tableCounts(),
    };
    writeJson(path.join(outDir, "manifest.json"), manifest);

    log("备份完成", {
      files: Object.keys(files).length,
      counts: manifest.counts,
      manifest: path.join(path.basename(outDir), "manifest.json"),
    });
    console.log(`\n恢复演练：npm run restore -- --from ${path.relative(process.cwd(), outDir)} --verify`);
  } finally {
    if (cold) {
      compose(["up", "-d", "--no-deps", ...APPS], { inherit: true });
      log("应用已重新拉起");
    }
  }
}

main().catch((error) => {
  console.error(`[delivery] 备份失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
