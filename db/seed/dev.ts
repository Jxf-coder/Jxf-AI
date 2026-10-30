/**
 * 开发种子：最小部门树 + 演示账号。
 * 仅用于本地 / 演示环境，禁止在生产执行。
 *
 * 运行：npm run seed
 */
import { Client } from "pg";

import { hashPassword } from "../../src/lib/auth/password";

const TENANT_ID = process.env.JXF_TENANT_ID ?? "";
const HOST = process.env.SEED_DB_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SEED_DB_PORT ?? process.env.POSTGRES_PORT ?? 5432);
const DB = process.env.POSTGRES_DB ?? "";
const OWNER_USER = process.env.JXF_OWNER_USER ?? "";
const OWNER_PASSWORD = process.env.JXF_OWNER_PASSWORD ?? "";
const PASSWORD = process.env.SEED_PASSWORD ?? "";

if (!TENANT_ID || !DB || !OWNER_USER || !OWNER_PASSWORD || !PASSWORD) {
  throw new Error(
    "缺少种子环境变量：JXF_TENANT_ID / POSTGRES_DB / JXF_OWNER_USER / JXF_OWNER_PASSWORD / SEED_PASSWORD",
  );
}

if (PASSWORD.length < 12) {
  throw new Error("SEED_PASSWORD 至少 12 位（仅开发环境使用）");
}

const connectionString = `postgresql://${OWNER_USER}:${OWNER_PASSWORD}@${HOST}:${PORT}/${DB}`;

async function ensureUser(
  client: Client,
  email: string,
  name: string,
  passwordHash: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into users (email, name, password_hash)
     values ($1, $2, $3)
     on conflict (email) do update
       set name = excluded.name,
           password_hash = excluded.password_hash
     returning id`,
    [email, name, passwordHash],
  );
  return rows[0].id;
}

async function ensureDepartment(
  client: Client,
  parentId: string | null,
  slug: string,
  name: string,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `select id from departments
      where tenant_id = $1 and slug = $2 and parent_id is not distinct from $3`,
    [TENANT_ID, slug, parentId],
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  const inserted = await client.query<{ id: string }>(
    `insert into departments (tenant_id, parent_id, slug, name)
     values ($1, $2, $3, $4)
     returning id`,
    [TENANT_ID, parentId, slug, name],
  );
  return inserted.rows[0].id;
}

async function ensureMembership(
  client: Client,
  userId: string,
  departmentId: string,
  accessLevel: "L1" | "L2" | "L3",
  title: string,
): Promise<void> {
  const existing = await client.query(
    `select 1 from memberships
      where tenant_id = $1 and user_id = $2 and department_id = $3 and status = 'active'`,
    [TENANT_ID, userId, departmentId],
  );
  if (existing.rows.length > 0) {
    await client.query(
      `update memberships set title = $1, access_level = $2
        where tenant_id = $3 and user_id = $4 and department_id = $5 and status = 'active'`,
      [title, accessLevel, TENANT_ID, userId, departmentId],
    );
    return;
  }

  await client.query(
    `insert into memberships (tenant_id, user_id, department_id, title, access_level)
     values ($1, $2, $3, $4, $5)`,
    [TENANT_ID, userId, departmentId, title, accessLevel],
  );
}

async function main(): Promise<void> {
  const passwordHash = await hashPassword(PASSWORD);
  const client = new Client({ connectionString, application_name: "jxf-seed" });
  await client.connect();

  try {
    await client.query("begin");

    const zhangId = await ensureUser(client, "admin@jxf.local", "张三", passwordHash);
    const liId = await ensureUser(client, "lead@jxf.local", "李四", passwordHash);
    const wangId = await ensureUser(client, "seat-a@jxf.local", "王五", passwordHash);
    const zhaoId = await ensureUser(client, "seat-b@jxf.local", "赵六", passwordHash);

    const hqId = await ensureDepartment(client, null, "hq", "总部");
    const delivery1Id = await ensureDepartment(client, hqId, "delivery-1", "交付一组");
    const delivery2Id = await ensureDepartment(client, hqId, "delivery-2", "交付二组");
    await ensureDepartment(client, delivery1Id, "east-team", "华东小组");

    await ensureMembership(client, zhangId, hqId, "L1", "创始人");
    await ensureMembership(client, liId, delivery1Id, "L2", "交付经理");
    await ensureMembership(client, wangId, delivery1Id, "L3", "交付顾问");
    await ensureMembership(client, zhaoId, delivery2Id, "L3", "解决方案工程师");

    await client.query("commit");

    console.log(
      JSON.stringify({
        level: "info",
        msg: "seed_completed",
        tenant_id: TENANT_ID,
        accounts: ["admin@jxf.local", "lead@jxf.local", "seat-a@jxf.local", "seat-b@jxf.local"],
        departments: ["hq", "delivery-1", "delivery-2", "east-team"],
      }),
    );
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "error", msg: "seed_failed", error: String(error) }));
  process.exit(1);
});
