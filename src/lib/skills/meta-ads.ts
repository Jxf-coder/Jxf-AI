/**
 * Meta 投放（Meta Ads Operator）。
 *
 * 真实业务边界：
 * - 连接信息落库，token 只存 AES-256-GCM 密文与末 4 位提示；
 * - 同步拉取广告帐户的 campaign / ad / insights，快照写入 skill_runs；
 * - 规则只生成草稿，人确认后才写 Meta；失败如实记录，不伪造成功；
 * - 恢复动作生成反向草稿，不直接改历史记录。
 */

import { decryptSecret, encryptSecret, secretHint } from "@/lib/settings/crypto";
import { auditInTx } from "@/lib/audit";
import { withUserContext, type UserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";

import { SkillInputError } from "@/lib/skills";

const GRAPH_FALLBACK = "https://graph.facebook.com/v21.0";
const FETCH_TIMEOUT_MS = 20_000;

export interface MetaSettings {
  targetCostPerResult: number;
  currency: string;
  resultLabel: string;
  maxRaisePct: number;
}

export const DEFAULT_META_SETTINGS: MetaSettings = {
  targetCostPerResult: 80,
  currency: "USD",
  resultLabel: "成果",
  maxRaisePct: 20,
};

export interface MetaConnectionView {
  connected: boolean;
  accountId: string | null;
  accountName: string | null;
  currency: string | null;
  timezone: string | null;
  tokenHint: string | null;
  relayUrl: string | null;
  relayTokenSet: boolean;
  settings: MetaSettings;
}

export interface MetaAdStat {
  id: string;
  name: string;
  campaignId: string;
  campaignName: string;
  status: string;
  dailyBudget: number | null;
  createdTime: string | null;
  spend: number;
  results: number;
  impressions: number;
  clicks: number;
}

export interface MetaDraftPlan {
  kind: "pause_ad" | "resume_ad" | "set_budget";
  targetId: string;
  targetName: string;
  campaignName: string;
  title: string;
  reason: string;
  payload: Record<string, unknown>;
}

export interface MetaDraftView {
  id: string;
  kind: string;
  targetId: string;
  targetName: string;
  campaignName: string | null;
  title: string;
  reason: string;
  payload: Record<string, unknown>;
  source: string;
  status: string;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
}

interface MetaConnectionRow {
  id: string;
  account_id: string;
  account_name: string | null;
  currency: string | null;
  timezone: string | null;
  token_enc: string;
  token_hint: string | null;
  relay_url: string | null;
  relay_token_enc: string | null;
  settings: MetaSettings | null;
}

function resolveSettings(value: MetaSettings | null | undefined): MetaSettings {
  return { ...DEFAULT_META_SETTINGS, ...(value ?? {}) };
}

function graphBase(relayUrl: string | null): string {
  return (relayUrl?.trim() || GRAPH_FALLBACK).replace(/\/$/, "");
}

async function graphRequest(
  base: string,
  path: string,
  token: string,
  relayToken: string | null,
  init?: { method?: "GET" | "POST"; body?: Record<string, string> },
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (relayToken) headers["x-fde-relay-token"] = relayToken;
    let body: string | undefined;
    if (init?.method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.body ?? {}).toString();
    }
    const response = await fetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers,
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    if (!response.ok) {
      const error = parsed.error as { message?: string } | undefined;
      throw new Error(error?.message || `Graph HTTP ${response.status}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function loadConnectionRow(
  context: UserContext,
): Promise<{ row: MetaConnectionRow; token: string; relayToken: string | null } | null> {
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", {
      kind: "department",
      id: context.activeDepartmentId ?? undefined,
      departmentId: context.activeDepartmentId,
    });
    const { rows } = await client.query<MetaConnectionRow>(
      `select id, account_id, account_name, currency, timezone, token_enc, token_hint,
              relay_url, relay_token_enc, settings
         from skill_meta_connections
        where tenant_id = $1 and department_id = $2
        limit 1`,
      [context.tenantId, context.activeDepartmentId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      row,
      token: decryptSecret(row.token_enc) ?? "",
      relayToken: row.relay_token_enc ? decryptSecret(row.relay_token_enc) : null,
    };
  });
}

export async function getMetaConnection(context: UserContext): Promise<MetaConnectionView> {
  const loaded = await loadConnectionRow(context);
  if (!loaded) {
    return {
      connected: false,
      accountId: null,
      accountName: null,
      currency: null,
      timezone: null,
      tokenHint: null,
      relayUrl: null,
      relayTokenSet: false,
      settings: DEFAULT_META_SETTINGS,
    };
  }
  return {
    connected: true,
    accountId: loaded.row.account_id,
    accountName: loaded.row.account_name,
    currency: loaded.row.currency,
    timezone: loaded.row.timezone,
    tokenHint: loaded.row.token_hint,
    relayUrl: loaded.row.relay_url,
    relayTokenSet: Boolean(loaded.row.relay_token_enc),
    settings: resolveSettings(loaded.row.settings),
  };
}

export async function saveMetaConnection(
  context: UserContext,
  input: {
    accountId: string;
    token: string;
    relayUrl?: string;
    relayToken?: string;
    settings?: Partial<MetaSettings>;
    verify?: boolean;
  },
): Promise<MetaConnectionView> {
  const accountId = input.accountId.trim().replace(/^act_/, "");
  if (!/^[0-9]{5,32}$/.test(accountId)) {
    throw new SkillInputError("广告帐户 ID 只能填数字");
  }
  const token = input.token.trim();
  if (token.length < 20) {
    throw new SkillInputError("系统用户 token 不正确或过短");
  }
  const relayUrl = input.relayUrl?.trim() || null;
  if (relayUrl && !/^https?:\/\//.test(relayUrl)) {
    throw new SkillInputError("中转地址必须是 http(s) 链接");
  }

  let accountName: string | null = null;
  let currency: string | null = null;
  let timezone: string | null = null;
  if (input.verify) {
    const base = graphBase(relayUrl);
    const data = await graphRequest(base, `/act_${accountId}?fields=name,currency,timezone,account_status`, token, input.relayToken?.trim() || null);
    accountName = typeof data.name === "string" ? data.name : null;
    currency = typeof data.currency === "string" ? data.currency : null;
    timezone = typeof data.timezone === "string" ? data.timezone : null;
  }

  const settings = resolveSettings({ ...DEFAULT_META_SETTINGS, ...(input.settings ?? {}) });
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:edit", {
      kind: "department",
      id: context.activeDepartmentId ?? undefined,
      departmentId: context.activeDepartmentId,
    });
    const existing = await client.query<{ account_name: string | null; currency: string | null; timezone: string | null }>(
      `select account_name, currency, timezone from skill_meta_connections
        where tenant_id = $1 and department_id = $2`,
      [context.tenantId, context.activeDepartmentId],
    );
    const prev = existing.rows[0];
    await client.query(
      `insert into skill_meta_connections
        (tenant_id, department_id, account_id, account_name, currency, timezone,
         token_enc, token_hint, relay_url, relay_token_enc, settings, connected_by, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, now())
       on conflict (tenant_id, department_id) do update
         set account_id = excluded.account_id,
             account_name = excluded.account_name,
             currency = excluded.currency,
             timezone = excluded.timezone,
             token_enc = excluded.token_enc,
             token_hint = excluded.token_hint,
             relay_url = excluded.relay_url,
             relay_token_enc = excluded.relay_token_enc,
             settings = excluded.settings,
             connected_by = excluded.connected_by,
             updated_at = now()`,
      [
        context.tenantId,
        context.activeDepartmentId,
        accountId,
        accountName ?? prev?.account_name ?? null,
        currency ?? prev?.currency ?? null,
        timezone ?? prev?.timezone ?? null,
        encryptSecret(token),
        secretHint(token),
        relayUrl,
        input.relayToken?.trim() ? encryptSecret(input.relayToken.trim()) : null,
        JSON.stringify(settings),
        context.userId,
      ],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "skill.meta.connected",
      targetType: "skill",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: { accountId, accountName, relay: Boolean(relayUrl) },
    });
  });
  return getMetaConnection(context);
}

export async function disconnectMeta(context: UserContext): Promise<void> {
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:edit", {
      kind: "department",
      id: context.activeDepartmentId ?? undefined,
      departmentId: context.activeDepartmentId,
    });
    await client.query(
      `delete from skill_meta_connections where tenant_id = $1 and department_id = $2`,
      [context.tenantId, context.activeDepartmentId],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "skill.meta.disconnected",
      targetType: "skill",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: {},
    });
  });
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseResults(actions: unknown, resultActionTypes: string[]): number {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const raw of actions) {
    if (!raw || typeof raw !== "object") continue;
    const action = raw as { action_type?: string; value?: string | number };
    if (action.action_type && resultActionTypes.includes(action.action_type)) {
      total += toNumber(action.value);
    }
  }
  return total;
}

/** 纯函数：三层规则评审，返回待确认草稿；任何一步不满足就不关 */
export function runMetaRules(
  ads: MetaAdStat[],
  settings: MetaSettings,
  resultActionTypes: string[] = [
    "lead",
    "purchase",
    "complete_registration",
    "onsite_conversion.messaging_conversation_started_7d",
  ],
): MetaDraftPlan[] {
  const plans: MetaDraftPlan[] = [];
  const target = Math.max(settings.targetCostPerResult, 1);
  for (const ad of ads) {
    if (ad.status !== "ACTIVE") continue;
    const created = ad.createdTime ? Date.parse(ad.createdTime) : Number.NaN;
    const days = Number.isFinite(created) ? (Date.now() - created) / 86_400_000 : 99;
    if (days < 7) continue; // 学习期不动
    const results = ad.results || parseResults(undefined, resultActionTypes);
    const cost = results > 0 ? ad.spend / results : Number.POSITIVE_INFINITY;

    // 未到「够本」线时只考虑加预算：成本达标、有成果、花费达到 2 倍目标
    if (ad.spend < target * 3) {
      if (results > 0 && cost <= target * 0.8 && ad.spend >= target * 2 && ad.dailyBudget && ad.dailyBudget > 0) {
        const next = Math.round(ad.dailyBudget * (1 + settings.maxRaisePct / 100));
        plans.push({
          kind: "set_budget",
          targetId: ad.id,
          targetName: ad.name,
          campaignName: ad.campaignName,
          title: `加预算：${ad.name}`,
          reason: `每成果成本 ${cost.toFixed(2)} 低于目标的 80%，建议加 ${settings.maxRaisePct}%`,
          payload: { level: "ad", from: ad.dailyBudget, to: next },
        });
      }
      continue;
    }

    if (results <= 0) {
      plans.push({
        kind: "pause_ad",
        targetId: ad.id,
        targetName: ad.name,
        campaignName: ad.campaignName,
        title: `关广告：${ad.name}`,
        reason: `已花费 ${ad.spend.toFixed(2)}，达到 ${target * 3} 的 3 倍目标成本，仍无成果`,
        payload: { level: "ad", from: ad.status, to: "PAUSED" },
      });
      continue;
    }

    if (cost > target * 1.5) {
      plans.push({
        kind: "pause_ad",
        targetId: ad.id,
        targetName: ad.name,
        campaignName: ad.campaignName,
        title: `关广告：${ad.name}`,
        reason: `每成果成本 ${cost.toFixed(2)} 超过目标 ${target} 的 1.5 倍`,
        payload: { level: "ad", from: ad.status, to: "PAUSED" },
      });
      continue;
    }

    if (cost <= target * 0.8 && ad.dailyBudget && ad.dailyBudget > 0) {
      const next = Math.round(ad.dailyBudget * (1 + settings.maxRaisePct / 100));
      plans.push({
        kind: "set_budget",
        targetId: ad.id,
        targetName: ad.name,
        campaignName: ad.campaignName,
        title: `加预算：${ad.name}`,
        reason: `每成果成本 ${cost.toFixed(2)} 低于目标的 80%，建议加 ${settings.maxRaisePct}%`,
        payload: { level: "ad", from: ad.dailyBudget, to: next },
      });
    }
  }
  return plans;
}

export interface MetaSyncResult {
  since: string;
  until: string;
  campaigns: number;
  ads: number;
  drafts: number;
  summary: string;
}

export async function syncMetaAds(context: UserContext): Promise<MetaSyncResult> {
  const loaded = await loadConnectionRow(context);
  if (!loaded || !loaded.token) {
    throw new SkillInputError("尚未连接广告帐户");
  }
  if (!context.activeDepartmentId) {
    throw new SkillInputError("当前账号没有有效部门上下文");
  }
  const settings = resolveSettings(loaded.row.settings);
  const base = graphBase(loaded.row.relay_url);
  const account = `act_${loaded.row.account_id}`;

  const until = new Date();
  const since = new Date(until.getTime() - 7 * 86_400_000);
  const sinceText = since.toISOString().slice(0, 10);
  const untilText = until.toISOString().slice(0, 10);

  let campaigns: Record<string, unknown>[] = [];
  let ads: Record<string, unknown>[] = [];
  let insights: Record<string, unknown>[] = [];
  try {
    const campaignData = await graphRequest(
      base,
      `/${account}/campaigns?fields=id,name,status,daily_budget,created_time&limit=100`,
      loaded.token,
      loaded.relayToken,
    );
    campaigns = Array.isArray(campaignData.data) ? (campaignData.data as Record<string, unknown>[]) : [];
    const adData = await graphRequest(
      base,
      `/${account}/ads?fields=id,name,status,campaign_id,created_time,adset_id&limit=200`,
      loaded.token,
      loaded.relayToken,
    );
    ads = Array.isArray(adData.data) ? (adData.data as Record<string, unknown>[]) : [];
    const insightData = await graphRequest(
      base,
      `/${account}/insights?level=ad&time_range=${encodeURIComponent(JSON.stringify({ since: sinceText, until: untilText }))}&fields=ad_id,spend,actions,impressions,clicks&limit=500`,
      loaded.token,
      loaded.relayToken,
    );
    insights = Array.isArray(insightData.data) ? (insightData.data as Record<string, unknown>[]) : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : "同步失败";
    await withUserContext(context, async (client) => {
      const skill = await client.query<{ id: string }>(
        "select id from skills where key = 'meta-ads-operator' limit 1",
      );
      if (skill.rows[0]) {
        await client.query(
          `insert into skill_runs
            (tenant_id, department_id, skill_id, skill_key, kind, status, input, error, created_by, finished_at)
           values ($1, $2, $3, 'meta-ads-operator', 'meta_sync', 'failed', $4::jsonb, $5, $6, now())`,
          [context.tenantId, context.activeDepartmentId, skill.rows[0].id, JSON.stringify({ since: sinceText, until: untilText }), message, context.userId],
        );
      }
    });
    throw new SkillInputError(`同步失败：${message}`);
  }

  const campaignName = new Map<string, string>();
  for (const campaign of campaigns) {
    campaignName.set(String(campaign.id), String(campaign.name ?? ""));
  }
  const dailyBudget = new Map<string, number>();
  for (const campaign of campaigns) {
    if (campaign.daily_budget) dailyBudget.set(String(campaign.id), toNumber(campaign.daily_budget) / 100);
  }
  const stats = new Map<string, MetaAdStat>();
  for (const ad of ads) {
    const id = String(ad.id);
    stats.set(id, {
      id,
      name: String(ad.name ?? id),
      campaignId: String(ad.campaign_id ?? ""),
      campaignName: campaignName.get(String(ad.campaign_id ?? "")) ?? "",
      status: String(ad.status ?? "UNKNOWN"),
      dailyBudget: dailyBudget.get(String(ad.campaign_id ?? "")) ?? null,
      createdTime: ad.created_time ? String(ad.created_time) : null,
      spend: 0,
      results: 0,
      impressions: 0,
      clicks: 0,
    });
  }
  for (const row of insights) {
    const id = String(row.ad_id ?? "");
    const stat = stats.get(id);
    if (!stat) continue;
    stat.spend = toNumber(row.spend);
    stat.impressions = toNumber(row.impressions);
    stat.clicks = toNumber(row.clicks);
    stat.results = parseResults(row.actions, [
      "lead",
      "purchase",
      "complete_registration",
      "onsite_conversion.messaging_conversation_started_7d",
    ]);
  }

  const plans = runMetaRules([...stats.values()], settings);
  const created: MetaDraftPlan[] = [];
  await withUserContext(context, async (client) => {
    const skill = await client.query<{ id: string }>(
      "select id from skills where key = 'meta-ads-operator' limit 1",
    );
    if (!skill.rows[0]) {
      throw new SkillInputError("技能未注册");
    }
    for (const plan of plans) {
      const exists = await client.query(
        `select 1 from skill_meta_drafts
          where tenant_id = $1 and department_id = $2 and kind = $3
            and target_id = $4 and status = 'pending'`,
        [context.tenantId, context.activeDepartmentId, plan.kind, plan.targetId],
      );
      if (exists.rows[0]) continue;
      await client.query(
        `insert into skill_meta_drafts
          (tenant_id, department_id, kind, target_id, target_name, campaign_name,
           title, reason, payload, source, status, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'rule', 'pending', $10)`,
        [
          context.tenantId,
          context.activeDepartmentId,
          plan.kind,
          plan.targetId,
          plan.targetName,
          plan.campaignName,
          plan.title,
          plan.reason,
          JSON.stringify(plan.payload),
          context.userId,
        ],
      );
      created.push(plan);
    }
    const snapshot = {
      since: sinceText,
      until: untilText,
      campaigns: campaigns.length,
      ads: [...stats.values()],
      drafts: created.length,
    };
    await client.query(
      `insert into skill_runs
        (tenant_id, department_id, skill_id, skill_key, kind, status, input, output, created_by, finished_at)
       values ($1, $2, $3, 'meta-ads-operator', 'meta_sync', 'done', $4::jsonb, $5::jsonb, $6, now())`,
      [
        context.tenantId,
        context.activeDepartmentId,
        skill.rows[0].id,
        JSON.stringify({ since: sinceText, until: untilText }),
        JSON.stringify(snapshot),
        context.userId,
      ],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "skill.meta.synced",
      targetType: "skill",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: { campaigns: campaigns.length, ads: ads.length, drafts: created.length },
    });
  });

  const summary = `已同步 ${campaigns.length} 个活动、${ads.length} 条广告；新草稿 ${created.length} 条。`;
  return {
    since: sinceText,
    until: untilText,
    campaigns: campaigns.length,
    ads: ads.length,
    drafts: created.length,
    summary,
  };
}

function toDraftView(row: Record<string, unknown>): MetaDraftView {
  return {
    id: String(row.id),
    kind: String(row.kind),
    targetId: String(row.target_id),
    targetName: String(row.target_name),
    campaignName: (row.campaign_name as string | null) ?? null,
    title: String(row.title),
    reason: String(row.reason),
    payload: (row.payload as Record<string, unknown>) ?? {},
    source: String(row.source),
    status: String(row.status),
    error: (row.error as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    decidedAt: (row.decided_at as Date | null)?.toISOString() ?? null,
  };
}

export async function listMetaDrafts(context: UserContext, limit = 30): Promise<MetaDraftView[]> {
  return withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:use", {
      kind: "department",
      id: context.activeDepartmentId ?? undefined,
      departmentId: context.activeDepartmentId,
    });
    const { rows } = await client.query(
      `select id, kind, target_id, target_name, campaign_name, title, reason, payload,
              source, status, error, created_at, decided_at
         from skill_meta_drafts
        where tenant_id = $1 and department_id = $2
        order by created_at desc
        limit $3`,
      [context.tenantId, context.activeDepartmentId, Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map(toDraftView);
  });
}

export async function confirmMetaDraft(context: UserContext, draftId: string): Promise<string> {
  const loaded = await loadConnectionRow(context);
  if (!loaded || !loaded.token) {
    throw new SkillInputError("尚未连接广告帐户");
  }
  const draft = await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:edit", {
      kind: "department",
      id: context.activeDepartmentId ?? undefined,
      departmentId: context.activeDepartmentId,
    });
    const { rows } = await client.query<Record<string, unknown>>(
      `select id, kind, target_id, target_name, payload, status
         from skill_meta_drafts
        where id = $1 and tenant_id = $2 and department_id = $3
        limit 1`,
      [draftId, context.tenantId, context.activeDepartmentId],
    );
    return rows[0] ?? null;
  });
  if (!draft) {
    throw new SkillInputError("草稿不存在");
  }
  if (draft.status !== "pending") {
    throw new SkillInputError("该草稿已处理");
  }

  const base = graphBase(loaded.row.relay_url);
  const targetId = String(draft.target_id);
  const payload = (draft.payload as Record<string, unknown>) ?? {};
  const form: Record<string, string> = {};
  if (draft.kind === "pause_ad") form.status = "PAUSED";
  else if (draft.kind === "resume_ad") form.status = "ACTIVE";
  else if (draft.kind === "set_budget") form.daily_budget = String(payload.to ?? "");

  try {
    await graphRequest(base, `/${targetId}`, loaded.token, loaded.relayToken, {
      method: "POST",
      body: form,
    });
    await withUserContext(context, async (client) => {
      await client.query(
        `update skill_meta_drafts
            set status = 'executed', decided_at = now(), decided_by = $2
          where id = $1`,
        [draftId, context.userId],
      );
      await auditInTx(client, context, {
        actorUserId: context.userId,
        action: "skill.meta.draft_executed",
        targetType: "skill",
        targetId: null,
        departmentId: context.activeDepartmentId,
        payload: { draftId, kind: draft.kind, targetId, form },
      });
    });
    return "已写入 Meta，请在动作日志中核对";
  } catch (error) {
    const message = error instanceof Error ? error.message : "执行失败";
    await withUserContext(context, async (client) => {
      await client.query(
        `update skill_meta_drafts
            set status = 'failed', error = $2, decided_at = now(), decided_by = $3
          where id = $1`,
        [draftId, message, context.userId],
      );
    });
    throw new SkillInputError(`执行失败：${message}`);
  }
}

export async function dismissMetaDraft(context: UserContext, draftId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:edit", {
      kind: "department",
      id: context.activeDepartmentId ?? undefined,
      departmentId: context.activeDepartmentId,
    });
    const { rowCount } = await client.query(
      `update skill_meta_drafts
          set status = 'dismissed', decided_at = now(), decided_by = $2
        where id = $1 and status = 'pending'`,
      [draftId, context.userId],
    );
    if (rowCount === 0) {
      throw new SkillInputError("草稿不存在或已处理");
    }
  });
}

export async function revertMetaDraft(context: UserContext, draftId: string): Promise<void> {
  await withUserContext(context, async (client) => {
    await requireContextPermission(client, context, "skill:edit", {
      kind: "department",
      id: context.activeDepartmentId ?? undefined,
      departmentId: context.activeDepartmentId,
    });
    const { rows } = await client.query<Record<string, unknown>>(
      `select kind, target_id, target_name, campaign_name, payload
         from skill_meta_drafts
        where id = $1 and tenant_id = $2 and department_id = $3 and status = 'executed'
        limit 1`,
      [draftId, context.tenantId, context.activeDepartmentId],
    );
    const draft = rows[0];
    if (!draft) {
      throw new SkillInputError("只能恢复已执行的草稿");
    }
    const kind = String(draft.kind);
    const payload = (draft.payload as Record<string, unknown>) ?? {};
    const reverseKind = kind === "pause_ad" ? "resume_ad" : kind === "resume_ad" ? "pause_ad" : "set_budget";
    const reversePayload =
      kind === "set_budget"
        ? { level: payload.level ?? "ad", from: payload.to, to: payload.from }
        : { level: payload.level ?? "ad", from: payload.to, to: payload.from };
    await client.query(
      `insert into skill_meta_drafts
        (tenant_id, department_id, kind, target_id, target_name, campaign_name,
         title, reason, payload, source, status, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'manual', 'pending', $10)`,
      [
        context.tenantId,
        context.activeDepartmentId,
        reverseKind,
        String(draft.target_id),
        String(draft.target_name),
        (draft.campaign_name as string | null) ?? null,
        `恢复：${String(draft.target_name)}`,
        "由已执行动作生成的反向草稿，确认后才会写入 Meta",
        JSON.stringify(reversePayload),
        context.userId,
      ],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "skill.meta.revert_drafted",
      targetType: "skill",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: { draftId, reverseKind },
    });
  });
}
