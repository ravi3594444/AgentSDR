import "server-only";

import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { providerUsage } from "@/lib/quota/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { ALLOWANCES, MANAGED_LIMITS, allowanceDecision, periodReset, periodStart, type AllowanceKey } from "./allowances";
import type { ManagedAiEngine, ServiceMode } from "./catalog";

/**
 * Counting Included use against the allowances (allowances.ts).
 *
 * Every Included reservation calls `checkManagedAllowance` inside the same
 * transaction that records it, after taking a platform-wide advisory lock
 * for that allowance. While the lock is held no other workspace can reserve
 * the same allowance, and the sums read after taking it include every
 * reservation committed before, so concurrent jobs, in one workspace or
 * many, cannot pass the workspace allowance or the platform budget.
 *
 * The counts come from the ledgers the providers already keep, filtered to
 * credential_source = 'managed': provider_usage (AI, TinyFish, Tavily, Bright
 * Data), apify_runs and unipile_account_owners. A reserved row counts in
 * full; an uncertain one (a lost answer) stays counted. The platform sums
 * read every organization's rows on purpose: they are the platform's own
 * budget, and only totals leave this module.
 */

type Executor = Pick<typeof db, "execute">;

type AllowanceOverride = { workspace?: number; platform?: number };
let overrides: Partial<Record<AllowanceKey, AllowanceOverride>> = {};

/**
 * e2e only: smaller allowances, so a test can reach them with a handful of
 * calls. In-process; nothing reads it from the environment.
 */
export function setAllowanceOverridesForTests(next: Partial<Record<AllowanceKey, AllowanceOverride>>): void {
  overrides = next;
}

/** The allowance in force (the registry's, unless a test set smaller numbers). */
export function allowanceFor(key: AllowanceKey): (typeof ALLOWANCES)[AllowanceKey] {
  return { ...ALLOWANCES[key], ...overrides[key] };
}

export class ManagedAllowanceError extends Error {
  constructor(
    message: string,
    readonly allowance: AllowanceKey,
    readonly resetsAt: Date | null,
  ) {
    super(message);
    this.name = "ManagedAllowanceError";
  }
}

export function isManagedAllowanceError(error: unknown): error is ManagedAllowanceError {
  return error instanceof ManagedAllowanceError;
}

function isMissingTable(error: unknown): boolean {
  for (let current: unknown = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === "42P01") return true;
  }
  return false;
}

/** The SQL that sums one allowance's Included use this period, for one organization or (null) for the platform. */
function usageQuery(key: AllowanceKey, organizationId: string | null, since: Date): SQL {
  const org = organizationId ? sql` AND organization_id = ${organizationId}::uuid` : sql``;
  const at = since.toISOString();
  const ledger = (provider: string, products: string[] | null, measure: SQL) => sql`
    SELECT coalesce(sum(${measure}), 0)::float8 AS used FROM provider_usage
    WHERE provider = ${provider} AND credential_source = 'managed' AND created_at >= ${at}::timestamptz
    ${products ? sql` AND product IN (${sql.join(products.map((product) => sql`${product}`), sql`, `)})` : sql``}${org}`;
  const units = sql`CASE WHEN status = 'reserved' THEN units ELSE coalesce(used_units, units) END`;
  switch (key) {
    case "ai_usd":
      return ledger("ai", null, sql`coalesce(cost_usd, 0)`);
    case "tinyfish_search":
      return ledger("tinyfish", ["search"], units);
    case "tinyfish_fetch":
      return ledger("tinyfish", ["fetch"], units);
    case "tavily_search":
      return ledger("tavily", null, units);
    case "brightdata_credits":
      return ledger("brightdata", null, units);
    case "apify_usd":
      return sql`
        SELECT coalesce(sum(CASE WHEN status IN ('starting', 'running') THEN max_charge_usd ELSE coalesce(usage_usd, 0) END), 0)::float8 AS used
        FROM apify_runs WHERE credential_source = 'managed' AND created_at >= ${at}::timestamptz${org}`;
    case "unipile_linkedin":
    case "unipile_whatsapp":
    case "unipile_instagram":
    case "unipile_email": {
      const channel = key.slice("unipile_".length);
      return sql`
        SELECT count(*)::float8 AS used FROM unipile_account_owners
        WHERE channel = ${channel} AND credential_source = 'managed' AND status = 'active'${org}`;
    }
  }
}

/** Included use of one allowance this period: the organization's, or the whole platform's (null). */
export async function allowanceUsed(executor: Executor, key: AllowanceKey, organizationId: string | null, now = new Date()): Promise<number> {
  const since = ALLOWANCES[key].period === "month" ? periodStart(now) : new Date(0);
  try {
    const rows = (await executor.execute(usageQuery(key, organizationId, since))) as unknown as { used: number }[];
    return Number(rows[0]?.used ?? 0);
  } catch (error) {
    // Before the migration that adds a ledger (or its column) nothing Included has been used.
    if (isMissingTable(error) || (error as { code?: unknown })?.code === "42703") return 0;
    throw error;
  }
}

/**
 * Inside a reservation transaction: takes the allowance's platform-wide
 * lock, then refuses when `amount` more would pass the workspace allowance or
 * the platform budget. Null when it fits.
 */
