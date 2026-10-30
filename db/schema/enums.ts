import { pgEnum } from "drizzle-orm/pg-core";

/** 访问等级：L1 最强 */
export const accessLevel = pgEnum("access_level", ["L1", "L2", "L3"]);

export const membershipStatus = pgEnum("membership_status", ["active", "removed"]);
