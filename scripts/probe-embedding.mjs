/**
 * Embedding 连通探针（只读）：验证向量通道可用，且维度与 doc_chunks.embedding 对齐。
 *
 * 运行：npm run probe:embedding
 * 不写库、不产生业务数据；缺少 Key 时退出码 2，调用失败退出码 1。
 *
 * 兼容性：部分 OpenAI 兼容网关不接收 `dimensions`（如早期 Gemini 兼容层），
 * 探针会自动降级重试一次，并如实报告实际维度是否满足 JXF_EMBEDDING_DIM。
 */
const BASE_URL = (process.env.JXF_EMBEDDING_BASE_URL ?? "").trim();
const API_KEY = (process.env.JXF_EMBEDDING_API_KEY ?? "").trim();
const MODEL = (process.env.JXF_EMBEDDING_MODEL ?? "").trim();
const DIM = Number.parseInt(process.env.JXF_EMBEDDING_DIM ?? "1024", 10);
const TIMEOUT_MS = Number.parseInt(
  process.env.JXF_EMBEDDING_TIMEOUT_MS ?? process.env.JXF_AI_TIMEOUT_MS ?? "30000",
  10,
);

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function mask(text, keep = 220) {
  const value = typeof text === "string" ? text : JSON.stringify(text);
  return value.length > keep ? `${value.slice(0, keep)}…` : value;
}

async function requestEmbeddings(input, useDimensions) {
  const body = { model: MODEL, input };
  if (useDimensions) {
    body.dimensions = DIM;
  }

  const startedAt = Date.now();
  const response = await fetch(`${BASE_URL.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  return { ok: response.ok, status: response.status, payload, text, ms: Date.now() - startedAt };
}

function vectorsOf(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .slice()
    .sort((left, right) => (left?.index ?? 0) - (right?.index ?? 0))
    .map((row) => row?.embedding);
}

function dimensionMismatchHint(actual) {
  console.error(`       实际维度 ${actual} ≠ 配置 ${DIM}。两种处理方式：`);
  console.error(`       1) 换一个支持 ${DIM} 维输出的模型（保持 doc_chunks.embedding vector(${DIM}) 不变）`);
  console.error(`       2) 改 JXF_EMBEDDING_DIM=${actual}，并新增迁移把 doc_chunks.embedding 改为 vector(${actual})、重建 hnsw 索引`);
}

function unsupportedDimensions(result) {
  if (result.status !== 400 && result.status !== 422) {
    return false;
  }
  return /dimension|unknown name|unknown field|unsupported/i.test(result.text ?? "");
}

async function main() {
  console.log(`[1/4] 配置检查 endpoint=${BASE_URL || "(空)"} model=${MODEL || "(空)"} dim=${DIM}`);
  if (!BASE_URL || !API_KEY || !MODEL) {
    console.error(
      "[FAIL] 缺少配置：请先在 .env 填写 JXF_EMBEDDING_BASE_URL / JXF_EMBEDDING_API_KEY / JXF_EMBEDDING_MODEL",
    );
    process.exit(2);
  }
  if (!Number.isFinite(DIM) || DIM <= 0) {
    fail(`JXF_EMBEDDING_DIM 非法：${process.env.JXF_EMBEDDING_DIM ?? ""}`);
  }
  console.log("[PASS] 配置项齐全");

  let withDimensions = true;
  console.log(`[2/4] 单条向量 · 请求维度 ${DIM}`);
  let single = await requestEmbeddings(["知识库向量通道连通性探针"], withDimensions);

  if (!single.ok && unsupportedDimensions(single)) {
    console.warn(`[WARN] 网关不接受 dimensions 参数（HTTP ${single.status}），将不带维度重试一次`);
    withDimensions = false;
    single = await requestEmbeddings(["知识库向量通道连通性探针"], withDimensions);
  }

  if (!single.ok) {
    fail(`HTTP ${single.status}：${mask(single.text)}`);
  }

  const singleVectors = vectorsOf(single.payload);
  if (singleVectors.length !== 1 || !Array.isArray(singleVectors[0])) {
    fail(`返回结构异常：${mask(single.text)}`);
  }
  const actualDim = singleVectors[0].length;
  if (actualDim !== DIM) {
    dimensionMismatchHint(actualDim);
    fail(`维度不符：期望 ${DIM}，实际 ${actualDim}`);
  }
  console.log(
    `[PASS] 单条向量 ${actualDim} 维 · ${single.ms}ms · dimensions=${withDimensions ? "已传" : "未传"}`,
  );

  console.log("[3/4] 批量向量 · 2 条");
  const batch = await requestEmbeddings(
    ["食品接触材料的迁移量应当符合国家标准限值要求。", "海外客户的交付验收需要提前预约。"],
    withDimensions,
  );
  if (!batch.ok) {
    fail(`HTTP ${batch.status}：${mask(batch.text)}`);
  }
  const batchVectors = vectorsOf(batch.payload);
  if (batchVectors.length !== 2) {
    fail(`条数不符：期望 2，实际 ${batchVectors.length}`);
  }
  const badVector = batchVectors.find((vector) => !Array.isArray(vector) || vector.length !== DIM);
  if (badVector) {
    dimensionMismatchHint(badVector?.length ?? 0);
    fail("批量向量中存在维度不符或空向量");
  }
  const identical = batchVectors[0].every((value, index) => value === batchVectors[1][index]);
  if (identical) {
    fail("两条不同文本返回了完全相同的向量，疑似网关未真正计算");
  }
  console.log(`[PASS] 批量 2 条 · ${batch.ms}ms`);

  console.log("[4/4] 相似度自检 · 近义句应高于无关句");
  const probe = await requestEmbeddings(
    ["食品接触材料的迁移量限值", "食品接触材料迁移量的国家标准", "今天天气不错适合外出"],
    withDimensions,
  );
  if (!probe.ok) {
    fail(`HTTP ${probe.status}：${mask(probe.text)}`);
  }
  const probeVectors = vectorsOf(probe.payload);
  if (probeVectors.length !== 3 || probeVectors.some((vector) => !Array.isArray(vector))) {
    fail(`返回结构异常：${mask(probe.text)}`);
  }
  const cosine = (left, right) => {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
      dot += left[index] * right[index];
      leftNorm += left[index] * left[index];
      rightNorm += right[index] * right[index];
    }
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1);
  };
  const near = cosine(probeVectors[0], probeVectors[1]);
  const far = cosine(probeVectors[0], probeVectors[2]);
  if (!(near > far)) {
    fail(`近义句相似度 ${near.toFixed(4)} 未高于无关句 ${far.toFixed(4)}`);
  }
  console.log(`[PASS] 近义 ${near.toFixed(4)} > 无关 ${far.toFixed(4)}`);

  console.log(
    `[EMBEDDING] PASS endpoint=${BASE_URL} model=${MODEL} dim=${DIM} dimensions=${withDimensions ? "已传" : "未传"}`,
  );
}

main().catch((error) => {
  fail(`探针异常：${error instanceof Error ? error.message : String(error)}`);
});
