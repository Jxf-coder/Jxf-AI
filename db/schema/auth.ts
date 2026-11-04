import { sql } from "drizzle-orm";
import { boolean, date, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { userStatus } from "./enums";

/**
 * Auth.js v5 + Drizzle Adapter 所需表。
 * 这些是身份基础表，不承载业务数据，因此 P1 不对其启用 RLS；
 * 业务表（departments / memberships / department_packs / audit_events）全部强制 RLS。
 *
 * 账号模型：手机号为唯一主账号标识；邮箱为选填，且通过
 * user_email_identities 支持 1:N（为后续 CRM 多邮箱收发留位）。
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name"),
    // 手机号是主账号标识；允许为空仅为兼容历史 / OAuth 用户
    phone: text("phone"),
    // 邮箱选填：无邮箱的成员暂不可用邮箱口令登录，等手机号注册绑定
    email: text("email"),
    /** 生日（HR 档案，选填；仅用于资料展示与生日提醒） */
    birthday: date("birthday"),
    emailVerified: timestamp("email_verified", { withTimezone: true }),
    image: text("image"),
    // 仅 Credentials 登录使用；OAuth 用户可为空
    passwordHash: text("password_hash"),
    /** 账号状态：pending_handover 期间拒绝登录，disabled 为正式停用 */
    status: userStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    uniqueIndex("users_phone_unique").on(table.phone),
  ],
);

/**
 * 用户邮箱身份（1:N）：一个成员可绑定多个邮箱。
 * 当前仅写入主邮箱；后续 CRM 多邮箱收发按此表扩展。
 */
export const userEmailIdentities = pgTable(
  "user_email_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_email_identities_email_unique").on(table.tenantId, table.email),
    uniqueIndex("user_email_identities_primary_unique")
      .on(table.userId)
      .where(sql`is_primary`),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    // @auth/drizzle-adapter 的 Postgres schema 以这些 snake_case 属性名建查询，不能改名
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (table) => [primaryKey({ columns: [table.provider, table.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
);
