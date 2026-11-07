/**
 * M5 切片 2：授权收口体检。
 *
 * 检查项：
 *   1. user_permission_grants / role_template_grants 是否引用了目录里已不存在的权限点（代码漂移）；
 *   2. 过期但未清理的用户级授权；
 *   3. 名下已无在岗任用、却仍留有用户级授权的账号；
 *   4. 授权给已停用 / 草稿 AI 员工的记录。
 *
 * 用法：
 *   npm run audit:grants                    # 只体检
 *   npm run audit:grants -- --fix-expired   # 顺手清理过期授权
 *   npm run audit:grants -- --strict        # 警告也返回非 0
 */
import { Client } from "pg";

import { PERMISSION_NODES } from "../src/lib/permissions/catalog.ts";

const TENANT = process.env.JXF_TENANT_ID;
const HOST = process.env.SEED_DB_HOST ?? "127.0.0.1";
const PORT = process.env.POSTGRES_PORT ?? "5432";
const DB = process.env.POSTGRES_DB;
const OWNER_URL = `postgresql://${process.env.JXF_OWNER_USER}:${process.env.JXF_OWNER_PASSWORD}@${HOST}:${PORT}/${DB}`;

function parseArgs(argv) {
  const args = {};
  for (const item of argv) {
    if (item.startsWith("--")) {
      args[item.slice(2)] = true;
    }
  }
  return args;
}

function printList(title, rows, key = "permission_key") {
  if (rows.length === 0) {
    return;
  }
  console.log(`\n${title}（${rows.length}）`);
  for (const row of rows.slice(0, 20)) {
    console.log(`  - ${row[key] ?? JSON.stringify(row)}`);
  }
  if (rows.length > 20) {
    console.log(`  … 其余 ${rows.length - 20} 条省略`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalogKeys = new Set(PERMISSION_NODES.map((node) => node.key));
  const client = new Client({ connectionString: OWNER_URL, application_name: "jxf-audit-grants" });
  await client.connect();

  let failed = 0;
  let warned = 0;

  try {
    const unknownUserKeys = await client.query(
      `select distinct permission_key from user_permission_grants
        where tenant_id = $1 and not (permission_key = any($2::text[]))
        order by permission_key`,
      [TENANT, [...catalogKeys]],
    );
    const unknownTemplateKeys = await client.query(
      `select distinct permission_key from role_template_grants
        where not (permission_key = any($1::text[]))
        order by permission_key`,
      [[...catalogKeys]],
    );

    if (unknownUserKeys.rows.length > 0 || unknownTemplateKeys.rows.length > 0) {
      failed += 1;
      console.error("[FAIL] 存在目录中不存在的权限点");
      printList("用户级未知权限", unknownUserKeys.rows);
      printList("模板级未知权限", unknownTemplateKeys.rows);
    } else {
      console.log("[PASS] 授权引用的权限点全部存在于目录");
    }

    const expired = await client.query(
      `select id, user_id, permission_key, expires_at
         from user_permission_grants
        where tenant_id = $1 and expires_at is not null and expires_at <= now()
        order by expires_at`,
      [TENANT],
    );
    if (expired.rows.length > 0) {
      if (args["fix-expired"]) {
        const removed = await client.query(
          `delete from user_permission_grants
            where tenant_id = $1 and expires_at is not null and expires_at <= now()`,
          [TENANT],
        );
        console.log(`[PASS] 已清理过期授权 ${removed.rowCount ?? 0} 条`);
      } else {
        warned += 1;
        console.warn(`[WARN] 过期授权 ${expired.rows.length} 条（可用 --fix-expired 清理）`);
        printList("过期授权", expired.rows, "permission_key");
      }
    } else {
      console.log("[PASS] 没有过期授权");
    }

    const orphan = await client.query(
      `select g.user_id, u.name, count(*)::int as grants
         from user_permission_grants g
         left join users u on u.id = g.user_id
        where g.tenant_id = $1
          and not exists (
            select 1 from memberships m
             where m.user_id = g.user_id and m.status = 'active' and m.removed_at is null
          )
        group by g.user_id, u.name
        order by grants desc`,
      [TENANT],
    );
    if (orphan.rows.length > 0) {
      warned += 1;
      console.warn(`[WARN] 无在岗任用但仍有用户级授权的账号：${orphan.rows.length}`);
      printList("孤立授权账号", orphan.rows, "name");
    } else {
      console.log("[PASS] 没有孤立授权账号");
    }

    const inactiveAgents = await client.query(
      `select g.ai_employee_id, e.name, e.status, count(*)::int as grants
         from ai_employee_grants g
         join ai_employees e on e.id = g.ai_employee_id
        where g.tenant_id = $1 and e.status <> 'active'
        group by g.ai_employee_id, e.name, e.status
        order by grants desc`,
      [TENANT],
    );
    if (inactiveAgents.rows.length > 0) {
      warned += 1;
      console.warn(`[WARN] 授权给未上线 AI 员工的记录：${inactiveAgents.rows.length}`);
      printList("未上线员工授权", inactiveAgents.rows, "name");
    } else {
      console.log("[PASS] 没有授权给未上线 AI 员工");
    }

    console.log(`\n[audit:grants] failed=${failed} warned=${warned}`);
    if (failed > 0 || (args.strict && warned > 0)) {
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[audit:grants] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
