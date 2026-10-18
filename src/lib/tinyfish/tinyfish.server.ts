import "server-only";

import { createHash } from "node:crypto";
import { BROWSER_LIMITS } from "@/lib/browser/snapshot";
import { db } from "@/lib/db";
import { isMissingTable } from "@/lib/features/flags.server";
import { decryptIntegrationCredential, encryptIntegrationCredential } from "@/lib/integrations/credentials";
import { waitFromRefusal } from "@/lib/quota/quota";
import { blockQuota, quotaState, reserveQuota, settleQuota, usedToday } from "@/lib/quota/quota.server";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { tinyfishFetch, TinyfishError, tinyfishSearch, type TinyfishSearchInput } from "@/services/tinyfish";
import {
  keyHint,
  keyProblem,
  TINYFISH_FREE_LIMITS,
  TINYFISH_LIMITS,
  tinyfishFetchResult,
  tinyfishSearchHits,
  type TinyfishFetchFailure,
  type TinyfishPage,
  type TinyfishSearchHit,
  type TinyfishSettingsView,
} from "./catalog";
import { tinyfishSettings } from "./schema";

/**
 * The organization's TinyFish key and the guarded calls the assistant and
 * the discovery jobs make with it. Every Search and Fetch is reserved
 * against the key's free allowance first (src/lib/quota/), so AgentSDR
 * stops at the free line and waits for the reset rather than drawing on the
 * account's Wallet. A wait TinyFish imposes (429, a used-up allowance) is
 * recorded for every organization sharing the key and surfaces as
 * TinyfishWaitError with the time it ends.
 */

export const TINYFISH_PROVIDER = "tinyfish";

export class TinyfishSettingsError extends Error {}

/** No usable key: the caller falls back to another source or reports the gap. */
export class TinyfishUnavailableError extends Error {
  constructor(message = "TinyFish is not connected: an owner or admin saves its key in Settings → Organization → TinyFish.") {
    super(message);
    this.name = "TinyfishUnavailableError";
  }
}

/** TinyFish may not be used before `until`; nothing was called or charged. */
export class TinyfishWaitError extends Error {
  constructor(
    readonly until: Date,
    readonly reason: string,
  ) {
    super(`${reason}; it can be used again at ${until.toISOString().slice(0, 16).replace("T", " ")} UTC`);
    this.name = "TinyfishWaitError";
  }
}

type SettingsRow = typeof tinyfishSettings.$inferSelect;

