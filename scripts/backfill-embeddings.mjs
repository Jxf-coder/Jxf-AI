/**
 * 向量回填：给 embedding 为空的切片补向量（历史导入件 / 后开的向量通道）。
 *
 * 运行：npm run backfill:embeddings [-- --limit=500 --batch=16 --dry-run]
 * - 只处理未删除、未撤回文档的切片；已有点向量保持不变（幂等，可重复执行）
 * - 每批独立事务：单批失败不影响已完成部分，重跑会从剩余项继续
 * - 需要 JXF_EMBEDDING_* 配置；不打印 Key
 */
import { Client } from "pg";

const argv = process.argv.slice(2);
const flag = (name) => argv.find((item) => item === `--${name}` || item.startsWith(`--${name}=`));
const valueOf = (name, fallback) => {
  const hit = flag(name);
  if (!hit || !hit.includes("=")) {
    return fallback;
  }
  const parsed = Number.parseInt(hit.split("=")[1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const LIMIT = valueOf("limit", 500);
const BATCH = Math.min(valueOf("batch", 16), 64);
const DRY_RUN = Boolean(flag("dry-run"));
const BASE_URL = (process.env.JXF_EMBEDDING_BASE_URL ?? "").trim().replace(/\/+$/, "");
const API_KEY = (process.env.JXF_EMBEDDING_API_KEY ?? "").trim();
const MODEL = (process.env.JXF_EMBEDDING_MODEL ?? "").trim();
const DIM = Number.parseInt(process.env.JXF_EMBEDDING_DIM ?? "1024", 10);
const TIMEOUT_MS = Number.parseInt(process.env.JXF_EMBEDDING_TIMEOUT_MS ?? "60000", 10);
const PAUSE_MS = 350;
const RETRIES = 3;

if (!BASE_URL || !API_KEY || !MODEL) {
  console.error(
    "[FAIL] 缺少配置：JXF_EMBEDDING_BASE_URL / JXF_EMBEDDING_API_KEY / JXF_EMBEDDING_MODEL",
  );
  process.exit(2);
}
if (!Number.isFinite(DIM) || DIM <= 0) {
  console.error(`[FAIL] JXF_EMBEDDING_DIM 非法：${process.env.JXF_EMBEDDING_DIM ?? ""}`);
  process.exit(2);
}

const host = process.env.SEED_DB_HOST ?? "127.0.0.1";
const port = process.env.SEED_DB_PORT ?? process.env.POSTGRES_PORT ?? "5432";
const url = `postgresql://${process.env.JXF_OWNER_USER}:${process.env.JXF_OWNER_PASSWORD}@${host}:${port}/${process.env.POSTGRES_DB}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function embedBatch(texts) {
  let lastError = null;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: MODEL, input: texts, dimensions: DIM }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${detail.slice(0, 300)}`);
      }
      const payload = await response.json();
      const vectors = (payload.data ?? [])
        .slice()
        .sort((left, right) => (left?.index ?? 0) - (right?.index ?? 0))
        .map((row) => row?.embedding);
      if (vectors.length !== texts.length) {
        throw new Error(`条数不符：期望 ${texts.length}，实际 ${vectors.length}`);
      }
      const bad = vectors.find((vector) => !Array.isArray(vector) || vector.length !== DIM);
      if (bad) {
        throw new Error(`维度不符：期望 ${DIM}，实际 ${bad?.length ?? 0}`);
      }
      return vectors;
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) {
        await sleep(600 * attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function coverage(client) {
  const { rows } = await client.query(
    `select count(*)::int as total, count(c.embedding)::int as embedded
       from doc_chunks c
       join documents d on d.id = c.document_id
      where d.deleted_at is null and d.status <> 'revoked'`,
  );
  return rows[0];
}

const client = new Client({ connectionString: url, application_name: "jxf-backfill-embeddings" });
await client.connect();

try {
  const before = await coverage(client);
  const { rows: pending } = await client.query(
    `select c.id, c.text
       from doc_chunks c
       join documents d on d.id = c.document_id
      where c.embedding is null and d.deleted_at is null and d.status <> 'revoked'
      order by c.created_at, c.id
      limit $1`,
    [LIMIT],
  );

  console.log(
    `[开始] 待回填 ${pending.length} 条 · 当前覆盖 ${before.embedded}/${before.total} · model=${MODEL} dim=${DIM}${DRY_RUN ? " · dry-run" : ""}`,
  );

  if (DRY_RUN || pending.length === 0) {
    console.log("[结束] 未写入任何数据");
    process.exit(0);
  }

  let done = 0;
  let failed = 0;
  for (let offset = 0; offset < pending.length; offset += BATCH) {
    const batch = pending.slice(offset, offset + BATCH);
    try {
      const vectors = await embedBatch(batch.map((row) => row.text));
      await client.query("begin");
      for (let index = 0; index < batch.length; index += 1) {
        await client.query("update doc_chunks set embedding = $1::vector where id = $2", [
          `[${vectors[index].join(",")}]`,
          batch[index].id,
        ]);
      }
      await client.query("commit");
      done += batch.length;
      console.log(`[进度] ${done}/${pending.length}`);
    } catch (error) {
      failed += batch.length;
      await client.query("rollback").catch(() => {});
      console.error(
        `[跳过] 批次 ${offset}-${offset + batch.length} 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await sleep(PAUSE_MS);
  }

  const after = await coverage(client);
  const percent = after.total === 0 ? 100 : Math.round((after.embedded / after.total) * 1000) / 10;
  console.log(
    `[完成] 本次成功 ${done} · 失败 ${failed} · 覆盖率 ${after.embedded}/${after.total}（${percent}%）`,
  );
  process.exit(failed === 0 ? 0 : 1);
} finally {
  await client.end().catch(() => {});
}
