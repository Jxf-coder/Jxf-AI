import { pgEnum } from "drizzle-orm/pg-core";

/** 岗位类型：根岗位 / 中间岗位 / 席位 */
export const roleKind = pgEnum("role_kind", ["root", "child", "seat"]);

/** 访问等级：L1 最强 */
export const accessLevel = pgEnum("access_level", ["L1", "L2", "L3"]);

export const membershipStatus = pgEnum("membership_status", ["active", "removed"]);
