import { sql } from "drizzle-orm";
import { check, doublePrecision, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";

/**
 * Treg (treg.to) as an optional, keyed tool source (catalog.ts). Created by
 * scripts/add-instagram-intake-discovery.ts; both tables are scoped by
 * organization.
 */

/** One organization's Treg key and daily spend cap. No row: Treg is not set up. */
export const tregSettings = pgTable(
  "treg_settings",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id),
    /** The per-team key (X-Treg-Token), encrypted like every integration credential. */
    encryptedKey: text("encrypted_key"),
    keyHint: text("key_hint"),
    /** The Treg team the key belongs to (GET /auth/me when it was saved). */
    team: text("team"),
    dailyCapUsd: doublePrecision("daily_cap_usd").notNull().default(2),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("treg_settings_cap_chk", sql`${table.dailyCapUsd} >= 0 AND ${table.dailyCapUsd} <= 100`)],
);

export type TregCallStatus = "calling" | "succeeded" | "failed";

/**
 * Every paid Treg call, recorded before it is made (status "calling", its
 * ceiling counted as reserved), so two calls cannot both take the last of
 * the day's cap and a crash never hides a charge. The day's spend is the
 * sum of what Treg reported (X-Treg-Cost-Micro) plus the ceilings of calls
 * still open.
 */
export const tregCalls = pgTable(
  "treg_calls",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id"),
    endpointId: text("endpoint_id").notNull(),
    status: text("status").notNull().default("calling").$type<TregCallStatus>(),
    /** The X-Treg-Route-Max-Cost the call was sent with. */
    ceilingUsd: doublePrecision("ceiling_usd").notNull(),
    /** What Treg reported it charged. */
    costUsd: doublePrecision("cost_usd"),
    httpStatus: integer("http_status"),
    /** X-Treg-Call-Id, to look the call up with Treg. */
    tregCallId: text("treg_call_id"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("treg_calls_org_created_idx").on(table.organizationId, table.createdAt),
    check("treg_calls_status_chk", sql`${table.status} IN ('calling', 'succeeded', 'failed')`),
  ],
);

export type TregCallRow = typeof tregCalls.$inferSelect;