export async function checkManagedAllowance(tx: Executor, key: AllowanceKey, amount: number, now = new Date()): Promise<ManagedAllowanceError | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`managed-allowance:${key}`}, 0))`);
  const workspace = await allowanceUsed(tx, key, currentOrganizationId(), now);
  const platform = await allowanceUsed(tx, key, null, now);
  const decision = allowanceDecision(allowanceFor(key), { workspace, platform }, amount, now);
  return decision.ok ? null : new ManagedAllowanceError(decision.reason, key, decision.resetsAt);
}

// ── AI calls ────────────────────────────────────────────────────────────────

/** US$ per million tokens assumed for a call whose provider reported no cost: deliberately high, and labelled estimated. */
const UNKNOWN_PRICE = { input: 5, output: 25 };

export type AiCallMeta = { source: ServiceMode; engine: ManagedAiEngine | "openrouter" | "aimlapi"; model: string };

/**
 * Before a model call: one provider_usage row (provider 'ai'), and for an
 * Included workspace the AI allowance checked with a fixed reservation per
 * call. Throws ManagedAllowanceError when the allowance is used up (nothing
 * is sent).
 */
export async function reserveAiCall(meta: AiCallMeta): Promise<string> {
  return db.transaction(async (tx) => {
    // A subscription call has no per-call dollar price. Its actual CLI windows
    // and shared account queue enforce capacity; still attribute calls/tokens.
    const reserve = meta.source === "managed" && meta.engine !== "claude-code" ? MANAGED_LIMITS.aiReservePerCallUsd : null;
    if (reserve !== null) {
      const refused = await checkManagedAllowance(tx, "ai_usd", reserve);
      if (refused) throw refused;
    }
    const [row] = await tx.insert(providerUsage).values({
      organizationId: currentOrganizationId(),
      provider: "ai",
      product: meta.engine,
      scopeKey: null,
      units: 1,
      status: "reserved",
      credentialSource: meta.source,
      costUsd: reserve === null ? null : reserve.toFixed(6),
      detail: { model: meta.model.slice(0, 200), ...(meta.engine === "claude-code" ? { billing: "claude_account", sharedLimits: true } : {}), ...(reserve === null ? {} : { reservedUsd: reserve }) },
    }).returning({ id: providerUsage.id });
    return row!.id;
  });
}

/** The cost of one call: what the provider reported, else an estimate from its tokens (labelled). */
export function aiCallCost(response: unknown, reported: number | null): { costUsd: number | null; estimated: boolean } {
  if (reported !== null && Number.isFinite(reported)) return { costUsd: reported, estimated: false };
  const usage = (response as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  const input = Number(usage?.prompt_tokens ?? 0);
  const output = Number(usage?.completion_tokens ?? 0);
  if (!input && !output) return { costUsd: null, estimated: true };
  return { costUsd: Math.round(((input * UNKNOWN_PRICE.input + output * UNKNOWN_PRICE.output) / 1_000_000) * 1_000_000) / 1_000_000, estimated: true };
}

/**
 * After the call. A failure the provider answered (a 4xx/5xx) used nothing;
 * a call whose answer was lost stays at its reservation ("uncertain"), since
 * the provider may have run it. Settling twice changes nothing.
 */
export async function settleAiCall(usageId: string, outcome: { status: "settled" | "failed" | "uncertain"; costUsd?: number | null; estimated?: boolean; error?: string | null; tokens?: { input?: number; output?: number } }): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(providerUsage).where(and(inOrg(providerUsage), eq(providerUsage.id, usageId))).for("update");
    if (!row || row.status !== "reserved") return;
    const cost = outcome.status === "uncertain" ? (row.costUsd === null ? null : Number(row.costUsd)) : outcome.status === "failed" ? 0 : (outcome.costUsd ?? null);
    await tx.update(providerUsage).set({
      status: outcome.status,
      usedUnits: outcome.status === "failed" ? 0 : 1,
      costUsd: cost === null ? null : cost.toFixed(6),
      error: outcome.error?.slice(0, 500) ?? null,
      detail: { ...(row.detail ?? {}), costEstimated: outcome.estimated ?? true, ...(outcome.tokens ? { tokens: outcome.tokens } : {}) },
      settledAt: new Date(),
    }).where(and(inOrg(providerUsage), eq(providerUsage.id, usageId)));
  });
}

// ── What a workspace sees ───────────────────────────────────────────────────

export type WorkspaceAllowanceView = {
  key: AllowanceKey;
  label: string;
  unit: (typeof ALLOWANCES)[AllowanceKey]["unit"];
  used: number;
  limit: number;
  remaining: number;
  /** ISO date the allowance resets, or null for a standing count. */
  resetsAt: string | null;
  estimated: boolean;
};

/** The organization in scope's Included allowances: used, left, reset date. Never the platform's figures. */
export async function workspaceAllowances(keys: readonly AllowanceKey[], now = new Date()): Promise<WorkspaceAllowanceView[]> {
  const organizationId = currentOrganizationId();
  const views: WorkspaceAllowanceView[] = [];
  for (const key of keys) {
    const allowance = allowanceFor(key);
    const used = await allowanceUsed(db, key, organizationId, now);
    views.push({
      key,
      label: allowance.label,
      unit: allowance.unit,
      used,
      limit: allowance.workspace,
      remaining: Math.max(0, allowance.workspace - used),
      resetsAt: allowance.period === "month" ? periodReset(now).toISOString() : null,
      estimated: allowance.estimated,
    });
  }
  return views;
}
