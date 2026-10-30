import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth";
import { accessLevel, membershipStatus } from "./enums";
import { roles } from "./roles";

/** 任用：user ↔ role，携带 L1/L2/L3 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    accessLevel: accessLevel("access_level").notNull().default("L3"),
    status: membershipStatus("status").notNull().default("active"),
    sshEnabled: boolean("ssh_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("memberships_active_unique")
      .on(table.userId, table.roleId)
      .where(sql`status = 'active'`),
    index("memberships_user_idx").on(table.userId),
    index("memberships_role_idx").on(table.roleId),
    check(
      "memberships_removed_shape",
      sql`(status = 'active' and removed_at is null) or (status = 'removed' and removed_at is not null)`,
    ),
  ],
);
