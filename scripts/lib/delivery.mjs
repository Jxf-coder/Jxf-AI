/**
 * M5 交付底座：备份 / 恢复 / 升级 / 回滚的共用工具。
 *
 * 约定：
 * - 所有容器操作都走 docker compose（--env-file .env），不硬编码容器名；
 * - 备份产物落在 backups/<stamp>/，manifest.json 记录校验和与关键表行数；
 * - 恢复默认只做「影子库演练」，真正覆盖生产必须显式 --yes；
 * - 升级失败不启动新 web/worker，回滚依赖升级前备份 + 旧镜像标签。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const COMPOSE_ARGS = ["compose", "--env-file", ".env", "-f", "docker/docker-compose.yml"];
export const PROJECT = process.env.COMPOSE_PROJECT_NAME || "jxf-ai";
export const HELPER_IMAGE = process.env.BACKUP_HELPER_IMAGE || "jxf-ai/migrate:0.1.0";
export const DB_NAME = process.env.POSTGRES_DB || "jxf";
export const DB_USER = process.env.POSTGRES_USER || "postgres";

const APPLICATIONS = ["web", "worker-app", "migrate"];
const COUNT_TABLES = [
  "users",
  "departments",
  "memberships",
  "documents",
  "knowledge_cards",
  "runs",
  "work_items",
  "mcp_tokens",
  "mcp_servers",
  "app_versions",
];

export function log(message, fields = {}) {
  const suffix = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  console.log(`[delivery] ${message}${suffix}`);
}

export function fail(message) {
  console.error(`[delivery] 失败：${message}`);
  process.exit(1);
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function dockerPath(value) {
  return value.replace(/\\/g, "/");
}

export function docker(args, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || "").trim().slice(0, 800);
    throw new Error(`docker ${args.slice(0, 3).join(" ")} 退出码 ${result.status}：${detail}`);
  }
  return result;
}

export function compose(args, options = {}) {
  return docker([...COMPOSE_ARGS, ...args], options);
}

export function composeOutput(args) {
  return compose(args).stdout.trim();
}

export function containerId(service) {
  const id = composeOutput(["ps", "-q", service]).split(/\r?\n/)[0];
  if (!id) {
    throw new Error(`服务 ${service} 没有运行中的容器`);
  }
  return id;
}

function inspect(idOrName) {
  return JSON.parse(docker(["inspect", idOrName]).stdout)[0];
}

export function containerMountVolume(service, destination) {
  const id = containerId(service);
  const mount = inspect(id).Mounts?.find((item) => item.Destination === destination);
  return mount?.Name ?? null;
}

export function containerUser(service) {
  const id = containerId(service);
  const uid = docker(["exec", id, "id", "-u"]).stdout.trim();
  return /^\d+$/.test(uid) ? uid : "1001";
}

export function psql(sql, database = DB_NAME) {
  return docker([
    "exec",
    containerId("postgres"),
    "psql",
    "-U",
    DB_USER,
    "-d",
    database,
    "-At",
    "-c",
    sql,
  ]).stdout.trim();
}

export function dbVersion() {
  try {
    const raw = psql("select app.current_app_version()::text");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function tableCounts(database = DB_NAME) {
  const parts = COUNT_TABLES.map((table) => `'${table}', (select count(*) from ${table})`).join(", ");
  const raw = psql(`select jsonb_build_object(${parts})::text`, database);
  return JSON.parse(raw);
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function gitSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

/** 用一次性容器对命名卷打包；--numeric-owner 保证恢复时 UID 可还原 */
export function tarVolume(volume, outFile) {
  docker(
    [
      "run",
      "--rm",
      "--user",
      "0:0",
      "--entrypoint",
      "tar",
      "-v",
      `${volume}:/data:ro`,
      "-v",
      `${dockerPath(path.dirname(outFile))}:/backup`,
      HELPER_IMAGE,
      "--numeric-owner",
      "-czf",
      `/backup/${path.basename(outFile)}`,
      "-C",
      "/data",
      ".",
    ],
    { inherit: true },
  );
}

export function listTar(file) {
  const result = docker([
    "run",
    "--rm",
    "--user",
    "0:0",
    "--entrypoint",
    "tar",
    "-v",
    `${dockerPath(path.dirname(file))}:/backup:ro`,
    HELPER_IMAGE,
    "-tzf",
    `/backup/${path.basename(file)}`,
  ]);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

/** 覆盖式恢复命名卷：先清空，再解包，最后把属主改回运行用户 */
export function extractVolume(volume, file, uid) {
  docker(
    [
      "run",
      "--rm",
      "--user",
      "0:0",
      "--entrypoint",
      "sh",
      "-v",
      `${volume}:/data`,
      "-v",
      `${dockerPath(path.dirname(file))}:/backup:ro`,
      HELPER_IMAGE,
      "-c",
      `rm -rf /data/* /data/.[!.]* 2>/dev/null || true; tar --numeric-owner -xzf /backup/${path.basename(file)} -C /data; chown -R ${uid}:${uid} /data`,
    ],
    { inherit: true },
  );
}

export function waitForMigrate(timeoutMs = 180_000) {
  compose(["up", "-d", "migrate"], { inherit: true });
  const id = containerId("migrate");
  const result = docker(["wait", id], { allowFailure: true });
  const code = Number(result.stdout.trim() || "1");
  if (code !== 0) {
    const logs = docker(["logs", "--tail", "80", id], { allowFailure: true }).stdout;
    console.error(logs);
    throw new Error(`migrate 容器退出码 ${code}`);
  }
  return code;
}

export function waitForHealth(timeoutMs = 180_000) {
  const id = containerId("web");
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "未返回";

  while (Date.now() < deadline) {
    const result = spawnSync(
      "docker",
      ["exec", id, "wget", "-qO-", "http://127.0.0.1:3000/api/health"],
      { encoding: "utf8" },
    );
    if (result.status === 0) {
      try {
        const report = JSON.parse(result.stdout);
        if (report.status === "ok") {
          return report;
        }
        lastDetail = `status=${report.status} checks=${(report.checks ?? [])
          .filter((item) => item.status !== "ok")
          .map((item) => item.name)
          .join(",")}`;
      } catch {
        lastDetail = "健康响应不是合法 JSON";
      }
    } else {
      lastDetail = (result.stderr || "").trim().slice(0, 200) || `wget 退出码 ${result.status}`;
    }
    sleepSync(2_000);
  }

  throw new Error(`健康检查超时：${lastDetail}`);
}

export function latestBackupDir() {
  const base = path.join(ROOT, "backups");
  if (!existsSync(base)) {
    return null;
  }
  const dirs = readdirSync(base)
    .filter((name) => name.startsWith("backup-") && existsSync(path.join(base, name, "manifest.json")))
    .sort();
  return dirs.length > 0 ? path.join(base, dirs[dirs.length - 1]) : null;
}

export function latestUpgradeState() {
  const base = path.join(ROOT, "backups");
  if (!existsSync(base)) {
    return null;
  }
  const files = readdirSync(base)
    .filter((name) => name.startsWith("upgrade-") && name.endsWith(".json"))
    .sort();
  return files.length > 0 ? path.join(base, files[files.length - 1]) : null;
}

export { APPLICATIONS };
