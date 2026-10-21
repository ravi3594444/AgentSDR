import "server-only";

import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { featureEnabled, isMissingTable } from "@/lib/features/flags.server";
import { decryptIntegrationCredential, encryptIntegrationCredential } from "@/lib/integrations/credentials";
import { providerUsage } from "@/lib/quota/schema";
import { reserveQuota, settleQuota } from "@/lib/quota/quota.server";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import {
  BrightdataError,
  cancelSnapshot,
  downloadSnapshot,
  serpSearch,
  snapshotProgress,
  triggerCollection,
  verifyBrightdataKey,
  type SerpResult,
} from "@/services/brightdata";
import {
  BRIGHTDATA_DATASETS,
  BRIGHTDATA_DATASET_KEYS,
  BRIGHTDATA_LIMITS,
  BRIGHTDATA_USD_PER_CREDIT,
  type BrightdataDatasetKey,
  type BrightdataSettingsView,
} from "./catalog";
import { collectionKey, creditsUsed, errorKind, progressOutcome, reservedCredits } from "./mapping";
import { brightdataSettings } from "./schema";
import type { SpendGuard } from "@/lib/assistant/objective.server";

/**
 * The organization's Bright Data connection and its collections. Every
 * collection is a row of the shared usage ledger (provider_usage, provider
 * "brightdata"), reserved at the most credits it can take before Bright Data
 * is called, under the organization's lock and the request's spend guard, so
 * two jobs cannot both take the last of the monthly limit; settled from the
 * records Bright Data reports once it is ready. A trigger whose answer was
 * lost stays counted ("uncertain") and is never sent again. A collection a
 * retried step finds already started is polled, not paid for twice; one
 * with the same inputs settled recently is downloaded again for free.
 *
 * Bright Data's API does not say how many credits are left, so the limit
 * here is AgentSDR's own count of delivered records, and the card says so.
 * Nothing here tops up, upgrades or changes a plan or zone.
 */

export const BRIGHTDATA_PROVIDER = "brightdata";
/** Ledger products: one credit per delivered record, one per SERP request. */
export const RECORDS_PRODUCT = "records";
export const SERP_PRODUCT = "serp";

export class BrightdataSettingsError extends Error {}

type SettingsRow = typeof brightdataSettings.$inferSelect;
type UsageRow = typeof providerUsage.$inferSelect;

async function settingsRow(): Promise<SettingsRow | null> {
  try {
    const [row] = await db.select().from(brightdataSettings).where(inOrg(brightdataSettings)).limit(1);
    return row ?? null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** This month's credits (UTC): what finished collections used, and what open ones hold. Uncertain rows count as used. */
async function monthUsage(executor: Pick<typeof db, "select"> = db): Promise<{ used: number; reserved: number; open: number }> {
  const [row] = await executor.select({
    used: sql<number>`coalesce(sum(case when ${providerUsage.status} = 'reserved' then 0 else coalesce(${providerUsage.usedUnits}, ${providerUsage.units}) end), 0)::int`,
    reserved: sql<number>`coalesce(sum(case when ${providerUsage.status} = 'reserved' then ${providerUsage.units} else 0 end), 0)::int`,
    open: sql<number>`count(*) filter (where ${providerUsage.status} = 'reserved')::int`,
  }).from(providerUsage).where(and(inOrg(providerUsage), eq(providerUsage.provider, BRIGHTDATA_PROVIDER), gte(providerUsage.createdAt, monthStart())));
  return { used: Number(row?.used ?? 0), reserved: Number(row?.reserved ?? 0), open: Number(row?.open ?? 0) };
}

/** What each dataset's last collection here showed; a dataset never collected is "unused", not "works". */
async function datasetStates(): Promise<BrightdataSettingsView["datasets"]> {
  const rows = await db.select({ status: providerUsage.status, usedUnits: providerUsage.usedUnits, detail: providerUsage.detail, error: providerUsage.error, createdAt: providerUsage.createdAt })
    .from(providerUsage)
    .where(and(inOrg(providerUsage), eq(providerUsage.provider, BRIGHTDATA_PROVIDER), eq(providerUsage.product, RECORDS_PRODUCT), inArray(providerUsage.status, ["settled", "failed"])))
    .orderBy(desc(providerUsage.createdAt)).limit(200);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const dataset = String(row.detail?.dataset ?? "");
    if (dataset && !latest.has(dataset)) latest.set(dataset, row);
  }
  return BRIGHTDATA_DATASET_KEYS.map((key) => {
    const row = latest.get(key);
    if (!row) return { key, label: BRIGHTDATA_DATASETS[key].label, state: "unused" as const, at: null, detail: null };
    const records = Number(row.detail?.records ?? 0);
    const failed = row.status === "failed" || !records;
    return {
      key,
      label: BRIGHTDATA_DATASETS[key].label,
      state: failed ? "failed" as const : "verified" as const,
      at: row.createdAt.toISOString(),
      detail: failed ? (row.error ?? (row.detail?.errors ? `${row.detail.errors} input(s) failed, no records` : "no records returned")).slice(0, 200) : `${records} record${records === 1 ? "" : "s"} returned`,
    };
  });
}

export async function brightdataSettingsView(): Promise<BrightdataSettingsView> {
  const row = await settingsRow();
  const usage = row ? await monthUsage() : { used: 0, reserved: 0, open: 0 };
  return {
    connected: Boolean(row?.encryptedKey),
    keyHint: row?.keyHint ?? null,
    monthlyCredits: row?.monthlyCredits ?? BRIGHTDATA_LIMITS.monthlyCredits.default,
    maxRecordsPerSearch: row?.maxRecordsPerSearch ?? BRIGHTDATA_LIMITS.maxRecordsPerSearch.default,
    serpZone: row?.serpZone ?? null,
    redditEnabled: row?.redditEnabled ?? false,
    usedThisMonth: usage.used,
    reservedThisMonth: usage.reserved,
    datasets: row ? await datasetStates() : [],
  };
}

function bounded(value: unknown, limit: { min: number; max: number }, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < limit.min || number > limit.max) throw new BrightdataSettingsError(`${label} must be a whole number from ${limit.min} to ${limit.max}`);
  return number;
}

