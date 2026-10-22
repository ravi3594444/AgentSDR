import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "@/lib/auth/schema";

/**
 * Managed SaaS tables (docs/plans/MANAGED_SAAS_IMPLEMENTATION_2026-10-22.md).
 * Created by scripts/add-managed-saas.ts (db/migrations/20261022-managed-saas.sql).
 */

/**
 * The people who run this AgentSDR instance. GLOBAL: not a role in any
 * organization. Granted only by scripts/grant-platform-operator.ts.
 */
export const platformOperators = pgTable("platform_operators", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  grantedBy: text("granted_by").notNull(),
  note: text("note"),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
});
