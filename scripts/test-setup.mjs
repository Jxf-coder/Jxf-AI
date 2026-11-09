/**
 * 安装向导验收：模板替换、随机性、占位符检查与覆盖保护。
 * 不启动容器、不连接数据库。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findPlaceholders, generateEnv, PASSWORD_KEYS } from "./lib/setup.mjs";

const ROOT = process.cwd();
let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`[PASS] ${name}`);
    return;
  }
  failed += 1;
  console.error(`[FAIL] ${name}${detail ? ` :: ${detail}` : ""}`);
}

function section(content, key) {
  const match = new RegExp(`^${key}=(.*)$`, "m").exec(content);
  return match ? match[1] : null;
}

function main() {
  const template = readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const { content, generated } = generateEnv(template);

  check("生成项覆盖全部密钥字段", PASSWORD_KEYS.every((key) => generated.includes(key)));
  check("JXF_AUTH_SECRET 为 64 位十六进制", /^[0-9a-f]{64}$/.test(section(content, "JXF_AUTH_SECRET") ?? ""));
  check(
    "口令/令牌为 32 位字母数字",
    PASSWORD_KEYS.every((key) => /^[A-Za-z0-9]{32}$/.test(section(content, key) ?? "")),
  );
  check(
    "各口令互不相同",
    new Set(PASSWORD_KEYS.map((key) => section(content, key))).size === PASSWORD_KEYS.length,
  );
  check("不再残留 CHANGE_ME 占位值", findPlaceholders(content).length === 0, findPlaceholders(content).join("、"));

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "jxf-setup-"));
  const target = path.join(tempDir, ".env");
  const runner = path.join(ROOT, "scripts", "install.mjs");
  const run = (extra = []) =>
    spawnSync(process.execPath, [runner, "--env", target, "--no-checks", "--quiet", ...extra], {
      cwd: ROOT,
      encoding: "utf8",
    });

  try {
    const first = run();
    check("首次生成成功", first.status === 0, first.stderr ?? "");
    check("生成文件存在", existsSync(target));

    const written = readFileSync(target, "utf8");
    check("写入内容无占位值", findPlaceholders(written).length === 0);
    check(
      "每次生成使用新的随机密钥",
      section(written, "JXF_AUTH_SECRET") !== section(content, "JXF_AUTH_SECRET"),
    );

    const second = run();
    check("已存在时拒绝覆盖", second.status !== 0);

    const forced = run(["--force"]);
    check("--force 允许覆盖", forced.status === 0, forced.stderr ?? "");
    check(
      "覆盖前生成备份",
      readdirSync(tempDir).some((name) => name.startsWith(".env.bak-")),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`\n[setup] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
