import "server-only";

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { EMPTY_COUNTERS, quotaDecision, released, rolled, windowStarts, type QuotaCounters, type QuotaLimits } from "./quota";
import { providerQuotaState, providerUsage, type ProviderUsageStatus } from "./schema";
import type { AllowanceKey } from "@/lib/managed/allowances";
import { checkManagedAllowance } from "@/lib/managed/usage.server";

/**
 * Reserve, then settle: every metered or rate-limited provider call takes
 * its units from the scope's quota under that row's lock before the call,
 * records them in the organization's ledger, and gives back what was not
 * used afterwards. A wait the provider imposes (blockQuota) holds every
 * caller sharing the scope until it passes.
 */

type Executor = Pick<typeof db, "select" | "insert" | "update" | "execute">;
type StateRow = typeof providerQuotaState.$inferSelect;

function countersOf(row: StateRow | undefined): QuotaCounters {
  if (!row) return EMPTY_COUNTERS;
  return {
    minuteStart: row.minuteStart, minuteUsed: row.minuteUsed,
    hourStart: row.hourStart, hourUsed: row.hourUsed,
    dayStart: row.dayStart, dayUsed: row.dayUsed,
    blockedUntil: row.blockedUntil, blockedReason: row.blockedReason,
  };
}

async function lockedState(tx: Executor, scopeKey: string, product: string): Promise<QuotaCounters> {
  await tx.insert(providerQuotaState).values({ scopeKey, product }).onConflictDoNothing();
  const [row] = await tx.select().from(providerQuotaState)
    .where(and(eq(providerQuotaState.scopeKey, scopeKey), eq(providerQuotaState.product, product)))
    .for("update");
  return countersOf(row);
}

async function writeState(tx: Executor, scopeKey: string, product: string, counters: QuotaCounters): Promise<void> {
  await tx.update(providerQuotaState).set({ ...counters, updatedAt: new Date() })
    .where(and(eq(providerQuotaState.scopeKey, scopeKey), eq(providerQuotaState.product, product)));
}

export type QuotaReservation =
  | { ok: true; usageId: string; reservedAt: Date }
  /** `allowance`: an Included service's monthly allowance or the platform budget refused it (until is its reset). */
  | { ok: false; until: Date; reason: string; allowance?: AllowanceKey };

export type ReserveInput = {
  provider: string;
  /** The provider's product, e.g. search; the quota row is `${provider}:${product}`. */
  product: string;
  /** The provider's quota scope (a hash of the key); null when only the ledger applies. */
  scopeKey: string | null;
  units: number;
  limits: QuotaLimits;
  /** The provider's name in reasons, e.g. "TinyFish Search". */
  label: string;
  jobId?: string | null;
  threadId?: string | null;
  detail?: Record<string, unknown>;
  now?: Date;
  /**
   * A further check in the same transaction, before anything is taken: the
   * request's spend cap for paid work (objective.server.ts). A reason refuses
   * the reservation.
   */
  guard?: (tx: Pick<typeof db, "select" | "execute">) => Promise<string | null>;
  /** Whose credentials do the work; recorded on the row. Default 'own'. */
  credentialSource?: "managed" | "own";
  /**
   * An Included service (credentialSource 'managed'): `amount` of this
   * allowance is checked against the workspace allowance and the platform
   * budget under the allowance's platform-wide lock, in this transaction,
   * after `guard` (src/lib/managed/usage.server.ts).
   */
  managed?: { allowance: AllowanceKey; amount: number };
  /** US$ held while reserved, when the amount is money. */
  costUsd?: number | null;
};

/** Takes `units` from the scope's quota and opens a ledger row, or says until when to wait. */
export async function reserveQuota(input: ReserveInput): Promise<QuotaReservation> {
  const now = input.now ?? new Date();
  const product = `${input.provider}:${input.product}`;
  return db.transaction(async (tx) => {
    const refused = input.guard ? await input.guard(tx) : null;
    if (refused) return { ok: false, until: now, reason: refused } as const;
    if (input.managed) {
      const over = await checkManagedAllowance(tx, input.managed.allowance, input.managed.amount, now);
      if (over) return { ok: false, until: over.resetsAt ?? new Date(8.64e15), reason: over.message, allowance: input.managed.allowance } as const;
    }
    if (input.scopeKey) {
      const decision = quotaDecision(await lockedState(tx, input.scopeKey, product), input.limits, input.units, now, input.label);
      if (!decision.ok) return decision;
      await writeState(tx, input.scopeKey, product, decision.counters);
    }
    const [row] = await tx.insert(providerUsage).values({
      organizationId: currentOrganizationId(),
      provider: input.provider,
      product: input.product,
      scopeKey: input.scopeKey,
      units: input.units,
      status: "reserved",
      jobId: input.jobId ?? null,
      threadId: input.threadId ?? null,
      detail: input.detail ?? null,
      credentialSource: input.credentialSource ?? (input.managed ? "managed" : "own"),
      costUsd: input.costUsd === undefined || input.costUsd === null ? null : input.costUsd.toFixed(6),
      createdAt: now,
    }).returning({ id: providerUsage.id });
    return { ok: true, usageId: row!.id, reservedAt: now } as const;
  });
}