async function settingsRow(): Promise<SettingsRow | null> {
  try {
    const [row] = await db.select().from(tinyfishSettings).where(inOrg(tinyfishSettings)).limit(1);
    return row ?? null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

/** The quota scope of a key: its sha256, so the key itself is never stored in the clear. */
export function keyScopeOf(key: string): string {
  return `tinyfish:${createHash("sha256").update(key).digest("hex")}`;
}

export type TinyfishConnection = { key: string; scopeKey: string; useForWebSearch: boolean; browserMinutesPerDay: number };

/** The saved key and preferences, or null when no key is saved. */
export async function tinyfishConnection(): Promise<TinyfishConnection | null> {
  const row = await settingsRow();
  if (!row?.encryptedKey) return null;
  const key = decryptIntegrationCredential(row.encryptedKey);
  return { key, scopeKey: row.keyScope ?? keyScopeOf(key), useForWebSearch: row.useForWebSearch, browserMinutesPerDay: row.browserMinutesPerDay };
}

export async function tinyfishSettingsView(): Promise<TinyfishSettingsView> {
  const row = await settingsRow();
  const connected = Boolean(row?.encryptedKey);
  let searches = 0;
  let fetchedUrls = 0;
  let waitingUntil: Date | null = null;
  let waitingReason: string | null = null;
  if (connected && row?.keyScope) {
    const [search, fetch] = await Promise.all([quotaState(row.keyScope, TINYFISH_PROVIDER, "search"), quotaState(row.keyScope, TINYFISH_PROVIDER, "fetch")]);
    searches = search.dayUsed;
    fetchedUrls = fetch.dayUsed;
    const blocked = [search, fetch].filter((state) => state.blockedUntil).sort((a, b) => b.blockedUntil!.getTime() - a.blockedUntil!.getTime())[0];
    waitingUntil = blocked?.blockedUntil ?? null;
    waitingReason = blocked?.blockedReason ?? null;
  }
  return {
    connected,
    keyHint: row?.keyHint ?? null,
    useForWebSearch: row?.useForWebSearch ?? true,
    browserMinutesPerDay: row?.browserMinutesPerDay ?? TINYFISH_LIMITS.browserMinutesPerDay.default,
    today: { searches, fetchedUrls, browserMinutes: connected ? await usedToday(TINYFISH_PROVIDER, "browser") : 0 },
    waitingUntil: waitingUntil?.toISOString() ?? null,
    waitingReason,
  };
}

/**
 * Saves the key and preferences. A new key is checked with one real search
 * (one request of its free allowance); an empty key disconnects.
 */
export async function saveTinyfishSettings(
  input: { key?: unknown; useForWebSearch?: unknown; browserMinutesPerDay?: unknown },
  userId: string | null,
): Promise<TinyfishSettingsView> {
  const current = await settingsRow();
  let browserMinutesPerDay = current?.browserMinutesPerDay ?? TINYFISH_LIMITS.browserMinutesPerDay.default;
  if (input.browserMinutesPerDay !== undefined) {
    const value = Number(input.browserMinutesPerDay);
    const { min, max } = TINYFISH_LIMITS.browserMinutesPerDay;
    if (!Number.isInteger(value) || value < min || value > max) throw new TinyfishSettingsError(`Browser minutes a day must be a whole number from ${min} to ${max}`);
    // Each session reserves its full length up front, so fewer minutes could never open one.
    if (value > 0 && value < BROWSER_LIMITS.maxSessionMinutes) {
      throw new TinyfishSettingsError(`Browser minutes a day must be 0 (off) or at least ${BROWSER_LIMITS.maxSessionMinutes}, one session's length`);
    }
    browserMinutesPerDay = value;
  }
  let useForWebSearch = current?.useForWebSearch ?? true;
  if (input.useForWebSearch !== undefined) {
    if (typeof input.useForWebSearch !== "boolean") throw new TinyfishSettingsError("Use for web search must be on or off");
    useForWebSearch = input.useForWebSearch;
  }
  let encryptedKey = current?.encryptedKey ?? null;
  let hint = current?.keyHint ?? null;
  let keyScope = current?.keyScope ?? null;
  if (typeof input.key === "string") {
    const key = input.key.trim();
    if (!key) {
      encryptedKey = null;
      hint = null;
      keyScope = null;
    } else {
      const problem = keyProblem(key);
      if (problem) throw new TinyfishSettingsError(problem);
      keyScope = keyScopeOf(key);
      await verifyKey(key, keyScope);
      encryptedKey = encryptIntegrationCredential(key);
      hint = keyHint(key);
    }
  }
  const values = { encryptedKey, keyHint: hint, keyScope, useForWebSearch, browserMinutesPerDay, updatedBy: userId, updatedAt: new Date() };
  await db.insert(tinyfishSettings).values({ organizationId: currentOrganizationId(), ...values })
    .onConflictDoUpdate({ target: tinyfishSettings.organizationId, set: values });
  return tinyfishSettingsView();
}

async function verifyKey(key: string, scopeKey: string): Promise<void> {
  try {
    await guardedSearch({ key, scopeKey }, { query: "tinyfish web search" }, { detail: { verify: true } });
  } catch (error) {
    if (error instanceof TinyfishError && (error.status === 401 || error.status === 403)) throw new TinyfishSettingsError("TinyFish rejected this key.");
    // A busy or rate-limited key is still a real key.
    if (error instanceof TinyfishWaitError) return;
    throw new TinyfishSettingsError(`The key could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type CallContext = { jobId?: string | null; threadId?: string | null; detail?: Record<string, unknown> };

/** Turns a refusal into a recorded wait for the key's scope, or leaves it as the error it is. */
async function recordRefusal(scopeKey: string, product: "search" | "fetch", error: unknown): Promise<never> {
  if (error instanceof TinyfishError) {
    const wait = waitFromRefusal({ status: error.status, code: error.code, retryAfterMs: error.retryAfterMs, resetAt: error.resetAt }, new Date(), product === "search" ? "TinyFish Search" : "TinyFish Fetch");
    if (wait) {
      await blockQuota(scopeKey, TINYFISH_PROVIDER, product, wait.until, wait.reason);
      throw new TinyfishWaitError(wait.until, wait.reason);
    }
  }
  throw error;
}

async function guardedSearch(connection: Pick<TinyfishConnection, "key" | "scopeKey">, input: TinyfishSearchInput, context: CallContext): Promise<TinyfishSearchHit[]> {
  const reservation = await reserveQuota({
    provider: TINYFISH_PROVIDER, product: "search", scopeKey: connection.scopeKey, units: 1,
    limits: TINYFISH_FREE_LIMITS.search, label: "TinyFish Search",
    jobId: context.jobId, threadId: context.threadId, detail: { query: input.query.slice(0, 200), ...context.detail },
  });
  if (!reservation.ok) throw new TinyfishWaitError(reservation.until, reservation.reason);
  let body: unknown;
  try {
    body = await tinyfishSearch(connection.key, input);
  } catch (error) {
    // A search request counts against the per-minute limit whatever its answer.
    await settleQuota(reservation.usageId, { status: error instanceof TinyfishError && error.uncertain ? "uncertain" : "failed", usedUnits: 1, error: error instanceof Error ? error.message : String(error) });
    return recordRefusal(connection.scopeKey, "search", error);
  }
  const hits = tinyfishSearchHits(body);
  await settleQuota(reservation.usageId, { status: "settled", usedUnits: 1, detail: { results: hits.length } });
  return hits;
}

/** One TinyFish search for the organization in scope. */
export async function searchWithTinyfish(input: TinyfishSearchInput, context: CallContext = {}): Promise<TinyfishSearchHit[]> {
  const connection = await tinyfishConnection();
  if (!connection) throw new TinyfishUnavailableError();
  return guardedSearch(connection, input, context);
}

/**
 * Reads up to 10 public URLs through TinyFish Fetch. Each URL is reserved
 * against the free daily allowance; only the URLs actually read stay
 * counted (TinyFish counts successful URLs).
 */
export async function fetchWithTinyfish(urls: string[], context: CallContext & { purpose?: string | null } = {}): Promise<{ pages: TinyfishPage[]; failures: TinyfishFetchFailure[] }> {
  const batch = [...new Set(urls)].slice(0, TINYFISH_LIMITS.fetchUrlsPerCall);
  if (!batch.length) return { pages: [], failures: [] };
  const connection = await tinyfishConnection();
  if (!connection) throw new TinyfishUnavailableError();
  const reservation = await reserveQuota({
    provider: TINYFISH_PROVIDER, product: "fetch", scopeKey: connection.scopeKey, units: batch.length,
    limits: TINYFISH_FREE_LIMITS.fetch, label: "TinyFish Fetch",
    jobId: context.jobId, threadId: context.threadId, detail: { urls: batch.map((url) => url.slice(0, 300)), ...context.detail },
  });
  if (!reservation.ok) throw new TinyfishWaitError(reservation.until, reservation.reason);
  let body: unknown;
  try {
    body = await tinyfishFetch(connection.key, batch, { purpose: context.purpose });
  } catch (error) {
    const uncertain = error instanceof TinyfishError && error.uncertain;
    await settleQuota(reservation.usageId, { status: uncertain ? "uncertain" : "failed", usedUnits: uncertain ? batch.length : 0, error: error instanceof Error ? error.message : String(error) });
    return recordRefusal(connection.scopeKey, "fetch", error);
  }
  const result = tinyfishFetchResult(body);
  await settleQuota(reservation.usageId, { status: "settled", usedUnits: result.pages.length, detail: { read: result.pages.length, failed: result.failures.length } });
  return result;
}
