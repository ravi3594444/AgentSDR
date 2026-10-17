import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";

/**
 * Tavily as the web search behind website searches (catalog.ts). Created by
 * scripts/add-instagram-intake-discovery.ts; scoped by organization. The
 * searches themselves are counted from the website-search jobs that used
 * Tavily (assistant_jobs payload `searchProvider`), so no ledger is needed.
 */
export const tavilySettings = pgTable(
  "tavily_settings",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id),
    /** The API key, encrypted like every integration credential. */
    encryptedKey: text("encrypted_key"),
    keyHint: text("key_hint"),
    dailySearches: integer("daily_searches").notNull().default(100),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("tavily_settings_daily_chk", sql`${table.dailySearches} BETWEEN 1 AND 2000`)],
);
