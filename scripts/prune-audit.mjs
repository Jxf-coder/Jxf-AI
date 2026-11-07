/**
 * M5 切片 2：审计留存清理。
 *
 * audit_events 对业务角色是 insert-only；清理只能由 owner 执行，
 * 且每次清理会追加一条 audit.retention_pruned 留痕。
 *
 * 用法：
 *   npm run audit:prune                      # 默认 365 天，演练
 *   npm run audit:prune -- --days 180 --yes  # 真正删除
 */
import { Client } from "pg";

const TENANT = process.env.JXF_TENANT_ID;
const HOST = process.env.SEED_DB_HOST ?? "127.0.0.1";
const PORT = process.env.POSTGRES_PORT ?? "5432";
const DB = process.env.POSTGRES_DB;
const OWNER_URL = `postgresql://${process.env.JXF_OWNER_USER}:${process.env.JXF_OWNER_PASSWORD}@${HOST}:${PORT}/${DB}`;
const BATCH = 10_000;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const days = Number.parseInt(String(args.days ?? process.env.AUDIT_RETENTION_DAYS ?? "365"), 10);
  if (!Number.isFinite(days) || days < 30) {
    throw new Error("留存天数必须 ≥ 30");
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const client = new Client({ connectionString: OWNER_URL, application_name: "jxf-audit-prune" });
  await client.connect();

  try {
    const before = await client.query(
      "select count(*)::int as n from audit_events where tenant_id = $1",
      [TENANT],
    );
    const candidates = await client.query(
      "select count(*)::int as n from audit_events where tenant_id = $1 and created_at < $2",
      [TENANT, cutoff],
    );

    console.log(
      `[audit:prune] 租户共 ${before.rows[0].n} 条；早于 ${cutoff.toISOString()}（${days} 天前）的有 ${candidates.rows[0].n} 条`,
    );

    if (args["dry-run"] || !args.yes) {
      console.log("[audit:prune] 演练模式，未删除；确认请追加 --yes");
      return;
    }

    let deleted = 0;
    for (;;) {
      const result = await client.query(
        `delete from audit_events
          where id in (
            select id from audit_events
             where tenant_id = $1 and created_at < $2
             limit ${BATCH}
          )`,
        [TENANT, cutoff],
      );
      deleted += result.rowCount ?? 0;
      if ((result.rowCount ?? 0) < BATCH) {
        break;
      }
    }

    await client.query(
      `insert into audit_events (tenant_id, actor_user_id, department_id, action, target_type, payload)
       values ($1, null, null, 'audit.retention_pruned', 'audit_events', $2::jsonb)`,
      [
        TENANT,
        JSON.stringify({
          retention_days: days,
          cutoff: cutoff.toISOString(),
          deleted,
          remaining: before.rows[0].n - deleted,
        }),
      ],
    );

    console.log(`[audit:prune] 已删除 ${deleted} 条，并写入 audit.retention_pruned`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[audit:prune] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
