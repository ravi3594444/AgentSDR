import { sql } from "drizzle-orm";
import { boolean, check, doublePrecision, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "@/lib/auth/schema";
import type { ApifyActorKey } from "./catalog";

/**
 * Apify as an optional discovery provider (catalog.ts). Created by
 * scripts/add-instagram-intake-discovery.ts; both tables are scoped by
 * organization.
 */

/** One organization's Apify connection and limits. No row: Apify is not set up. */
export const apifySettings = pgTable(
  "apify_settings",
  {
    organizationId: uuid("organization_id")
      .primaryKey()
      .references(() => organizations.id),
    /** The API token, encrypted like every integration credential. */
    encryptedToken: text("encrypted_token"),
    tokenHint: text("token_hint"),
    approvedActors: text("approved_actors").array().notNull().default(sql`'{}'::text[]`).$type<ApifyActorKey[]>(),
    monthlyBudgetUsd: doublePrecision("monthly_budget_usd").notNull().default(10),
    maxChargePerRunUsd: doublePrecision("max_charge_per_run_usd").notNull().default(2),
    maxResultsPerRun: integer("max_results_per_run").notNull().default(100),
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "apify_settings_limits_chk",
      sql`${table.monthlyBudgetUsd} >= 0 AND ${table.maxChargePerRunUsd} > 0 AND ${table.maxResultsPerRun} BETWEEN 1 AND 500`,
    ),
  ],
);

export type ApifyRunStatus = "starting" | "running" | "succeeded" | "partial" | "failed" | "refused";

/**
 * Every Apify run AgentSDR started (or was refused), kept for good: the
 * Apify run id survives a restart of the app (the job polls it again), and
 * the month's spend is summed from here.
 */
export const apifyRuns = pgTable(
  "apify_runs",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    id: uuid("id").primaryKey().defaultRandom(),
    /** The assistant job the run serves. */
    jobId: uuid("job_id"),
    /** The owner's request (its message id) the job serves; plans from it share its approval. */
    requestId: text("request_id"),
    actorKey: text("actor_key").notNull().$type<ApifyActorKey>(),
    actorId: text("actor_id").notNull(),
    apifyRunId: text("apify_run_id"),
    datasetId: text("dataset_id"),
    status: text("status").notNull().default("starting").$type<ApifyRunStatus>(),
    /** The cap the run was started with (maxTotalChargeUsd), counted as reserved while it is open. */
    maxChargeUsd: doublePrecision("max_charge_usd").notNull(),
    maxItems: integer("max_items").notNull(),
    /** What Apify reported the run cost (usageTotalUsd). */
    usageUsd: doublePrecision("usage_usd"),
    itemsRead: integer("items_read").notNull().default(0),
    partial: boolean("partial").notNull().default(false),
    error: text("error"),
    /** The platform's token ('managed', an Included service) or the organization's own ('own'); polled with the same one. */
    credentialSource: text("credential_source").notNull().default("own").$type<"managed" | "own">(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    unique("apify_runs_apify_run_id_uq").on(table.apifyRunId),
    index("apify_runs_org_created_idx").on(table.organizationId, table.createdAt),
    check("apify_runs_status_chk", sql`${table.status} IN ('starting', 'running', 'succeeded', 'partial', 'failed', 'refused')`),
    check("apify_runs_credential_source_chk", sql`${table.credentialSource} IN ('managed', 'own')`),
  ],
);

export type ApifyRunRow = typeof apifyRuns.$inferSelect;
