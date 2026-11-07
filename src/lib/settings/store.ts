/**
 * 平台设置领域层（P5 设置面）。
 *
 * - 品牌 / 模型 Key / 审计留存存放在 app_settings 单行表；
 * - 读写必须经 platform:settings 守卫（L1-only），所有变更写审计；
 * - 模型 Key 加密后入库，前端只看到末 4 位提示；
 * - 登录页与启动期通过 SECURITY DEFINER 函数读取，不绕过 RLS 直接查表。
 */

import type { PoolClient } from "pg";

import { auditInTx } from "@/lib/audit";
import { getPool } from "@/lib/db/pool";
import { withUserContext, type UserContext } from "@/lib/db/user-context";
import { requireContextPermission } from "@/lib/permissions/server";
import type { PermissionResource } from "@/types/permission";

import { encryptSecret, secretHint } from "./crypto";
import {
  CLEAR_API_KEY,
  DEFAULT_BRANDING,
  type AuditSettings,
  type AiSettings,
  type BrandingSettings,
  type PlatformSettingsView,
} from "./types";

export { CLEAR_API_KEY };
export type { AiSettings, AuditSettings, BrandingSettings, PlatformSettingsView };

export class SettingsInputError extends Error {}

export interface RuntimeSettings {
  aiEnabled: boolean | null;
  aiBaseUrl: string | null;
  aiApiKeyEnc: string | null;
  aiApiKeyHint: string | null;
  aiModelPro: string | null;
  aiModelFlash: string | null;
  auditRetentionDays: number | null;
}

interface SettingsRow {
  site_name: string;
  site_tagline: string;
  brand_primary: string;
  brand_strong: string;
  brand_deep: string;
  brand_soft: string;
  ai_enabled: boolean | null;
  ai_base_url: string | null;
  ai_model_pro: string | null;
  ai_model_flash: string | null;
  key_configured: boolean;
  ai_api_key_hint: string | null;
  audit_retention_days: number | null;
  updated_at: Date | string;
}

const SETTINGS_QUERY = `
  select site_name, site_tagline, brand_primary, brand_strong, brand_deep, brand_soft,
         ai_enabled, ai_base_url, ai_model_pro, ai_model_flash,
         ai_api_key_enc is not null as key_configured, ai_api_key_hint,
         audit_retention_days, updated_at
    from app_settings
   where id = 1
`;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function settingsResource(context: UserContext): PermissionResource {
  const departmentId = context.activeDepartmentId;
  return { kind: "department", id: departmentId ?? undefined, departmentId };
}

async function requireSettingsPermission(client: PoolClient, context: UserContext): Promise<void> {
  await requireContextPermission(client, context, "platform:settings", settingsResource(context));
}

function requiredText(value: unknown, label: string, max: number): string {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new SettingsInputError(`${label}不能为空`);
  }
  if (text.length > max) {
    throw new SettingsInputError(`${label}不能超过 ${max} 个字符`);
  }
  return text;
}

function optionalText(value: unknown, max: number): string | null {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  if (text.length > max) {
    throw new SettingsInputError(`内容不能超过 ${max} 个字符`);
  }
  return text;
}

function hexColor(value: unknown, label: string, fallback: string): string {
  const text = String(value ?? "").trim() || fallback;
  if (!HEX_COLOR.test(text)) {
    throw new SettingsInputError(`${label}必须是 #RRGGBB 格式`);
  }
  return text.toLowerCase();
}

