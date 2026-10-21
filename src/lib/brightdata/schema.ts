import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";

/**
 * Bright Data as an optional research provider (catalog.ts). Created by
 * scripts/add-brightdata.ts; scoped by organization. Its collections are
 * rows of the shared usage ledger (provider_usage, provider "brightdata"),
 * reserved before Bright Data is called and settled from what it delivered.
 */
export const brightdataSettings = pgTable(
  "brightdata_settings",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id),
    /** The API key, encrypted like every integration credential. */
    encryptedKey: text("encrypted_key"),
    keyHint: text("key_hint"),
    monthlyCredits: integer("monthly_credits").notNull().default(1000),
    maxRecordsPerSearch: integer("max_records_per_search").notNull().default(60),
    /** A SERP API zone the owner created in Bright Data, used only when no web search is set up. */
    serpZone: text("serp_zone"),
    /** Reddit research stays off until the owner turns it on. */
    redditEnabled: boolean("reddit_enabled").notNull().default(false),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("brightdata_settings_limits_chk", sql`${table.monthlyCredits} BETWEEN 0 AND 100000 AND ${table.maxRecordsPerSearch} BETWEEN 5 AND 300`),
  ],
);
