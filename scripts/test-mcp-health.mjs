/**
 * P5 切片 3：MCP 连接器心跳体检验收。
 *
 * 用假 probe 驱动状态机，不访问任何外部网络：
 *   unknown → degraded → down（连续失败 3 次）→ healthy（恢复）
 * 同时校验数据库健康列、审计迁移事件、告警回调和 worker 降级 SQL 条件。
 *
 * 运行：npm run test:mcp-health
 */
import { Client } from "pg";

import { checkConnectorsAsOwner } from "../src/lib/mcp/health.ts";

const TENANT = process.env.JXF_TENANT_ID;
const HOST = process.env.SEED_DB_HOST ?? "127.0.0.1";
const PORT = process.env.SEED_DB_PORT ?? process.env.POSTGRES_PORT ?? "5432";
const DB = process.env.POSTGRES_DB;
const OWNER_URL = `postgresql://${process.env.JXF_OWNER_USER}:${process.env.JXF_OWNER_PASSWORD}@${HOST}:${PORT}/${DB}`;

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

const failingProbe = async () => {
  throw new Error("connect ECONNREFUSED 127.0.0.1:9");
};
const healthyProbe = async () => [];

async function main() {
  if (!TENANT || !DB || !process.env.JXF_OWNER_USER) {
    throw new Error("缺少数据库环境变量，请用 npm run test:mcp-health 执行");
  }

  const client = new Client({ connectionString: OWNER_URL, application_name: "jxf-mcp-health-test" });
  await client.connect();

  const name = `health-test-${Date.now()}`;
  let serverId = null;
  const alerts = [];

  try {
    const inserted = await client.query(
      `insert into mcp_servers (tenant_id, name, transport, url, enabled, timeout_ms, health_status)
       values ($1, $2, 'http', 'http://127.0.0.1:9/mcp', true, 1000, 'unknown')
       returning id`,
      [TENANT, name],
    );
    serverId = inserted.rows[0].id;

    const sweep = (probe) =>
      checkConnectorsAsOwner(client, {
        probe,
        serverIds: [serverId],
        onAlert: async (alert) => {
          alerts.push(alert);
        },
      });

    let results = await sweep(failingProbe);
    check("首次失败 → degraded", results[0]?.status === "degraded", JSON.stringify(results[0]));
    check("首次失败触发告警", results[0]?.transition === "unhealthy" && alerts.length === 1);

    results = await sweep(failingProbe);
    check("第二次失败仍 degraded 且不重复告警", results[0]?.status === "degraded" && alerts.length === 1);

    results = await sweep(failingProbe);
    check("第三次失败 → down 并升级告警", results[0]?.status === "down" && alerts.length === 2);

    const stored = await client.query(
      "select health_status, health_consecutive_failures, health_last_error from mcp_servers where id = $1",
      [serverId],
    );
    check(
      "健康列已落库",
      stored.rows[0]?.health_status === "down" && stored.rows[0]?.health_consecutive_failures === 3,
      JSON.stringify(stored.rows[0]),
    );

    const workerVisible = await client.query(
      "select count(*)::int as n from mcp_servers where id = $1 and enabled and health_status <> 'down'",
      [serverId],
    );
    check("熔断后 worker 工具计划排除该连接器", workerVisible.rows[0]?.n === 0);

    const unhealthyAudits = await client.query(
      "select count(*)::int as n from audit_events where target_id = $1 and action = 'mcp.connector_unhealthy'",
      [serverId],
    );
    check("异常迁移写审计（degraded + down 各一次）", unhealthyAudits.rows[0]?.n === 2);

    results = await sweep(healthyProbe);
    check("恢复 → healthy 且计数清零", results[0]?.status === "healthy" && results[0]?.failures === 0);
    check("恢复触发 recovered 告警", results[0]?.transition === "recovered" && alerts.length === 3);

    const recoveredAudits = await client.query(
      "select count(*)::int as n from audit_events where target_id = $1 and action = 'mcp.connector_recovered'",
      [serverId],
    );
    check("恢复写审计", recoveredAudits.rows[0]?.n === 1);
  } finally {
    if (serverId) {
      await client.query("delete from audit_events where target_id = $1", [serverId]).catch(() => undefined);
      await client.query("delete from mcp_servers where id = $1", [serverId]).catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }

  console.log(`\n[mcp-health] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[mcp-health] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