function normalizeHex(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

function normalizeText(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const text = value.trim();
  return text ? text.slice(0, max) : fallback;
}

// ---------------------------------------------------------------------------
// 读（用户上下文）
// ---------------------------------------------------------------------------

export async function readPlatformSettings(context: UserContext): Promise<PlatformSettingsView> {
  return withUserContext(context, async (client) => {
    await requireSettingsPermission(client, context);

    const { rows } = await client.query<SettingsRow>(SETTINGS_QUERY);
    const row = rows[0];

    const auditStats = await client.query<{ total: number; earliest: Date | null }>(
      "select count(*)::int as total, min(created_at) as earliest from audit_events",
    );

    return {
      branding: row
        ? {
            siteName: row.site_name,
            siteTagline: row.site_tagline,
            brandPrimary: normalizeHex(row.brand_primary, DEFAULT_BRANDING.brandPrimary),
            brandStrong: normalizeHex(row.brand_strong, DEFAULT_BRANDING.brandStrong),
            brandDeep: normalizeHex(row.brand_deep, DEFAULT_BRANDING.brandDeep),
            brandSoft: normalizeHex(row.brand_soft, DEFAULT_BRANDING.brandSoft),
          }
        : DEFAULT_BRANDING,
      ai: {
        enabled: row?.ai_enabled ?? null,
        baseUrl: row?.ai_base_url ?? null,
        modelPro: row?.ai_model_pro ?? null,
        modelFlash: row?.ai_model_flash ?? null,
        keyConfigured: Boolean(row?.key_configured),
        keyHint: row?.ai_api_key_hint ?? null,
      },
      audit: {
        retentionDays: row?.audit_retention_days ?? null,
        totalEvents: auditStats.rows[0]?.total ?? 0,
        earliestEventAt: auditStats.rows[0]?.earliest
          ? new Date(auditStats.rows[0].earliest).toISOString()
          : null,
      },
      updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  });
}

/** 启动期 / 运行时覆盖读取：走 SECURITY DEFINER，不需要用户上下文 */
export async function readRuntimeSettings(): Promise<RuntimeSettings> {
  const { rows } = await getPool().query<{ value: Record<string, unknown> | null }>(
    "select app.runtime_settings() as value",
  );
  const raw = rows[0]?.value ?? {};
  const retention = Number(raw.audit_retention_days);
  return {
    aiEnabled: typeof raw.ai_enabled === "boolean" ? raw.ai_enabled : null,
    aiBaseUrl: typeof raw.ai_base_url === "string" ? raw.ai_base_url : null,
    aiApiKeyEnc: typeof raw.ai_api_key_enc === "string" ? raw.ai_api_key_enc : null,
    aiApiKeyHint: typeof raw.ai_api_key_hint === "string" ? raw.ai_api_key_hint : null,
    aiModelPro: typeof raw.ai_model_pro === "string" ? raw.ai_model_pro : null,
    aiModelFlash: typeof raw.ai_model_flash === "string" ? raw.ai_model_flash : null,
    auditRetentionDays: Number.isFinite(retention) && retention >= 30 ? retention : null,
  };
}

// ---------------------------------------------------------------------------
// 公开品牌：登录页与全站主题（无身份依赖，短 TTL 缓存）
// ---------------------------------------------------------------------------

let brandingCache: { value: BrandingSettings; expiresAt: number } | null = null;
const BRANDING_TTL_MS = 30_000;

export function invalidateBrandingCache(): void {
  brandingCache = null;
}

export async function getPublicBranding(): Promise<BrandingSettings> {
  if (brandingCache && brandingCache.expiresAt > Date.now()) {
    return brandingCache.value;
  }
  try {
    const { rows } = await getPool().query<{ value: Record<string, unknown> | null }>(
      "select app.public_branding() as value",
    );
    const raw = rows[0]?.value ?? {};
    const value: BrandingSettings = {
      siteName: normalizeText(raw.site_name, DEFAULT_BRANDING.siteName, 40),
      siteTagline: normalizeText(raw.site_tagline, DEFAULT_BRANDING.siteTagline, 120),
      brandPrimary: normalizeHex(raw.brand_primary, DEFAULT_BRANDING.brandPrimary),
      brandStrong: normalizeHex(raw.brand_strong, DEFAULT_BRANDING.brandStrong),
      brandDeep: normalizeHex(raw.brand_deep, DEFAULT_BRANDING.brandDeep),
      brandSoft: normalizeHex(raw.brand_soft, DEFAULT_BRANDING.brandSoft),
    };
    brandingCache = { value, expiresAt: Date.now() + BRANDING_TTL_MS };
    return value;
  } catch {
    // 建库前 / 数据库暂不可用时回退默认品牌，不阻断登录页
    return DEFAULT_BRANDING;
  }
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

export async function saveBranding(context: UserContext, input: BrandingSettings): Promise<void> {
  const clean: BrandingSettings = {
    siteName: requiredText(input.siteName, "站点名称", 40),
    siteTagline: optionalText(input.siteTagline, 120) ?? "",
    brandPrimary: hexColor(input.brandPrimary, "品牌主色", DEFAULT_BRANDING.brandPrimary),
    brandStrong: hexColor(input.brandStrong, "品牌深色", DEFAULT_BRANDING.brandStrong),
    brandDeep: hexColor(input.brandDeep, "品牌最深色", DEFAULT_BRANDING.brandDeep),
    brandSoft: hexColor(input.brandSoft, "品牌浅色", DEFAULT_BRANDING.brandSoft),
  };

  await withUserContext(context, async (client) => {
    await requireSettingsPermission(client, context);
    await client.query(
      `update app_settings
          set site_name = $1, site_tagline = $2,
              brand_primary = $3, brand_strong = $4, brand_deep = $5, brand_soft = $6,
              updated_at = now(), updated_by_user_id = $7
        where id = 1`,
      [
        clean.siteName,
        clean.siteTagline,
        clean.brandPrimary,
        clean.brandStrong,
        clean.brandDeep,
        clean.brandSoft,
        context.userId,
      ],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "settings.brand_updated",
      targetType: "app_settings",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: {
        site_name: clean.siteName,
        brand_primary: clean.brandPrimary,
        brand_strong: clean.brandStrong,
        brand_deep: clean.brandDeep,
        brand_soft: clean.brandSoft,
      },
    });
  });

  invalidateBrandingCache();
}

export interface AiSettingsInput {
  enabled: boolean | null;
  baseUrl: string;
  modelPro: string;
  modelFlash: string;
  /** 空字符串 = 保留已保存 Key；CLEAR_API_KEY = 清除 */
  apiKey: string;
}

export interface AiSettingsSaved {
  keyConfigured: boolean;
  keyHint: string | null;
}

export async function saveAiSettings(
  context: UserContext,
  input: AiSettingsInput,
): Promise<AiSettingsSaved> {
  const baseUrl = optionalText(input.baseUrl, 300);
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new SettingsInputError("Base URL 不是合法地址");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new SettingsInputError("Base URL 只支持 http / https");
    }
  }
  const modelPro = optionalText(input.modelPro, 100);
  const modelFlash = optionalText(input.modelFlash, 100);
  const rawKey = input.apiKey.trim();
  if (rawKey && rawKey !== CLEAR_API_KEY && rawKey.length > 500) {
    throw new SettingsInputError("API Key 过长");
  }

  let saved: AiSettingsSaved = { keyConfigured: false, keyHint: null };

  await withUserContext(context, async (client) => {
    await requireSettingsPermission(client, context);

    const current = await client.query<{
      ai_api_key_enc: string | null;
      ai_api_key_hint: string | null;
    }>("select ai_api_key_enc, ai_api_key_hint from app_settings where id = 1");
    const existing = current.rows[0];

    let nextEnc = existing?.ai_api_key_enc ?? null;
    let nextHint = existing?.ai_api_key_hint ?? null;
    let keyChanged = false;

    if (rawKey === CLEAR_API_KEY) {
      keyChanged = nextEnc !== null;
      nextEnc = null;
      nextHint = null;
    } else if (rawKey) {
      nextEnc = encryptSecret(rawKey);
      nextHint = secretHint(rawKey);
      keyChanged = true;
    }

    const normalizedBaseUrl = baseUrl ? baseUrl.replace(/\/+$/, "") : null;

    await client.query(
      `update app_settings
          set ai_enabled = $1, ai_base_url = $2, ai_model_pro = $3, ai_model_flash = $4,
              ai_api_key_enc = $5, ai_api_key_hint = $6,
              updated_at = now(), updated_by_user_id = $7
        where id = 1`,
      [
        input.enabled,
        normalizedBaseUrl,
        modelPro,
        modelFlash,
        nextEnc,
        nextHint,
        context.userId,
      ],
    );

    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "settings.ai_updated",
      targetType: "app_settings",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: {
        enabled: input.enabled,
        base_url: normalizedBaseUrl,
        model_pro: modelPro,
        model_flash: modelFlash,
        api_key_changed: keyChanged,
        api_key_configured: nextEnc !== null,
      },
    });

    saved = { keyConfigured: nextEnc !== null, keyHint: nextHint };
  });

  return saved;
}

export async function saveAuditRetention(
  context: UserContext,
  days: number | null,
): Promise<void> {
  if (days !== null && (!Number.isInteger(days) || days < 30 || days > 3650)) {
    throw new SettingsInputError("留存天数必须是 30–3650 之间的整数");
  }

  await withUserContext(context, async (client) => {
    await requireSettingsPermission(client, context);
    await client.query(
      `update app_settings
          set audit_retention_days = $1, updated_at = now(), updated_by_user_id = $2
        where id = 1`,
      [days, context.userId],
    );
    await auditInTx(client, context, {
      actorUserId: context.userId,
      action: "settings.audit_retention_updated",
      targetType: "app_settings",
      targetId: null,
      departmentId: context.activeDepartmentId,
      payload: { retention_days: days },
    });
  });
}