/** Saves the connection. A new key is checked with Bright Data first (a free listing call); an empty key disconnects. */
export async function saveBrightdataSettings(
  input: { key?: unknown; monthlyCredits?: unknown; maxRecordsPerSearch?: unknown; serpZone?: unknown; redditEnabled?: unknown },
  userId: string | null,
): Promise<BrightdataSettingsView> {
  const current = await settingsRow();
  const monthlyCredits = input.monthlyCredits === undefined ? current?.monthlyCredits ?? BRIGHTDATA_LIMITS.monthlyCredits.default : bounded(input.monthlyCredits, BRIGHTDATA_LIMITS.monthlyCredits, "Credits a month");
  const maxRecordsPerSearch = input.maxRecordsPerSearch === undefined ? current?.maxRecordsPerSearch ?? BRIGHTDATA_LIMITS.maxRecordsPerSearch.default : bounded(input.maxRecordsPerSearch, BRIGHTDATA_LIMITS.maxRecordsPerSearch, "Records per search");
  let serpZone = current?.serpZone ?? null;
  if (input.serpZone !== undefined) {
    const zone = typeof input.serpZone === "string" ? input.serpZone.trim() : "";
    if (zone && !/^[a-z0-9_]{1,63}$/i.test(zone)) throw new BrightdataSettingsError("A zone name is letters, digits and underscores.");
    serpZone = zone || null;
  }
  if (input.redditEnabled !== undefined && typeof input.redditEnabled !== "boolean") throw new BrightdataSettingsError("redditEnabled must be true or false");
  const redditEnabled = input.redditEnabled === undefined ? current?.redditEnabled ?? false : input.redditEnabled;
  let encryptedKey = current?.encryptedKey ?? null;
  let keyHint = current?.keyHint ?? null;
  if (typeof input.key === "string") {
    const key = input.key.trim();
    if (!key) {
      encryptedKey = null;
      keyHint = null;
    } else {
      if (key.length > 300 || /\s/.test(key)) throw new BrightdataSettingsError("That does not look like a Bright Data key.");
      try {
        await verifyBrightdataKey(key);
      } catch (error) {
        throw new BrightdataSettingsError(error instanceof BrightdataError && (error.status === 401 || error.status === 403) ? "Bright Data rejected this key." : `The key could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      }
      encryptedKey = encryptIntegrationCredential(key);
      keyHint = `…${key.slice(-4)}`;
    }
  }
  const values = { encryptedKey, keyHint, monthlyCredits, maxRecordsPerSearch, serpZone, redditEnabled, updatedBy: userId, updatedAt: new Date() };
  await db.insert(brightdataSettings).values({ organizationId: currentOrganizationId(), ...values })
    .onConflictDoUpdate({ target: brightdataSettings.organizationId, set: values });
  return brightdataSettingsView();
}

export type BrightdataReadiness =
  | { usable: true; key: string; settings: SettingsRow; creditsLeft: number }
  | { usable: false; exhausted: boolean; reason: string };

/**
 * Whether Bright Data may be used now: the feature on, a key saved, and
 * credits left of the owner's monthly limit (this month's used and held
 * ones counted). Writes nothing but the closing of stale collections.
 */
export async function brightdataReadiness(): Promise<BrightdataReadiness> {
  if (!(await featureEnabled("brightdata"))) return { usable: false, exhausted: false, reason: "Bright Data research is off for this organization (Settings → Providers & features)" };
  const row = await settingsRow();
  if (!row?.encryptedKey) return { usable: false, exhausted: false, reason: "no Bright Data key is saved (Settings → Providers & features → Bright Data)" };
  await sweepStaleCollections();
  const usage = await monthUsage();
  const left = row.monthlyCredits - usage.used - usage.reserved;
  if (left < 1) return { usable: false, exhausted: true, reason: `this month's Bright Data limit (${row.monthlyCredits.toLocaleString("en-US")} credits, estimated from delivered records) is used up; owners and admins can raise it` };
  return { usable: true, key: decryptIntegrationCredential(row.encryptedKey), settings: row, creditsLeft: left };
}

/** The saved key, for polling a collection already started. */
async function savedKey(): Promise<string | null> {
  const row = await settingsRow();
  return row?.encryptedKey ? decryptIntegrationCredential(row.encryptedKey) : null;
}

/**
 * Collections nothing polls any more (the job that started them stopped)
 * would hold their credits until the month ends. One still reserved well
 * past the time a job waits is closed as uncertain: Bright Data may have
 * delivered it, so its reserved credits stay counted.
 */
export async function sweepStaleCollections(): Promise<number> {
  const cutoff = new Date(Date.now() - (BRIGHTDATA_LIMITS.collectionTimeoutMinutes + 15) * 60_000);
  const swept = await db.update(providerUsage)
    .set({ status: "uncertain", usedUnits: sql`${providerUsage.units}`, error: "No longer tracked: the job that started it stopped polling; its reserved credits stay counted.", settledAt: new Date() })
    .where(and(inOrg(providerUsage), eq(providerUsage.provider, BRIGHTDATA_PROVIDER), eq(providerUsage.status, "reserved"), lt(providerUsage.createdAt, cutoff)))
    .returning({ id: providerUsage.id });
  return swept.length;
}

// ── Collections ──────────────────────────────────────────────────────────────

export type CollectionSpec = {
  dataset: BrightdataDatasetKey;
  /** Discovery by this method; null collects the inputs' URLs. */
  discoverBy: "keyword" | "subreddit_url" | null;
  inputs: Record<string, unknown>[];
  /** Records per input for discovery (its reserved credits), null otherwise. */
  limitPerInput: number | null;
};

/** `budget`: the request's own spend cap refused it; `wait`: ask again later (a rate limit, a paused request). */
export type StartedCollection =
  | { started: true; usageId: string; snapshotId: string; reused: boolean; reservedCredits: number }
  | { started: false; wait: boolean; exhausted: boolean; budget?: boolean; reason: string };

async function usageRow(usageId: string): Promise<UsageRow | null> {
  const [row] = await db.select().from(providerUsage).where(and(inOrg(providerUsage), eq(providerUsage.id, usageId))).limit(1);
  return row ?? null;
}

async function patchDetail(usageId: string, patch: Record<string, unknown>): Promise<void> {
  await db.update(providerUsage)
    .set({ detail: sql`coalesce(${providerUsage.detail}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(and(inOrg(providerUsage), eq(providerUsage.id, usageId)));
}

/** The job's own collection with this key, whatever its state (a retried step finds what its first attempt did). */
async function jobCollection(jobId: string, key: string): Promise<UsageRow | null> {
  const [row] = await db.select().from(providerUsage)
    .where(and(inOrg(providerUsage), eq(providerUsage.jobId, jobId), eq(providerUsage.provider, BRIGHTDATA_PROVIDER), eq(providerUsage.product, RECORDS_PRODUCT), sql`${providerUsage.detail} ->> 'collectionKey' = ${key}`))
    .orderBy(desc(providerUsage.createdAt)).limit(1);
  return row ?? null;
}

/** A settled collection of this organization with the same inputs, recent enough to download again for free. */
async function reusableCollection(key: string): Promise<UsageRow | null> {
  const since = new Date(Date.now() - BRIGHTDATA_LIMITS.reuseDays * 24 * 60 * 60_000);
  const [row] = await db.select().from(providerUsage)
    .where(and(
      inOrg(providerUsage), eq(providerUsage.provider, BRIGHTDATA_PROVIDER), eq(providerUsage.product, RECORDS_PRODUCT), eq(providerUsage.status, "settled"),
      gte(providerUsage.createdAt, since), sql`${providerUsage.detail} ->> 'collectionKey' = ${key}`, sql`${providerUsage.detail} ->> 'snapshotId' is not null`, sql`coalesce((${providerUsage.detail} ->> 'records')::int, 0) > 0`,
    ))
    .orderBy(desc(providerUsage.createdAt)).limit(1);
  return row ?? null;
}

/**
 * Starts one collection for a job: the request's cap and the owner's
 * monthly limit checked under the organization's lock, the credits
 * reserved, then Bright Data called. A refusal (limits, a rejected key,
 * bad inputs) closes the row as failed with nothing used.
 */
export async function startCollection(input: {
  spec: CollectionSpec;
  jobId: string;
  /** The owner's request the job serves (kept on the row, for its spend). */
  requestId: string | null;
  threadId?: string | null;
  spendGuard?: SpendGuard;
}): Promise<StartedCollection> {
  const { spec } = input;
  const key = collectionKey(spec.dataset, spec.discoverBy, spec.inputs, spec.limitPerInput);
  const units = reservedCredits(spec.discoverBy, spec.inputs, spec.limitPerInput);
  // A retried step finds the collection its first attempt started rather than paying for a second.
  const own = await jobCollection(input.jobId, key);
  if (own) {
    const snapshotId = typeof own.detail?.snapshotId === "string" ? own.detail.snapshotId : null;
    if (own.status === "reserved" && snapshotId) return { started: true, usageId: own.id, snapshotId, reused: false, reservedCredits: own.units };
    if (own.status === "settled" && snapshotId) return { started: true, usageId: own.id, snapshotId, reused: true, reservedCredits: 0 };
    // Reserved and then the answer was lost (or swept): Bright Data may have run it. Never sent twice.
    if (own.status === "reserved" || own.status === "uncertain") {
      return { started: false, wait: false, exhausted: false, reason: "an earlier attempt to start this Bright Data collection lost its answer, so it may have run; it is not sent again, and its reserved credits stay counted" };
    }
    return { started: false, wait: false, exhausted: false, reason: `an earlier attempt's collection failed (${own.error ?? "no reason given"}); it is not paid for again` };
  }
  const readiness = await brightdataReadiness();
  if (!readiness.usable) return { started: false, wait: false, exhausted: readiness.exhausted, reason: readiness.reason };
  // The same inputs settled recently, for this or another job: the snapshot is downloaded again, free.
  const reusable = await reusableCollection(key);
  if (reusable) {
    const snapshotId = String(reusable.detail!.snapshotId);
    const [row] = await db.insert(providerUsage).values({
      organizationId: currentOrganizationId(), provider: BRIGHTDATA_PROVIDER, product: RECORDS_PRODUCT, scopeKey: null, units: 0, usedUnits: 0, status: "settled",
      jobId: input.jobId, threadId: input.threadId ?? null, settledAt: new Date(),
      detail: { dataset: spec.dataset, method: spec.discoverBy, collectionKey: key, snapshotId, reusedFrom: reusable.id, records: reusable.detail?.records ?? null, ...(input.requestId ? { requestId: input.requestId } : {}) },
    }).returning({ id: providerUsage.id });
    return { started: true, usageId: row!.id, snapshotId, reused: true, reservedCredits: 0 };
  }
  let hold: { wait: boolean; budget: boolean; exhausted: boolean } = { wait: false, budget: false, exhausted: false };
  const reservation = await reserveQuota({
    provider: BRIGHTDATA_PROVIDER, product: RECORDS_PRODUCT, scopeKey: null, units, limits: {}, label: "Bright Data",
    jobId: input.jobId, threadId: input.threadId ?? null,
    detail: { dataset: spec.dataset, method: spec.discoverBy, inputs: spec.inputs.slice(0, 20), limitPerInput: spec.limitPerInput, collectionKey: key, ...(input.requestId ? { requestId: input.requestId } : {}) },
    guard: async (tx) => {
      // The owner's monthly limit, checked again under the organization's lock with every open reservation…
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`brightdata-start:${currentOrganizationId()}`}, 0))`);
      const usage = await monthUsage(tx);
      const left = readiness.settings.monthlyCredits - usage.used - usage.reserved;
      if (left < units) {
        hold = { wait: false, budget: false, exhausted: left < 1 };
        return left < 1
          ? `this month's Bright Data limit (${readiness.settings.monthlyCredits.toLocaleString("en-US")} credits) is used up`
          : `this collection could take ${units} credits and only ${left} of this month's Bright Data limit are left`;
      }
      if (usage.open >= BRIGHTDATA_LIMITS.openCollections) {
        hold = { wait: true, budget: false, exhausted: false };
        return `${usage.open} Bright Data collections are still open for this organization (at most ${BRIGHTDATA_LIMITS.openCollections} at a time)`;
      }
      // …then the request's cap, after the organization's lock (it serializes the request's paid work).
      if (!input.spendGuard) return null;
      const room = await input.spendGuard(tx as Parameters<SpendGuard>[0], units * BRIGHTDATA_USD_PER_CREDIT);
      if (!room.ok) {
        hold = { wait: room.wait, budget: !room.wait, exhausted: false };
        return room.reason;
      }
      return null;
    },
  });
  if (!reservation.ok) return { started: false, wait: hold.wait, exhausted: hold.exhausted, budget: hold.budget, reason: reservation.reason };
  try {
    const { snapshotId } = await triggerCollection(readiness.key, {
      datasetId: BRIGHTDATA_DATASETS[spec.dataset].datasetId,
      discoverBy: spec.discoverBy,
      inputs: spec.inputs,
      limitPerInput: spec.limitPerInput,
    });
    await patchDetail(reservation.usageId, { snapshotId });
    return { started: true, usageId: reservation.usageId, snapshotId, reused: false, reservedCredits: units };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = error instanceof BrightdataError ? errorKind(error.status, message) : "lost";
    if (kind === "lost") {
      // No answer (a timeout, a server error): Bright Data may have started it and be billing it.
      // The row stays counted, never sent again.
      await settleQuota(reservation.usageId, { status: "uncertain", usedUnits: units, error: `The answer to starting it was lost: ${message}` });
      return { started: false, wait: false, exhausted: false, reason: `starting this Bright Data collection lost its answer (${message}), so it may have run; it is not sent again, and its reserved credits stay counted` };
    }
    await settleQuota(reservation.usageId, { status: "failed", usedUnits: 0, error: message });
    if (kind === "wait") {
      const retryAfterMs = error instanceof BrightdataError ? error.retryAfterMs : null;
      return { started: false, wait: true, exhausted: false, reason: `Bright Data asked to wait${retryAfterMs ? ` ${Math.ceil(retryAfterMs / 1_000)} s` : ""} (rate limit)` };
    }
    return { started: false, wait: false, exhausted: kind === "exhausted", reason: `Bright Data did not start the collection: ${message}` };
  }
}

export type PolledCollection =
  | { state: "running"; records: number | null }
  | { state: "finished"; ok: boolean; records: unknown[]; creditsUsed: number; note: string | null };

/**
 * Polls a collection. While Bright Data works: "running". Once ready, the
 * snapshot is downloaded (free, also for a settled row a retried step reads
 * again) and the row settled at the records plus failed inputs Bright Data
 * reported; a failed snapshot still settles what it reported, since Bright
 * Data bills records for inputs that failed. `stopWaiting` cancels one that
 * took too long: it may have been partly billed, so it stays counted.
 */
export async function pollCollection(usageId: string, options: { stopWaiting?: boolean } = {}): Promise<PolledCollection> {
  const row = await usageRow(usageId);
  const snapshotId = typeof row?.detail?.snapshotId === "string" ? row.detail.snapshotId : null;
  if (!row || !snapshotId) throw new BrightdataError(null, "The Bright Data collection was not recorded");
  const key = await savedKey();
  if (!key) {
    await settleQuota(usageId, { status: "failed", usedUnits: 0, error: "The Bright Data key was removed while the collection was open" });
    return { state: "finished", ok: false, records: [], creditsUsed: 0, note: "The Bright Data key was removed while the collection was open." };
  }
  let progress;
  try {
    progress = await snapshotProgress(key, snapshotId);
  } catch (error) {
    const kind = error instanceof BrightdataError ? errorKind(error.status, error.message) : "lost";
    if (kind === "lost" || kind === "wait") return { state: "running", records: null };
    throw error;
  }
  const outcome = progressOutcome(progress.status);
  if (outcome === "running") {
    if (!options.stopWaiting) return { state: "running", records: progress.records };
    await cancelSnapshot(key, snapshotId).catch(() => undefined);
    const used = row.status === "reserved" ? row.units : row.usedUnits ?? 0;
    await settleQuota(usageId, { status: "uncertain", usedUnits: used, error: "Cancelled: it took longer than the job waits", detail: { records: 0, status: "cancelled" } });
    return { state: "finished", ok: false, records: [], creditsUsed: used, note: `The Bright Data collection was cancelled after ${BRIGHTDATA_LIMITS.collectionTimeoutMinutes} minutes; its reserved credits stay counted because it may have been partly billed.` };
  }
  if (outcome === "failed") {
    const used = creditsUsed(progress, 0);
    await settleQuota(usageId, { status: "failed", usedUnits: used, error: `Bright Data reported the collection ${progress.status}`, detail: { records: progress.records ?? 0, errors: progress.errors ?? 0, status: progress.status } });
    return { state: "finished", ok: false, records: [], creditsUsed: used, note: `Bright Data reported the collection ${progress.status}.` };
  }
  const records = await downloadSnapshot(key, snapshotId);
  const used = creditsUsed(progress, records.length);
  // A settled row (reused, or read again by a retried step) is left as it is: settling twice changes nothing.
  await settleQuota(usageId, { status: "settled", usedUnits: used, detail: { records: progress.records ?? records.length, errors: progress.errors ?? 0, status: progress.status, errorCodes: progress.errorCodes } });
  return { state: "finished", ok: true, records, creditsUsed: row.status === "reserved" ? used : 0, note: null };
}

// ── SERP ─────────────────────────────────────────────────────────────────────

export type SerpOutcome = { ok: true; results: SerpResult[]; usageId: string } | { ok: false; wait: boolean; reason: string };

/**
 * One Google search through the owner's SERP zone (one credit), for finding
 * X, Instagram and Facebook URLs when no web search is set up. Reserved and
 * settled like a collection; a lost answer stays counted.
 */
export async function serpSearchThroughBrightdata(query: string, input: { jobId: string; requestId: string | null; threadId?: string | null; spendGuard?: SpendGuard; country?: string | null }): Promise<SerpOutcome> {
  const readiness = await brightdataReadiness();
  if (!readiness.usable) return { ok: false, wait: false, reason: readiness.reason };
  const zone = readiness.settings.serpZone;
  if (!zone) return { ok: false, wait: false, reason: "no SERP API zone is saved in the Bright Data settings" };
  let wait = false;
  const reservation = await reserveQuota({
    provider: BRIGHTDATA_PROVIDER, product: SERP_PRODUCT, scopeKey: null, units: 1, limits: {}, label: "Bright Data SERP",
    jobId: input.jobId, threadId: input.threadId ?? null, detail: { query: query.slice(0, 200), zone, ...(input.requestId ? { requestId: input.requestId } : {}) },
    guard: async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`brightdata-start:${currentOrganizationId()}`}, 0))`);
      const usage = await monthUsage(tx);
      if (readiness.settings.monthlyCredits - usage.used - usage.reserved < 1) return "this month's Bright Data limit is used up";
      if (!input.spendGuard) return null;
      const room = await input.spendGuard(tx as Parameters<SpendGuard>[0], BRIGHTDATA_USD_PER_CREDIT);
      if (!room.ok) {
        wait = room.wait;
        return room.reason;
      }
      return null;
    },
  });
  if (!reservation.ok) return { ok: false, wait, reason: reservation.reason };
  try {
    const results = await serpSearch(readiness.key, zone, query, { country: input.country ?? null });
    await settleQuota(reservation.usageId, { status: "settled", usedUnits: 1, detail: { results: results.length } });
    return { ok: true, results, usageId: reservation.usageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = error instanceof BrightdataError ? errorKind(error.status, message) : "lost";
    await settleQuota(reservation.usageId, { status: kind === "lost" ? "uncertain" : "failed", usedUnits: kind === "lost" ? 1 : 0, error: message });
    return { ok: false, wait: kind === "wait", reason: `Bright Data SERP failed: ${message}` };
  }
}