/**
 * Closes a ledger row with what was really used; unused units go back to
 * the quota. Settling twice changes nothing. `uncertain` keeps every
 * reserved unit counted: the provider may have done the work.
 */
export async function settleQuota(usageId: string, outcome: { status: Exclude<ProviderUsageStatus, "reserved">; usedUnits: number; error?: string | null; detail?: Record<string, unknown>; costUsd?: number | null }): Promise<void> {
  await db.transaction(async (tx) => {
    const [usage] = await tx.select().from(providerUsage).where(and(inOrg(providerUsage), eq(providerUsage.id, usageId))).for("update");
    if (!usage || usage.status !== "reserved") return;
    const used = outcome.status === "uncertain" ? usage.units : Math.max(0, Math.min(usage.units, outcome.usedUnits));
    if (usage.scopeKey && used < usage.units) {
      const product = `${usage.provider}:${usage.product}`;
      const counters = await lockedState(tx, usage.scopeKey, product);
      await writeState(tx, usage.scopeKey, product, released(counters, usage.units - used, usage.createdAt));
    }
    await tx.update(providerUsage).set({
      status: outcome.status,
      usedUnits: used,
      error: outcome.error?.slice(0, 500) ?? null,
      ...(outcome.detail ? { detail: { ...(usage.detail ?? {}), ...outcome.detail } } : {}),
      ...(outcome.costUsd === undefined ? {} : { costUsd: outcome.costUsd === null ? null : outcome.costUsd.toFixed(6) }),
      settledAt: new Date(),
    }).where(and(inOrg(providerUsage), eq(providerUsage.id, usageId)));
  });
}

/** Records a wait the provider imposed on the whole scope (a rate limit, a used-up daily allowance). */
export async function blockQuota(scopeKey: string, provider: string, product: string, until: Date, reason: string): Promise<void> {
  const key = `${provider}:${product}`;
  // Raw SQL takes the time as text; the driver only converts Dates for typed columns.
  const at = sql`${until.toISOString()}::timestamptz`;
  await db.insert(providerQuotaState).values({ scopeKey, product: key, blockedUntil: until, blockedReason: reason })
    .onConflictDoUpdate({
      target: [providerQuotaState.scopeKey, providerQuotaState.product],
      set: {
        // Never shorten a longer wait another caller recorded.
        blockedUntil: sql`greatest(coalesce(${providerQuotaState.blockedUntil}, ${at}), ${at})`,
        blockedReason: sql`case when coalesce(${providerQuotaState.blockedUntil}, ${at}) > ${at} then ${providerQuotaState.blockedReason} else ${reason} end`,
        updatedAt: new Date(),
      },
    });
}

/** The scope's counters as of now (read-only). */
export async function quotaState(scopeKey: string, provider: string, product: string, now = new Date()): Promise<QuotaCounters> {
  const [row] = await db.select().from(providerQuotaState)
    .where(and(eq(providerQuotaState.scopeKey, scopeKey), eq(providerQuotaState.product, `${provider}:${product}`)));
  return rolled(countersOf(row), now);
}

/** Units the organization used of one product since the start of today (UTC); reserved rows count in full. */
export async function usedToday(provider: string, product: string, now = new Date()): Promise<number> {
  const [row] = await db.select({
    n: sql<number>`coalesce(sum(coalesce(${providerUsage.usedUnits}, ${providerUsage.units})), 0)::int`,
  }).from(providerUsage).where(and(
    inOrg(providerUsage),
    eq(providerUsage.provider, provider),
    eq(providerUsage.product, product),
    gte(providerUsage.createdAt, windowStarts(now).day),
  ));
  return Number(row?.n ?? 0);
}
