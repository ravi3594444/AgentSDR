import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";

/**
 * The organization's TinyFish connection (catalog.ts): the key, whether web
 * searches use it, and the organization's daily browser minutes (0 keeps the
 * metered browser off). Created by scripts/add-tinyfish.ts; scoped by
 * organization. Use is counted in provider_usage and against the key's
 * shared free allowance in provider_quota_state (src/lib/quota/).
 */
export const tinyfishSettings = pgTable(
  "tinyfish_settings",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id),
    /** The API key, encrypted like every integration credential. */
    encryptedKey: text("encrypted_key"),
    keyHint: text("key_hint"),
    /** sha256 of the key: the quota scope its free allowance is counted under. Never the key. */
    keyScope: text("key_scope"),
    useForWebSearch: boolean("use_for_web_search").notNull().default(true),
    browserMinutesPerDay: integer("browser_minutes_per_day").notNull().default(0),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("tinyfish_settings_browser_chk", sql`${table.browserMinutesPerDay} BETWEEN 0 AND 240`)],
);
