import { pgEnum } from "drizzle-orm/pg-core";

/** 访问等级：L1 最强 */
export const accessLevel = pgEnum("access_level", ["L1", "L2", "L3"]);

/**
 * 任用状态：
 * - active：在岗
 * - pending_removal：已发起移出，等待资产交接审批；禁止写操作
 * - removed：已停用（软删除，可恢复）
 */
export const membershipStatus = pgEnum("membership_status", [
  "active",
  "pending_removal",
  "removed",
]);

/**
 * 账号状态：
 * - active：可登录
 * - pending_handover：离职交接中，禁止登录
 * - disabled：已停用
 */
export const userStatus = pgEnum("user_status", ["active", "pending_handover", "disabled"]);
