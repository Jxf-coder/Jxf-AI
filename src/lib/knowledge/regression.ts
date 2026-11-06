/**
 * 检索回归门禁（M2-E）。
 *
 * 目的：换分块策略 / 换 embedding 模型 / 改检索参数后，用基线题集验证召回没有退化。
 * 判定：每题保留率 = |基线卡 ∩ 召回卡| / |基线卡|；retained < 0.9 或任一道未通过，整轮判失败。
 *
 * 基线题来源：用已确认卡片的标题自动出题（自洽门禁），确保改动后仍能召回原卡。
 */

import type { UserContext } from "@/lib/db/user-context";
import { withUserContext } from "@/lib/db/user-context";
import { embedTexts } from "@/lib/ai/openai";
import { auditInTx } from "@/lib/audit";
import { loadEnv } from "@/lib/env";
import { requireContextPermission } from "@/lib/permissions/server";

export const RETAINED_THRESHOLD = 0.9;
const MAX_QUESTIONS = 50;

export interface RegressionItemResult {
  question: string;
  retained: number;
  pass: boolean;
  hitCount: number;
  missing: number;
  hitIds: string[];
}

export interface RegressionSummary {
  runId: string;
  buildTag: string;
  total: number;
  passed: number;
  retained: number;
  items: RegressionItemResult[];
}

export interface RegressionRunView {
  id: string;
  buildTag: string;
  total: number;
  passed: number;
  retained: number;
  createdAt: Date;
}

/** 用已确认卡片标题生成基线题（已存在同题则跳过） */
export async function seedRegressionQuestions(context: UserContext, limit = 20): Promise<number> {
  const departmentId = context.activeDepartmentId;
  if (!departmentId) {
    throw new Error("当前账号没有有效部门上下文");
  }

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    const { rows } = await client.query<{ id: string; title: string }>(
      `select id, title from knowledge_cards
        where department_id = $1 and status = 'confirmed'
        order by created_at desc
        limit $2`,
      [departmentId, limit],
    );

    let created = 0;
    for (const card of rows) {
      const existing = await client.query(
        "select 1 from regression_questions where department_id = $1 and q = $2 limit 1",
        [departmentId, card.title],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        continue;
      }
      await client.query(
        `insert into regression_questions (tenant_id, department_id, q, source, baseline_ids)
         values ($1, $2, $3, 'manual', $4::uuid[])`,
        [context.tenantId, departmentId, card.title, [card.id]],
      );
      created += 1;
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.regression_seeded",
      targetType: "department",
      targetId: departmentId,
      departmentId,
      payload: { created, scanned: rows.length },
    });

    return created;
  });
}

