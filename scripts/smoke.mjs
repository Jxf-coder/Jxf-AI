/**
 * M5 切片 2：部署冒烟。
 *
 * 在部署机（能执行 docker compose 的宿主机）上运行：
 *   npm run smoke
 *
 * 覆盖：compose 配置、核心容器健康、存活/就绪探针、版本表、未认证接口 401、最近备份存在性。
 * 不写业务数据，可重复执行。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { compose, containerId, dbVersion, docker, latestBackupDir } from "./lib/delivery.mjs";

const results = [];

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  const tag = status === "PASS" ? "[PASS]" : status === "WARN" ? "[WARN]" : "[FAIL]";
  console.log(`${tag} ${name}${detail ? ` :: ${detail}` : ""}`);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function httpChecks() {
  const script = `
const base = "http://127.0.0.1:3000";
(async () => {
  const out = {};
  const hit = async (key, path, init) => {
    try {
      const response = await fetch(base + path, init);
      out[key] = { status: response.status, body: await response.text() };
    } catch (error) {
      out[key] = { error: String(error) };
    }
  };
  await hit("live", "/api/health/live");
  await hit("health", "/api/health");
  await hit("login", "/login");
  await hit("mcp", "/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  await hit("audit", "/api/audit/export");
  await hit("handover", "/api/handover/export?membershipId=00000000-0000-4000-8000-000000000000");
  await hit("settings", "/settings", { redirect: "manual" });
  await hit("pipelines", "/pipelines", { redirect: "manual" });
  console.log(JSON.stringify(out));
})();
`;

  const result = docker(["exec", containerId("web"), "node", "-e", script]);
  return parseJson(result.stdout) ?? {};
}

function checkContainers() {
  for (const service of ["postgres", "minio", "web"]) {
    try {
      const id = containerId(service);
      const info = JSON.parse(docker(["inspect", id]).stdout)[0];
      const running = Boolean(info?.State?.Running);
      const health = info?.State?.Health?.Status;
      const ok = running && (!health || health === "healthy");
      record(`容器 ${service}`, ok ? "PASS" : "FAIL", `running=${running} health=${health ?? "-"}`);
    } catch (error) {
      record(`容器 ${service}`, "FAIL", error instanceof Error ? error.message : String(error));
    }
  }
}

function checkBackup() {
  const dir = latestBackupDir();
  if (!dir) {
    record("最近备份", "WARN", "没有备份产物，建议先执行 npm run backup");
    return;
  }
  const manifestFile = path.join(dir, "manifest.json");
  const manifest = parseJson(readFileSync(manifestFile, "utf8"));
  const ageDays = Math.floor((Date.now() - statSync(manifestFile).mtimeMs) / 86_400_000);
  record(
    "最近备份",
    ageDays <= 7 ? "PASS" : "WARN",
    `${path.basename(dir)} · ${ageDays} 天前 · v${manifest?.db_version?.version ?? "?"}`,
  );
  if (manifest?.files) {
    const missing = Object.keys(manifest.files).filter(
      (name) => !existsSync(path.join(dir, name)),
    );
    record("备份文件完整性", missing.length === 0 ? "PASS" : "FAIL", missing.join(",") || "OK");
  }
}

function main() {
  try {
    compose(["config", "-q"]);
    record("compose 配置", "PASS");
  } catch (error) {
    record("compose 配置", "FAIL", error instanceof Error ? error.message : String(error));
    summarize();
    return;
  }

  checkContainers();

  let http = {};
  try {
    http = httpChecks();
  } catch (error) {
    record("HTTP 探针", "FAIL", error instanceof Error ? error.message : String(error));
  }

  if (http.live) {
    record("存活探针 /api/health/live", http.live.status === 200 ? "PASS" : "FAIL", `HTTP ${http.live.status}`);
  }
  const health = http.health ? parseJson(http.health.body) : null;
  record(
    "就绪探针 /api/health",
    http.health?.status === 200 && health?.status === "ok" ? "PASS" : "FAIL",
    health ? `status=${health.status}` : `HTTP ${http.health?.status ?? "-"}`,
  );
  record(
    "版本表",
    health?.db_version?.version ? "PASS" : "FAIL",
    health?.db_version ? `v${health.db_version.version}` : "健康响应缺少 db_version",
  );
  record("登录页 /login", http.login?.status === 200 ? "PASS" : "FAIL", `HTTP ${http.login?.status ?? "-"}`);
  record("MCP 未认证拒绝", http.mcp?.status === 401 ? "PASS" : "FAIL", `HTTP ${http.mcp?.status ?? "-"}`);
  record(
    "审计导出未认证拒绝",
    http.audit?.status === 401 ? "PASS" : "FAIL",
    `HTTP ${http.audit?.status ?? "-"}`,
  );
  record(
    "交接包导出未认证拒绝",
    http.handover?.status === 401 ? "PASS" : "FAIL",
    `HTTP ${http.handover?.status ?? "-"}`,
  );
  record(
    "设置页未登录跳转登录",
    [302, 307].includes(http.settings?.status) ? "PASS" : "FAIL",
    `HTTP ${http.settings?.status ?? "-"}`,
  );
  record(
    "产线页未登录跳转登录",
    [302, 307].includes(http.pipelines?.status) ? "PASS" : "FAIL",
    `HTTP ${http.pipelines?.status ?? "-"}`,
  );

  const version = dbVersion();
  record("数据库版本函数", version?.version ? "PASS" : "FAIL", version ? `v${version.version}` : "无返回值");

  checkBackup();
  summarize();
}

function summarize() {
  const failed = results.filter((item) => item.status === "FAIL").length;
  const warned = results.filter((item) => item.status === "WARN").length;
  console.log(`\n[smoke] passed=${results.length - failed - warned} warned=${warned} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
