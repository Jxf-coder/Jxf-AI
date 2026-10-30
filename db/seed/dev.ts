/**
 * 开发种子：最小岗位树 + 演示账号。
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

async function ensureRole(
  client: Client,
  parentId: string | null,
  kind: "root" | "child" | "seat",
  slug: string,
  name: string,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `select id from roles
      where tenant_id = $1 and slug = $2 and parent_id is not distinct from $3`,
    [TENANT_ID, slug, parentId],
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  const inserted = await client.query<{ id: string }>(
    `insert into roles (tenant_id, parent_id, kind, slug, name)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [TENANT_ID, parentId, kind, slug, name],
  );
  return inserted.rows[0].id;
}

async function ensureMembership(
  client: Client,
  userId: string,
  roleId: string,
  accessLevel: "L1" | "L2" | "L3",
): Promise<void> {
  const existing = await client.query(
    `select 1 from memberships
      where tenant_id = $1 and user_id = $2 and role_id = $3 and status = 'active'`,
    [TENANT_ID, userId, roleId],
  );
  if (existing.rows.length > 0) {
    return;
  }

  await client.query(
    `insert into memberships (tenant_id, user_id, role_id, access_level)
     values ($1, $2, $3, $4)`,
    [TENANT_ID, userId, roleId, accessLevel],
  );
}

async function main(): Promise<void> {
  const passwordHash = await hashPassword(PASSWORD);
  const client = new Client({ connectionString, application_name: "jxf-seed" });
  await client.connect();

  try {
    await client.query("begin");

    const adminId = await ensureUser(client, "admin@jxf.local", "系统管理员", passwordHash);
    const leadId = await ensureUser(client, "lead@jxf.local", "交付组长", passwordHash);
    const seatAId = await ensureUser(client, "seat-a@jxf.local", "席位 A", passwordHash);
    const seatBId = await ensureUser(client, "seat-b@jxf.local", "席位 B", passwordHash);

    const rootId = await ensureRole(client, null, "root", "hq", "总部");
    const delivery1Id = await ensureRole(client, rootId, "child", "delivery-1", "交付一组");
    const delivery2Id = await ensureRole(client, rootId, "child", "delivery-2", "交付二组");
    const alphaId = await ensureRole(client, delivery1Id, "seat", "alpha", "席位 Alpha");
    const betaId = await ensureRole(client, delivery1Id, "seat", "beta", "席位 Beta");
    await ensureRole(client, delivery2Id, "seat", "gamma", "席位 Gamma");

    await ensureMembership(client, adminId, rootId, "L1");
    await ensureMembership(client, leadId, delivery1Id, "L2");
    await ensureMembership(client, seatAId, alphaId, "L3");
    await ensureMembership(client, seatBId, betaId, "L3");

    await client.query("commit");

    console.log(
      JSON.stringify({
        level: "info",
        msg: "seed_completed",
        tenant_id: TENANT_ID,
        accounts: ["admin@jxf.local", "lead@jxf.local", "seat-a@jxf.local", "seat-b@jxf.local"],
        roles: ["hq", "delivery-1", "delivery-2", "alpha", "beta", "gamma"],
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
