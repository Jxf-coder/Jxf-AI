/**
 * 可观测性验收：app.metrics_snapshot() 以应用角色（jxf_app）可读，
 * 返回聚合计数且不含任何明细字段。
 */
import { Client } from "pg";

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

function isCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

async function main() {
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    throw new Error("缺少 APP_DATABASE_URL，请用 npm run test:metrics 执行");
  }

  const client = new Client({ connectionString, application_name: "jxf-metrics-test" });
  await client.connect();
  try {
    const { rows } = await client.query("select app.metrics_snapshot() as value");
    const snapshot = rows[0]?.value;
    check("函数返回对象", snapshot !== null && typeof snapshot === "object");

    check(
      "包含核心分组",
      ["runs", "work_items", "ops_tasks", "connectors", "pipelines"].every(
        (key) => snapshot?.[key] !== undefined,
      ),
    );
    check(
      "计数均为非负数字",
      isCount(snapshot?.pipeline_runs_open) &&
        isCount(snapshot?.audit_events) &&
        isCount(snapshot?.users) &&
        Object.values(snapshot?.runs ?? {}).every(isCount) &&
        Object.values(snapshot?.work_items ?? {}).every(isCount),
    );

    const connectors = snapshot?.connectors ?? {};
    check(
      "连接器健康分桶之和等于总数",
      isCount(connectors.total) &&
        connectors.healthy + connectors.degraded + connectors.down + connectors.unknown ===
          connectors.total,
      JSON.stringify(connectors),
    );

    check(
      "不包含用户 / 文档明细字段",
      !Object.keys(snapshot ?? {}).some((key) => /email|name|title|token|secret/.test(key)),
    );
    check("生成时间可解析", Number.isFinite(Date.parse(snapshot?.generated_at ?? "")));
  } finally {
    await client.end().catch(() => undefined);
  }

  console.log(`\n[metrics] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[metrics] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
