import "server-only";

import { and, eq, gte, sql } from "drizzle-orm";
import { assistantJobs } from "@/lib/assistant/schema";
import { providerUsage } from "@/lib/quota/schema";
import { db } from "@/lib/db";
import { isMissingTable } from "@/lib/features/flags.server";
import { decryptIntegrationCredential, encryptIntegrationCredential } from "@/lib/integrations/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { getTavilyUsage, TavilyError } from "@/services/tavily";
import { TAVILY_LIMITS, tavilyPlanOf, type TavilySettingsView } from "./catalog";
import { tavilySettings } from "./schema";
import { MANAGED_LIMITS } from "@/lib/managed/allowances";
import type { ServiceMode } from "@/lib/managed/catalog";
import { chooseOwnOnSave, serviceMode } from "@/lib/managed/modes.server";
import { getPlatformCredential } from "@/lib/managed/store.server";

/**
 * The organization's Tavily key and its daily cap. Searches are counted
 * from the website-search jobs that ran on Tavily in the last 24 hours (each
 * job's queries), so the count needs no ledger of its own and a job's
 * searches count from the moment it is queued.
 */

export class TavilySettingsError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;
const USAGE_TIMEOUT_MS = 5_000;

type SettingsRow = typeof tavilySettings.$inferSelect;

async function settingsRow(): Promise<SettingsRow | null> {
  try {
    const [row] = await db.select().from(tavilySettings).where(inOrg(tavilySettings)).limit(1);
    return row ?? null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

/**
 * The key and daily cap this organization uses, or null when it has none:
 * on the Included service the platform's key with the Included daily cap,
 * on My own provider its own saved key and cap. Never one for the other.
 */
export async function tavilyConnection(): Promise<{ key: string; dailySearches: number; source: ServiceMode } | null> {
  if ((await serviceMode("tavily")) === "managed") {
    const key = (await getPlatformCredential("tavily"))?.apiKey;
    return key ? { key, dailySearches: MANAGED_LIMITS.tavilyDailySearches, source: "managed" } : null;
  }
  const row = await settingsRow();
  return row?.encryptedKey ? { key: decryptIntegrationCredential(row.encryptedKey), dailySearches: row.dailySearches, source: "own" } : null;
}

/** Tavily searches the organization used in the last 24 hours: its website searches' queries, and the assistant's own web searches (provider_usage). */
export async function tavilySearchesToday(executor: Pick<typeof db, "select"> = db): Promise<number> {
  const since = new Date(Date.now() - DAY_MS);
  const [jobs, direct] = await Promise.all([
    executor.select({
      n: sql<number>`coalesce(sum(jsonb_array_length(coalesce(${assistantJobs.payload}->'queries', '[]'::jsonb))), 0)::int`,
    }).from(assistantJobs).where(and(
      inOrg(assistantJobs),
      eq(assistantJobs.kind, "web_discovery"),
      sql`${assistantJobs.payload}->>'searchProvider' = 'tavily'`,
      gte(assistantJobs.createdAt, since),
    )),
    executor.select({ n: sql<number>`coalesce(sum(${providerUsage.units}), 0)::int` }).from(providerUsage).where(and(
      inOrg(providerUsage),
      eq(providerUsage.provider, "tavily"),
      eq(providerUsage.product, "search"),
      gte(providerUsage.createdAt, since),
    )).catch((error: unknown) => {
      if (isMissingTable(error)) return [{ n: 0 }];
      throw error;
    }),
  ]);
  return Number(jobs[0]?.n ?? 0) + Number(direct[0]?.n ?? 0);
}

export async function tavilySettingsView(): Promise<TavilySettingsView> {
  const row = await settingsRow();
  if ((await serviceMode("tavily")) === "managed") {
    // The platform's key and its plan are not shown: only this workspace's own searches.
    return {
      included: true,
      connected: Boolean((await getPlatformCredential("tavily"))?.apiKey),
      keyHint: null,
      dailySearches: MANAGED_LIMITS.tavilyDailySearches,
      searchesToday: await tavilySearchesToday(),
      plan: null,
    };
  }
  let plan: TavilySettingsView["plan"] = null;
  if (row?.encryptedKey) {
    // Read live (it spends no credits); a slow or failing answer only leaves the plan line out.
    plan = await Promise.race([
      getTavilyUsage(decryptIntegrationCredential(row.encryptedKey)).then(tavilyPlanOf, () => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), USAGE_TIMEOUT_MS)),
    ]);
  }
  return {
    connected: Boolean(row?.encryptedKey),
    keyHint: row?.keyHint ?? null,
    dailySearches: row?.dailySearches ?? TAVILY_LIMITS.dailySearches.default,
    searchesToday: row ? await tavilySearchesToday() : 0,
    plan,
  };
}

/** Saves the key and the daily cap. A new key is checked with Tavily first (GET /usage, no credits); an empty key disconnects. */
export async function saveTavilySettings(input: { key?: unknown; dailySearches?: unknown }, userId: string | null): Promise<TavilySettingsView> {
  const current = await settingsRow();
  let dailySearches = current?.dailySearches ?? TAVILY_LIMITS.dailySearches.default;
  if (input.dailySearches !== undefined) {
    const value = Number(input.dailySearches);
    const { min, max } = TAVILY_LIMITS.dailySearches;
    if (!Number.isInteger(value) || value < min || value > max) throw new TavilySettingsError(`Searches a day must be a whole number from ${min} to ${max}`);
    dailySearches = value;
  }
  let encryptedKey = current?.encryptedKey ?? null;
  let keyHint = current?.keyHint ?? null;
  if (typeof input.key === "string") {
    const key = input.key.trim();
    if (!key) {
      encryptedKey = null;
      keyHint = null;
    } else {
      if (key.length > 300 || /\s/.test(key)) throw new TavilySettingsError("That does not look like a Tavily key.");
      try {
        await getTavilyUsage(key);
      } catch (error) {
        throw new TavilySettingsError(error instanceof TavilyError && (error.status === 401 || error.status === 403) ? "Tavily rejected this key." : `The key could not be checked: ${error instanceof Error ? error.message : String(error)}`);
      }
      encryptedKey = encryptIntegrationCredential(key);
      keyHint = `…${key.slice(-4)}`;
    }
  }
  const values = { encryptedKey, keyHint, dailySearches, updatedBy: userId, updatedAt: new Date() };
  await db.insert(tavilySettings).values({ organizationId: currentOrganizationId(), ...values })
    .onConflictDoUpdate({ target: tavilySettings.organizationId, set: values });
  if (typeof input.key === "string" && input.key.trim()) await chooseOwnOnSave("tavily", userId);
  return tavilySettingsView();
}
