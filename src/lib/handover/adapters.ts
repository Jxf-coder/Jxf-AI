import type { PoolClient } from "pg";

/**
 * 资产交接适配器。
 *
 * M2（知识库）/ M3（运行时）尚未建表，适配器先按「表/列存在才生效」实现：
 * 表不存在时返回空列表，移出流程不受影响；建表后无需改审批状态机。
 */
export interface HandoverAsset {
  assetType: string;
  assetId: string;
  label: string;
}

export interface AssetAdapter {
  assetType: string;
  label: string;
  /** 返回该成员名下需要交接的资产；表未建时返回空数组 */
  listBlocking(client: PoolClient, userId: string): Promise<HandoverAsset[]>;
  /** 审批通过时把单条资产转移给接收人 */
  transfer(
    client: PoolClient,
    assetId: string,
    fromUserId: string,
    toUserId: string,
  ): Promise<void>;
}

async function hasTable(client: PoolClient, table: string): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    "select to_regclass($1) is not null as present",
    [`public.${table}`],
  );
  return Boolean(rows[0]?.present);
}

async function hasColumn(client: PoolClient, table: string, column: string): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `select exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = $1 and column_name = $2
     ) as present`,
    [table, column],
  );
  return Boolean(rows[0]?.present);
}

/** 知识资产（M2 assets 表） */
export const knowledgeAdapter: AssetAdapter = {
  assetType: "knowledge",
  label: "知识资产",
  async listBlocking(client, userId) {
    if (!(await hasTable(client, "assets")) || !(await hasColumn(client, "assets", "created_by"))) {
      return [];
    }
    const { rows } = await client.query<{ id: string; title: string | null }>(
      "select id::text as id, title from assets where created_by = $1 order by id",
      [userId],
    );
    return rows.map((row) => ({
      assetType: knowledgeAdapter.assetType,
      assetId: row.id,
      label: row.title?.trim() || `知识资产 ${row.id.slice(0, 8)}`,
    }));
  },
  async transfer(client, assetId, fromUserId, toUserId) {
    if (!(await hasTable(client, "assets"))) {
      return;
    }
    await client.query(
      "update assets set created_by = $2 where id = $1::uuid and created_by = $3",
      [assetId, toUserId, fromUserId],
    );
  },
};

/** 智能体资产（M2 ai_employees 表） */
export const agentAdapter: AssetAdapter = {
  assetType: "agent",
  label: "智能体",
  async listBlocking(client, userId) {
    if (!(await hasTable(client, "ai_employees")) || !(await hasColumn(client, "ai_employees", "created_by"))) {
      return [];
    }
    const { rows } = await client.query<{ id: string; name: string | null }>(
      "select id::text as id, name from ai_employees where created_by = $1 order by id",
      [userId],
    );
    return rows.map((row) => ({
      assetType: agentAdapter.assetType,
      assetId: row.id,
      label: row.name?.trim() || `智能体 ${row.id.slice(0, 8)}`,
    }));
  },
  async transfer(client, assetId, fromUserId, toUserId) {
    if (!(await hasTable(client, "ai_employees"))) {
      return;
    }
    await client.query(
      "update ai_employees set created_by = $2 where id = $1::uuid and created_by = $3",
      [assetId, toUserId, fromUserId],
    );
  },
};
