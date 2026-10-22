import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { BRIGHTDATA_USD_PER_CREDIT } from "@/lib/brightdata/catalog";
import { TINYFISH_LIMITS } from "@/lib/tinyfish/catalog";
import { ALLOWANCE_KEYS, periodReset, periodStart, type AllowanceKey } from "./allowances";
import type { ServiceMode } from "./catalog";
import { allowanceFor, allowanceUsed } from "./usage.server";

/**
 * What the operator panel shows about use: per workspace and provider, the
 * calls, units and cost of the month, for the platform's keys (Included) and
 * the workspaces' own (for context), and the platform budgets against what
 * all Included workspaces used. Reads every organization's ledger rows on
 * purpose; only the operator routes call it.
 *
 * Costs: AI as the provider reported it (OpenRouter, AI/ML API) or estimated
 * from tokens (Anthropic, or a provider that reported none); Apify as Apify
 * reported it (an open run counts its cap); Bright Data at its list price per
 * credit; TinyFish Search and Fetch are free within its allowance; Tavily is
 * priced by the account's plan, so a pay-as-you-go estimate per search is
 * used. Every figure but Apify's reported spend is labelled estimated.
 */

/** US$ per unit for providers that report no cost, by `provider:product`. */
const ESTIMATED_UNIT_USD: Record<string, number> = {
  "brightdata:records": BRIGHTDATA_USD_PER_CREDIT,
  "brightdata:serp": BRIGHTDATA_USD_PER_CREDIT,
  "tavily:search": 0.008,
  "tavily:website_search": 0.008,
  "tinyfish:browser": TINYFISH_LIMITS.browserUsdPerMinute,
};

export type UsageReportRow = {
  organizationId: string;
  organizationName: string;
  provider: string;
  product: string;
  source: ServiceMode;
  calls: number;
  units: number;
  costUsd: number;
  estimated: boolean;
};

export type UsageReport = {
  from: string;
  to: string;
  rows: UsageReportRow[];
  /** Included use against the platform budgets this period. */
  budgets: { key: AllowanceKey; label: string; unit: string; used: number; budget: number; workspaceAllowance: number; estimated: boolean }[];
};

type LedgerRow = { organization_id: string; name: string; provider: string; product: string; source: ServiceMode; calls: number; units: number; cost: number | null; estimated: boolean | null };

/** The month containing `month` (UTC). */
export async function platformUsageReport(month = new Date()): Promise<UsageReport> {
  const from = periodStart(month);
  const to = periodReset(month);
  const ledger = (await db.execute(sql`
    SELECT u.organization_id, o.name, u.provider, u.product, u.credential_source AS source,
      count(*)::int AS calls,
      coalesce(sum(CASE WHEN u.status = 'reserved' THEN u.units ELSE coalesce(u.used_units, u.units) END), 0)::float8 AS units,
      sum(u.cost_usd)::float8 AS cost,
      bool_or(coalesce((u.detail ->> 'costEstimated')::boolean, true)) AS estimated
    FROM provider_usage u JOIN organizations o ON o.id = u.organization_id
    WHERE u.created_at >= ${from.toISOString()}::timestamptz AND u.created_at < ${to.toISOString()}::timestamptz
    GROUP BY u.organization_id, o.name, u.provider, u.product, u.credential_source`)) as unknown as LedgerRow[];
  const apify = (await db.execute(sql`
    SELECT r.organization_id, o.name, 'apify' AS provider, 'runs' AS product, r.credential_source AS source,
      count(*)::int AS calls,
      coalesce(sum(r.items_read), 0)::float8 AS units,
      coalesce(sum(CASE WHEN r.status IN ('starting', 'running') THEN r.max_charge_usd ELSE coalesce(r.usage_usd, 0) END), 0)::float8 AS cost,
      bool_or(r.status IN ('starting', 'running')) AS estimated
    FROM apify_runs r JOIN organizations o ON o.id = r.organization_id
    WHERE r.created_at >= ${from.toISOString()}::timestamptz AND r.created_at < ${to.toISOString()}::timestamptz AND r.status <> 'refused'
    GROUP BY r.organization_id, o.name, r.credential_source`)) as unknown as LedgerRow[];
  const rows: UsageReportRow[] = [...ledger, ...apify].map((row) => {
    const rate = ESTIMATED_UNIT_USD[`${row.provider}:${row.product}`];
    const costUsd = row.cost ?? (rate ? row.units * rate : 0);
    return {
      organizationId: row.organization_id,
      organizationName: row.name,
      provider: row.provider,
      product: row.product,
      source: row.source,
      calls: Number(row.calls),
      units: Number(row.units),
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
      estimated: row.provider === "apify" ? Boolean(row.estimated) : row.cost === null ? Boolean(rate) : Boolean(row.estimated),
    };
  }).sort((a, b) => a.organizationName.localeCompare(b.organizationName) || a.provider.localeCompare(b.provider) || a.product.localeCompare(b.product));
  const budgets = [];
  for (const key of ALLOWANCE_KEYS) {
    const allowance = allowanceFor(key);
    budgets.push({
      key,
      label: allowance.label,
      unit: allowance.unit,
      used: await allowanceUsed(db, key, null, month),
      budget: allowance.platform,
      workspaceAllowance: allowance.workspace,
      estimated: allowance.estimated,
    });
  }
  return { from: from.toISOString(), to: to.toISOString(), rows, budgets };
}
