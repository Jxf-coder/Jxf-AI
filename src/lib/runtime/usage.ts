/**
 * M3 用量账本：每次模型调用恰好一行 token_usages，并同步 runs 的冗余累计。
 *
 * 由 worker 调用（app_worker 连接）；与 run_steps 一一对应，便于按步对账。
 */

import type { Pool } from "pg";

import { estimateCostMicros } from "@/lib/runtime/pricing";

export interface UsageInput {
  tenantId: string;
  departmentId: string;
  runId: string;
  stepId: string | null;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
}

export interface UsageRecorded {
  id: string;
  costMicros: number;
}

export async function recordUsage(pool: Pool, input: UsageInput): Promise<UsageRecorded> {
  const costMicros = estimateCostMicros(input.promptTokens, input.completionTokens);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query<{ id: string }>(
      `insert into token_usages
         (tenant_id, department_id, run_id, step_id, provider, model,
          prompt_tokens, completion_tokens, cached_tokens, cost_micros)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [
        input.tenantId,
        input.departmentId,
        input.runId,
        input.stepId,
        input.provider,
        input.model,
        input.promptTokens,
        input.completionTokens,
        input.cachedTokens ?? 0,
        costMicros,
      ],
    );
    await client.query(
      `update runs
          set prompt_tokens = prompt_tokens + $2,
              completion_tokens = completion_tokens + $3,
              cost_micros = cost_micros + $4
        where id = $1`,
      [input.runId, input.promptTokens, input.completionTokens, costMicros],
    );
    await client.query("commit");
    return { id: inserted.rows[0].id, costMicros };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
