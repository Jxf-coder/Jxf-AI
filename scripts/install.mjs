/**
 * 安装向导（P5 后续切片）：从 .env.example 生成可启动的 .env。
 *
 * 用法：
 *   npm run setup                     # 生成仓库根目录 .env（已存在则拒绝）
 *   npm run setup -- --force          # 覆盖前自动备份为 .env.bak-<时间戳>
 *   npm run setup -- --env dev.env    # 指定输出路径
 *   npm run setup -- --no-checks      # 跳过 node / docker 前置检查
 *
 * 只生成随机密钥与口令，不修改模板中的其余配置；不会自动启动容器，
 * 结束后打印后续命令，避免向导替用户做不可逆操作。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ROOT } from "./lib/delivery.mjs";
import { findPlaceholders, generateEnv } from "./lib/setup.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function fail(message) {
  console.error(`[setup] ${message}`);
  process.exit(1);
}

function checkPrerequisites() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(major) || major < 22) {
    fail(`Node.js 版本过低（当前 ${process.versions.node}），需要 >= 22`);
  }
  const docker = spawnSync("docker", ["--version"], { encoding: "utf8" });
  if (docker.status !== 0) {
    fail("未检测到 docker，请先安装 Docker Desktop / Docker Engine");
  }
  const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (compose.status !== 0) {
    fail("未检测到 docker compose（需要 v2 插件）");
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const quiet = args.quiet === true;
  const templatePath = path.join(ROOT, ".env.example");
  if (!existsSync(templatePath)) {
    fail("找不到 .env.example，请在仓库根目录执行");
  }

  if (args["no-checks"] !== true) {
    checkPrerequisites();
  }

  const target = path.isAbsolute(String(args.env ?? ""))
    ? String(args.env)
    : path.join(ROOT, String(args.env ?? ".env"));

  if (existsSync(target)) {
    if (args.force !== true) {
      fail(`目标已存在：${path.relative(ROOT, target)}（如需覆盖请加 --force，会自动备份）`);
    }
    const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(target, backup);
    if (!quiet) {
      console.log(`[setup] 已备份旧配置：${path.relative(ROOT, backup)}`);
    }
  }

  const template = readFileSync(templatePath, "utf8");
  const { content, generated } = generateEnv(template);
  const leftovers = findPlaceholders(content);
  if (leftovers.length > 0) {
    fail(`仍有未替换的占位值：${leftovers.join("、")}`);
  }

  writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });

  if (!quiet) {
    console.log(`[setup] 已生成 ${path.relative(ROOT, target)}（权限 600）`);
    console.log(`[setup] 随机生成：${generated.join("、")}`);
    console.log("");
    console.log("后续步骤：");
    console.log("  1. 按需修改 .env（域名 JXF_SITE_ADDRESS、AI Key、SMTP 等）");
    console.log("  2. docker compose --env-file .env -f docker/docker-compose.yml up -d --build");
    console.log("  3. （仅开发）npm run seed 创建演示账号");
    console.log("  4. 打开 http://127.0.0.1/ 登录；宿主机另起 npm run ops:runner 执行备份/产线");
  }
}

main();