export async function runRegression(context: UserContext, buildTag: string): Promise<RegressionSummary> {
  const departmentId = context.activeDepartmentId;
  if (!departmentId) {
    throw new Error("当前账号没有有效部门上下文");
  }

  const env = loadEnv();
  const questions = await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    const { rows } = await client.query<{ id: string; q: string; baseline_ids: string[] }>(
      `select id, q, baseline_ids from regression_questions
        where department_id = $1
        order by created_at
        limit $2`,
      [departmentId, MAX_QUESTIONS],
    );
    return rows;
  });

  if (questions.length === 0) {
    throw new Error("还没有基线题，请先生成");
  }

  const items: RegressionItemResult[] = [];
  for (const question of questions) {
    const [embedding] = (await embedTexts([question.q])) ?? [];
    const hits = await withUserContext(context, async (client) => {
      const { rows } = await client.query<{ card_id: string }>(
        "select card_id from app.hybrid_search_cards($1, $2::vector, $3, 60)",
        [question.q, embedding ? `[${embedding.join(",")}]` : null, Math.max(env.ai.topK, 10)],
      );
      return rows.map((row) => row.card_id);
    });

    const baseline = question.baseline_ids ?? [];
    const hitSet = new Set(hits);
    const matched = baseline.filter((id) => hitSet.has(id)).length;
    const retained = baseline.length === 0 ? 0 : Number((matched / baseline.length).toFixed(4));

    items.push({
      question: question.q,
      retained,
      pass: retained >= RETAINED_THRESHOLD,
      hitCount: hits.length,
      missing: baseline.length - matched,
      hitIds: hits,
    });
  }

  const total = items.length;
  const passed = items.filter((item) => item.pass).length;
  const retained = Number((items.reduce((sum, item) => sum + item.retained, 0) / total).toFixed(4));

  const runId = await withUserContext(context, async (client) => {
    const run = await client.query<{ id: string }>(
      `insert into regression_runs (tenant_id, department_id, build_tag, total, passed, retained)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [context.tenantId, departmentId, buildTag, total, passed, retained],
    );
    const createdRunId = run.rows[0].id;

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      await client.query(
        `insert into regression_items (run_id, question_id, hit_ids, retained, pass)
         values ($1, $2, $3::uuid[], $4, $5)`,
        [createdRunId, questions[index].id, item.hitIds, item.retained, item.pass],
      );
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.regression_run",
      targetType: "regression_run",
      targetId: createdRunId,
      departmentId,
      payload: { total, passed, retained, build_tag: buildTag },
    });

    return createdRunId;
  });

  return { runId, buildTag, total, passed, retained, items };
}

export async function listRegressionRuns(context: UserContext, limit = 5): Promise<RegressionRunView[]> {
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      build_tag: string;
      total: number;
      passed: number;
      retained: string;
      created_at: Date;
    }>(
      `select id, build_tag, total, passed, retained, created_at
         from regression_runs
        order by created_at desc
        limit $1`,
      [limit],
    );

    return rows.map((row) => ({
      id: row.id,
      buildTag: row.build_tag,
      total: row.total,
      passed: row.passed,
      retained: Number(row.retained),
      createdAt: row.created_at,
    }));
  });
}

export interface RegressionQuestionView {
  id: string;
  q: string;
  source: string;
  baselineCount: number;
  createdAt: Date;
}

export async function listRegressionQuestions(
  context: UserContext,
  limit = 50,
): Promise<RegressionQuestionView[]> {
  return withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      id: string;
      q: string;
      source: string;
      baseline_count: number;
      created_at: Date;
    }>(
      `select id, q, source, cardinality(baseline_ids) as baseline_count, created_at
         from regression_questions
        order by created_at desc
        limit $1`,
      [limit],
    );

    return rows.map((row) => ({
      id: row.id,
      q: row.q,
      source: row.source,
      baselineCount: row.baseline_count,
      createdAt: row.created_at,
    }));
  });
}

/** 手工加一道回归题：基线取当前检索命中的前 3 张卡 */
export async function addRegressionQuestion(context: UserContext, rawQuestion: string): Promise<string> {
  const question = rawQuestion.trim();
  if (question.length < 2) {
    throw new Error("题目太短（至少 2 个字）");
  }
  if (question.length > 200) {
    throw new Error("题目太长（≤ 200 字）");
  }

  const departmentId = context.activeDepartmentId;
  if (!departmentId) {
    throw new Error("当前账号没有有效部门上下文");
  }

  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    const existing = await client.query(
      "select 1 from regression_questions where department_id = $1 and q = $2 limit 1",
      [departmentId, question],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      throw new Error("这道题已经在题集里");
    }

    const hits = await client.query<{ card_id: string }>(
      "select card_id from app.hybrid_search_cards($1, null, 5, 60)",
      [question],
    );
    const baseline = hits.rows.slice(0, 3).map((row) => row.card_id);
    if (baseline.length === 0) {
      throw new Error("这道题现在一条知识卡都召不回，先补卡片再出题");
    }

    const created = await client.query<{ id: string }>(
      `insert into regression_questions (tenant_id, department_id, q, source, baseline_ids)
       values ($1, $2, $3, 'manual', $4::uuid[])
       returning id`,
      [context.tenantId, departmentId, question, baseline],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.regression_question_added",
      targetType: "regression_question",
      targetId: created.rows[0].id,
      departmentId,
      payload: { baseline: baseline.length },
    });

    return created.rows[0].id;
  });
}

export async function removeRegressionQuestion(context: UserContext, questionId: string): Promise<void> {
  const departmentId = context.activeDepartmentId;
  if (!departmentId) {
    throw new Error("当前账号没有有效部门上下文");
  }

  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "knowledge:write", {
      kind: "department",
      id: departmentId,
      departmentId,
    });

    const deleted = await client.query(
      "delete from regression_questions where id = $1 and department_id = $2 returning id",
      [questionId, departmentId],
    );
    if (!deleted.rowCount) {
      throw new Error("题目不存在或不属于当前部门");
    }

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "knowledge.regression_question_removed",
      targetType: "regression_question",
      targetId: questionId,
      departmentId,
    });
  });
}

export interface RegressionItemView {
  question: string;
  retained: number;
  pass: boolean;
  hitCount: number;
}

/** 最近一次运行的逐题结果 */
export async function listLastRunItems(
  context: UserContext,
): Promise<{ run: RegressionRunView; items: RegressionItemView[] } | null> {
  const runs = await listRegressionRuns(context, 1);
  const run = runs[0];
  if (!run) {
    return null;
  }

  const items = await withUserContext(context, async (client) => {
    const { rows } = await client.query<{
      q: string;
      retained: string;
      pass: boolean;
      hit_count: number;
    }>(
      `select q.q, i.retained, i.pass, cardinality(i.hit_ids) as hit_count
         from regression_items i
         join regression_questions q on q.id = i.question_id
        where i.run_id = $1
        order by q.created_at`,
      [run.id],
    );

    return rows.map((row) => ({
      question: row.q,
      retained: Number(row.retained),
      pass: row.pass,
      hitCount: row.hit_count,
    }));
  });

  return { run, items };
}
