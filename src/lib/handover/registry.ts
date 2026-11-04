import type { PoolClient } from "pg";

import { type AssetAdapter, type HandoverAsset, agentAdapter, knowledgeAdapter } from "./adapters";

export type { AssetAdapter, HandoverAsset } from "./adapters";

/**
 * 交接适配器注册表。
 *
 * 新增资产类型时只需实现 AssetAdapter 并加入 HANDOVER_ADAPTERS，
 * 移出流程与审批状态机无需改动。
 */
export const HANDOVER_ADAPTERS: readonly AssetAdapter[] = [agentAdapter, knowledgeAdapter];

export function getAdapter(assetType: string): AssetAdapter | null {
  return HANDOVER_ADAPTERS.find((adapter) => adapter.assetType === assetType) ?? null;
}

/** 汇总该成员名下全部待交接资产 */
export async function listHandoverAssets(
  client: PoolClient,
  userId: string,
): Promise<HandoverAsset[]> {
  const assets: HandoverAsset[] = [];
  for (const adapter of HANDOVER_ADAPTERS) {
    assets.push(...(await adapter.listBlocking(client, userId)));
  }
  return assets;
}

/** 按资产类型分组，供交接向导渲染 */
export function groupHandoverAssets(
  assets: HandoverAsset[],
): Array<{ assetType: string; label: string; items: HandoverAsset[] }> {
  return HANDOVER_ADAPTERS.map((adapter) => ({
    assetType: adapter.assetType,
    label: adapter.label,
    items: assets.filter((asset) => asset.assetType === adapter.assetType),
  })).filter((group) => group.items.length > 0);
}
