/**
 * 设置面共享类型与常量（客户端可安全导入，不含 Node / 数据库依赖）。
 */

/** 前端清空已保存 Key 的显式指令，避免「空字符串 = 不修改」产生歧义 */
export const CLEAR_API_KEY = "__clear__";

export interface BrandingSettings {
  siteName: string;
  siteTagline: string;
  brandPrimary: string;
  brandStrong: string;
  brandDeep: string;
  brandSoft: string;
}

export const DEFAULT_BRANDING: BrandingSettings = {
  siteName: "AI 工作台",
  siteTagline: "私有化交付的 AI 员工平台",
  brandPrimary: "#0071e3",
  brandStrong: "#13315c",
  brandDeep: "#0b2545",
  brandSoft: "#eff4ff",
};

export interface AiSettings {
  /** null = 跟随环境变量；true / false = 页面显式覆盖 */
  enabled: boolean | null;
  baseUrl: string | null;
  modelPro: string | null;
  modelFlash: string | null;
  keyConfigured: boolean;
  keyHint: string | null;
}

export interface AuditSettings {
  retentionDays: number | null;
  totalEvents: number;
  earliestEventAt: string | null;
}

/** 邮件通知（SMTP）：口令只展示末 4 位 */
export interface NotificationSettings {
  enabled: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  passConfigured: boolean;
  passHint: string | null;
  to: string | null;
}

export interface PlatformSettingsView {
  branding: BrandingSettings;
  ai: AiSettings;
  audit: AuditSettings;
  notifications: NotificationSettings;
  updatedAt: string | null;
}

/** 当前进程实际生效的模型配置（环境变量与数据库覆盖合并后） */
export interface EffectiveAiSummary {
  enabled: boolean;
  baseUrl: string;
  chatModel: string;
  fastModel: string;
  apiKeyHint: string | null;
  embeddingEnabled: boolean;
  ocrEnabled: boolean;
}
