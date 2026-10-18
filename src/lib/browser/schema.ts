import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";

export type BrowserSessionStatus = "opening" | "open" | "closed" | "failed";

/**
 * The assistant's remote browser sessions (TinyFish Browser, driven over
 * CDP; browser.server.ts). One at a time per organization; minutes are
 * reserved in provider_usage when one opens and settled when it ends.
 * The CDP URL is a capability to control the browser, so it is stored
 * encrypted like a credential. Created by scripts/add-browser-sessions.ts.
 */
export const browserSessions = pgTable(
  "browser_sessions",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id"),
    provider: text("provider").notNull().default("tinyfish"),
    providerSessionId: text("provider_session_id"),
    encryptedCdpUrl: text("encrypted_cdp_url"),
    /** The provider_usage row holding the reserved minutes. */
    usageId: uuid("usage_id"),
    status: text("status").notNull().$type<BrowserSessionStatus>().default("opening"),
    currentUrl: text("current_url"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    minutesUsed: integer("minutes_used"),
  },
  (table) => [
    index("browser_sessions_org_status_idx").on(table.organizationId, table.status, table.startedAt),
    check("browser_sessions_status_chk", sql`${table.status} IN ('opening', 'open', 'closed', 'failed')`),
  ],
);
