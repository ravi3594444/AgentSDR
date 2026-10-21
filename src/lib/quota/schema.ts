import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";

/**
 * Provider quotas and use (quota.ts). Created by scripts/add-tinyfish.ts.
 *
 * provider_quota_state is GLOBAL on purpose: a provider counts its limits
 * per API key (or IP, or OAuth client), so the row is keyed by that scope
 * (a sha256, never the key) and holds only counters and a wait. Two
 * organizations that saved the same key share one row, exactly as they
 * share the provider's limit. No organization data is stored in it.
 *
 * provider_usage is the organization's own ledger: one row per call,
 * reserved before the call and settled after it, so a lost answer stays
 * visible as `uncertain` and is never silently retried.
 */
export const providerQuotaState = pgTable(
  "provider_quota_state",
  {
    scopeKey: text("scope_key").notNull(),
    /** e.g. tinyfish:search, tinyfish:fetch. */
    product: text("product").notNull(),
    minuteStart: timestamp("minute_start", { withTimezone: true }),
    minuteUsed: integer("minute_used").notNull().default(0),
    hourStart: timestamp("hour_start", { withTimezone: true }),
    hourUsed: integer("hour_used").notNull().default(0),
    dayStart: timestamp("day_start", { withTimezone: true }),
    dayUsed: integer("day_used").notNull().default(0),
    blockedUntil: timestamp("blocked_until", { withTimezone: true }),
    blockedReason: text("blocked_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ name: "provider_quota_state_pkey", columns: [table.scopeKey, table.product] })],
);

export type ProviderUsageStatus = "reserved" | "settled" | "failed" | "uncertain";

export const providerUsage = pgTable(
  "provider_usage",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    product: text("product").notNull(),
    scopeKey: text("scope_key"),
    /** Units counted against the quota when reserved (requests, URLs or minutes). */
    units: integer("units").notNull(),
    /** Units actually used, once settled. */
    usedUnits: integer("used_units"),
    status: text("status").notNull().$type<ProviderUsageStatus>().default("reserved"),
    jobId: uuid("job_id"),
    threadId: uuid("thread_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    index("provider_usage_org_product_idx").on(table.organizationId, table.provider, table.product, table.createdAt),
    // scripts/add-brightdata.ts: a job's collections, found again by a retried step.
    index("provider_usage_job_idx").on(table.jobId).where(sql`${table.jobId} IS NOT NULL`),
    check("provider_usage_status_chk", sql`${table.status} IN ('reserved', 'settled', 'failed', 'uncertain')`),
  ],
);
