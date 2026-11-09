/**
 * P5 设置面验收：RLS 边界、单行配置、公开读取函数与密钥加密。
 *
 * 运行：npm run test:settings（需要 .env 与已应用的 0022 迁移）
 */
import { Client } from "pg";

const TENANT = process.env.JXF_TENANT_ID;
const HOST = process.env.SEED_DB_HOST ?? "127.0.0.1";
const PORT = process.env.SEED_DB_PORT ?? process.env.POSTGRES_PORT ?? "5432";
const DB = process.env.POSTGRES_DB;
const OWNER_URL = `postgresql://${process.env.JXF_OWNER_USER}:${process.env.JXF_OWNER_PASSWORD}@${HOST}:${PORT}/${DB}`;
const APP_URL = `postgresql://${process.env.JXF_APP_USER}:${process.env.JXF_APP_PASSWORD}@${HOST}:${PORT}/${DB}`;

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

async function withClient(url, fn) {
  const client = new Client({ connectionString: url, application_name: "jxf-app-settings-test" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function runAs(actor, fn) {
  return withClient(APP_URL, async (client) => {
    await client.query("begin");
    await client.query(
      `select
         set_config('app.user_id', $1, true),
         set_config('app.tenant_id', $2, true),
         set_config('app.access_level', $3, true),
         set_config('app.department_ids', $4, true),
         set_config('app.active_department_id', $5, true),
         set_config('app.membership_id', $6, true)`,
      [actor.userId, TENANT, actor.level, `{${actor.departmentId}}`, actor.departmentId, actor.membershipId],
    );
    try {
      return await fn(client);
    } finally {
      await client.query("rollback").catch(() => {});
    }
  });
}

/** 期望被权限 / RLS 拒绝的语句：用 savepoint 包住，避免事务进入 aborted 状态 */
async function expectDenied(client, sql, params = []) {
  await client.query("savepoint deny");
  try {
    await client.query(sql, params);
    await client.query("release savepoint deny");
    return false;
  } catch {
    await client.query("rollback to savepoint deny");
    return true;
  }
}

async function loadActor(level) {
  return withClient(OWNER_URL, async (owner) => {
    const { rows } = await owner.query(
      `select m.user_id, m.id as membership_id, m.department_id, m.access_level
         from memberships m
        where m.tenant_id = $1 and m.status = 'active' and m.access_level = $2
        order by m.created_at
        limit 1`,
      [TENANT, level],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      userId: row.user_id,
      membershipId: row.membership_id,
      departmentId: row.department_id,
      level: row.access_level,
    };
  });
}

async function main() {
  if (!TENANT || !DB || !process.env.JXF_OWNER_USER || !process.env.JXF_APP_USER) {
    throw new Error("缺少数据库环境变量，请用 npm run test:settings 执行");
  }

  const { encryptSecret, decryptSecret, secretHint } = await import("../src/lib/settings/crypto.ts");

  const plain = "sk-test-1234567890abcd";
  const encrypted = encryptSecret(plain);
  const dedicated = process.env.JXF_DATA_ENCRYPTION_KEY?.trim() ?? "";
  check("密钥加密后可解密", decryptSecret(encrypted) === plain);
  check("密文不含明文", !encrypted.includes(plain));
  check(
    `密文格式为 ${dedicated ? "v2" : "v1"}`,
    encrypted.startsWith(dedicated ? "v2." : "v1."),
  );
  check("脱敏只保留末 4 位", secretHint(plain) === "••••abcd");
  check("篡改密文解密失败", decryptSecret(`${encrypted.slice(0, -4)}AAAA`) === null);

  if (dedicated) {
    // 双密钥过渡：旧部署留下的 v1 密文在配置专用密钥后仍要能解
    delete process.env.JXF_DATA_ENCRYPTION_KEY;
    const legacy = encryptSecret(plain);
    process.env.JXF_DATA_ENCRYPTION_KEY = dedicated;
    check(
      "配置专用密钥后仍可解旧 v1 密文",
      legacy.startsWith("v1.") && decryptSecret(legacy) === plain,
    );
    // 反方向：专用密钥丢失时 v2 密文必须解不开，由调用方回退环境变量
    const modern = encryptSecret(plain);
    delete process.env.JXF_DATA_ENCRYPTION_KEY;
    check("移除专用密钥后 v2 密文不再可解", decryptSecret(modern) === null);
    process.env.JXF_DATA_ENCRYPTION_KEY = dedicated;
  }

  // 无上下文：只能走 SECURITY DEFINER 函数，不能直接读表
  await withClient(APP_URL, async (app) => {
    const table = await app.query("select count(*)::int as n from app_settings");
    check("无身份直接查 app_settings 被 RLS 拦截", table.rows[0].n === 0);

    const branding = await app.query("select app.public_branding() as value");
    const value = branding.rows[0]?.value ?? {};
    check("public_branding 返回站点名", typeof value.site_name === "string" && value.site_name.length > 0);
    check(
      "public_branding 色值为 #RRGGBB",
      ["brand_primary", "brand_strong", "brand_deep", "brand_soft"].every((key) =>
        /^#[0-9a-f]{6}$/i.test(String(value[key] ?? "")),
      ),
    );

    const runtime = await app.query("select app.runtime_settings() as value");
    const runtimeValue = runtime.rows[0]?.value ?? {};
    check("runtime_settings 返回对象", typeof runtimeValue === "object" && runtimeValue !== null);
    check("runtime_settings 不包含非加密字段", !("ai_api_key" in runtimeValue));
  });

  const l1 = await loadActor("L1");
  const l3 = await loadActor("L3");
  if (!l1 || !l3) {
    throw new Error("需要至少一位 L1 与一位 L3 在岗成员");
  }

  await runAs(l1, async (client) => {
    const { rows } = await client.query("select site_name, brand_primary from app_settings where id = 1");
    check("L1 可读设置行", rows.length === 1);
    check("L1 读到合法主色", /^#[0-9a-f]{6}$/i.test(rows[0]?.brand_primary ?? ""));

    const updated = await client.query(
      "update app_settings set site_name = site_name where id = 1",
    );
    check("L1 可更新设置行", updated.rowCount === 1);

    const aiUpdate = await client.query(
      `update app_settings
          set ai_enabled = $1, ai_base_url = $2, ai_model_pro = $3, ai_model_flash = $4,
              ai_api_key_enc = $5, ai_api_key_hint = $6, updated_by_user_id = $7
        where id = 1`,
      [null, "https://example.test/v1", "model-pro", "model-flash", encrypted, secretHint(plain), l1.userId],
    );
    check("L1 可写入模型字段与密文", aiUpdate.rowCount === 1);

    const stored = await client.query("select ai_api_key_enc from app_settings where id = 1");
    check("库内只保存密文", decryptSecret(stored.rows[0]?.ai_api_key_enc ?? "") === plain);

    const retention = await client.query(
      "update app_settings set audit_retention_days = $1 where id = 1",
      [365],
    );
    check("L1 可写入审计留存", retention.rowCount === 1);

    const audit = await client.query(
      `insert into audit_events (tenant_id, actor_user_id, department_id, action, target_type, target_id, payload)
       values ($1, $2, $3, 'settings.test', 'app_settings', null, '{}'::jsonb)`,
      [TENANT, l1.userId, l1.departmentId],
    );
    check("审计可写入 target_id=null", audit.rowCount === 1);

    const opsInsert = await client.query(
      `insert into ops_tasks (tenant_id, kind, params, requested_by_user_id)
       values ($1, 'backup', '{"cold":false}'::jsonb, $2)
       returning id`,
      [TENANT, l1.userId],
    );
    check("L1 可发起运维任务", opsInsert.rowCount === 1);

    const opsRead = await client.query("select id, status from ops_tasks where id = $1", [
      opsInsert.rows[0]?.id,
    ]);
    check("L1 可读运维任务", opsRead.rows.length === 1 && opsRead.rows[0]?.status === "queued");

    const opsUpdateDenied = await expectDenied(client, "update ops_tasks set status = 'done'");
    check("业务角色不能修改任务状态", opsUpdateDenied);
  });

  await runAs(l3, async (client) => {
    const { rows } = await client.query("select site_name from app_settings where id = 1");
    check("L3 看不到设置行", rows.length === 0);

    const updated = await client.query("update app_settings set site_name = '越权' where id = 1");
    check("L3 更新影响 0 行", updated.rowCount === 0);

    const insertedDenied = await expectDenied(client, "insert into app_settings (id) values (2)");
    check("业务角色不能新增设置行", insertedDenied);

    const opsInsertDenied = await expectDenied(
      client,
      `insert into ops_tasks (tenant_id, kind, params, requested_by_user_id)
       values ($1, 'backup', '{}'::jsonb, $2)`,
      [TENANT, l3.userId],
    );
    check("L3 不能发起运维任务", opsInsertDenied);

    const opsRead = await client.query("select count(*)::int as n from ops_tasks");
    check("L3 看不到运维任务", opsRead.rows[0]?.n === 0);
  });

  console.log(`\n[settings] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[settings] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
