/**
 * 开发种子：冷启动组织架构（仅老板根节点）+ 演示账号。
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

const ROOT_EMAIL = "admin@jxf.local";
const ROOT_PHONE = "13800000001";
const ROOT_NAME = "张三";
const ROOT_TITLE = "创始人";

if (!TENANT_ID || !DB || !OWNER_USER || !OWNER_PASSWORD || !PASSWORD) {
  throw new Error(
    "缺少种子环境变量：JXF_TENANT_ID / POSTGRES_DB / JXF_OWNER_USER / JXF_OWNER_PASSWORD / SEED_PASSWORD",
  );
}

if (PASSWORD.length < 12) {
  throw new Error("SEED_PASSWORD 至少 12 位（仅开发环境使用）");
}

const connectionString = `postgresql://${OWNER_USER}:${OWNER_PASSWORD}@${HOST}:${PORT}/${DB}`;

async function ensureRootUser(client: Client, passwordHash: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into users (email, phone, name, password_hash)
     values ($1, $2, $3, $4)
     on conflict (email) do update
       set phone = excluded.phone,
           name = excluded.name,
           password_hash = excluded.password_hash
     returning id`,
    [ROOT_EMAIL, ROOT_PHONE, ROOT_NAME, passwordHash],
  );
  return rows[0].id;
}

async function ensureRootEmailIdentity(client: Client, userId: string): Promise<void> {
  await client.query(
    `insert into user_email_identities (tenant_id, user_id, email)
     values ($1, $2, $3)
     on conflict (tenant_id, email) do nothing`,
    [TENANT_ID, userId, ROOT_EMAIL],
  );
}

/** 根节点固定为「老板」：系统控制权入口，不建任何 Mock 部门 */
async function ensureRootDepartment(client: Client): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `select id from departments
      where tenant_id = $1 and parent_id is null
      order by created_at
      limit 1`,
    [TENANT_ID],
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  const inserted = await client.query<{ id: string }>(
    `insert into departments (tenant_id, parent_id, slug, name)
     values ($1, null, $2, $3)
     returning id`,
    [TENANT_ID, "laoban", "老板"],
  );
  return inserted.rows[0].id;
}

/** 默认业务部门：销售部（挂在老板下） */
async function ensureSalesDepartment(client: Client, parentId: string): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `select id from departments
      where tenant_id = $1 and parent_id = $2 and name = $3
      limit 1`,
    [TENANT_ID, parentId, "销售部"],
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  const inserted = await client.query<{ id: string }>(
    `insert into departments (tenant_id, parent_id, slug, name)
     values ($1, $2, $3, $4)
     returning id`,
    [TENANT_ID, parentId, "xiao-shou-bu", "销售部"],
  );
  return inserted.rows[0].id;
}

async function ensureOwnership(
  client: Client,
  userId: string,
  departmentId: string,
): Promise<void> {
  const existing = await client.query(
    `select 1 from memberships
      where tenant_id = $1 and user_id = $2 and department_id = $3 and status = 'active'`,
    [TENANT_ID, userId, departmentId],
  );
  if (existing.rows.length > 0) {
    await client.query(
      `update memberships set title = $1, access_level = 'L1'
        where tenant_id = $2 and user_id = $3 and department_id = $4 and status = 'active'`,
      [ROOT_TITLE, TENANT_ID, userId, departmentId],
    );
    return;
  }

  await client.query(
    `insert into memberships (tenant_id, user_id, department_id, title, access_level)
     values ($1, $2, $3, $4, 'L1')`,
    [TENANT_ID, userId, departmentId, ROOT_TITLE],
  );
}

async function main(): Promise<void> {
  const passwordHash = await hashPassword(PASSWORD);
  const client = new Client({ connectionString, application_name: "jxf-seed" });
  await client.connect();

  try {
    await client.query("begin");

    const rootUserId = await ensureRootUser(client, passwordHash);
    await ensureRootEmailIdentity(client, rootUserId);
    const rootDepartmentId = await ensureRootDepartment(client);
    await ensureSalesDepartment(client, rootDepartmentId);
    await ensureOwnership(client, rootUserId, rootDepartmentId);

    await client.query("commit");

    console.log(
      JSON.stringify({
        level: "info",
        msg: "seed_completed",
        tenant_id: TENANT_ID,
        accounts: [ROOT_EMAIL],
        root_department: "老板",
        default_departments: ["销售部"],
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
