import "server-only";

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apifySettings } from "@/lib/apify/schema";
import { brightdataSettings } from "@/lib/brightdata/schema";
import { gridProviders } from "@/lib/grid/schema";
import { tavilySettings } from "@/lib/tavily/schema";
import { tinyfishSettings } from "@/lib/tinyfish/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { MANAGED_SERVICES, type ManagedService, type ServiceMode } from "./catalog";
import { providerCredentialModes } from "./schema";

/**
 * Each organization's choice per service: Included service ("managed", the
 * platform's credentials) or My own provider ("own", the organization's).
 *
 * The explicit row wins. With no row, an organization that has saved its own
 * credentials for the service is on My own provider (the migration also
 * writes those rows, so this is only a safety net), and every other one is
 * on the Included service. Never both, and never a fallback from one to the
 * other: a failing own key is that key's error, and the platform's account
 * is never charged for it.
 *
 * Cached 30 s per (organization, service); a change clears this process's
 * entries for the organization.
 */

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: ResolvedMode; expires: number }>();

export type ResolvedMode = { mode: ServiceMode; explicit: boolean };

export function clearServiceModeCache(organizationId?: string): void {
  if (!organizationId) return cache.clear();
  for (const key of cache.keys()) if (key.startsWith(`${organizationId}:`)) cache.delete(key);
}

function isMissingTable(error: unknown): boolean {
  for (let current: unknown = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === "42P01") return true;
  }
  return false;
}

async function exists(query: Promise<unknown[]>): Promise<boolean> {
  try {
    return (await query).length > 0;
  } catch (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
}

/** Whether the organization in scope has saved its own credentials for the service. */
export async function hasOwnCredentials(service: ManagedService): Promise<boolean> {
  switch (service) {
    case "ai":
      return exists(db.select({ id: gridProviders.id }).from(gridProviders).where(and(inOrg(gridProviders), sql`${gridProviders.config} ? 'aiProviderKey'`)).limit(1));
    case "unipile":
      return exists(db.select({ id: gridProviders.id }).from(gridProviders).where(and(inOrg(gridProviders), eq(gridProviders.key, "platform-unipile"))).limit(1));
    case "tinyfish":
      return exists(db.select({ id: tinyfishSettings.organizationId }).from(tinyfishSettings).where(and(inOrg(tinyfishSettings), isNotNull(tinyfishSettings.encryptedKey))).limit(1));
    case "tavily":
      return exists(db.select({ id: tavilySettings.organizationId }).from(tavilySettings).where(and(inOrg(tavilySettings), isNotNull(tavilySettings.encryptedKey))).limit(1));
    case "brightdata":
      return exists(db.select({ id: brightdataSettings.organizationId }).from(brightdataSettings).where(and(inOrg(brightdataSettings), isNotNull(brightdataSettings.encryptedKey))).limit(1));
    case "apify":
      return exists(db.select({ id: apifySettings.organizationId }).from(apifySettings).where(and(inOrg(apifySettings), isNotNull(apifySettings.encryptedToken))).limit(1));
  }
}

async function explicitModes(): Promise<Map<ManagedService, ServiceMode>> {
  try {
    const rows = await db.select({ service: providerCredentialModes.service, mode: providerCredentialModes.mode })
      .from(providerCredentialModes).where(inOrg(providerCredentialModes));
    return new Map(rows.map((row) => [row.service, row.mode]));
  } catch (error) {
    if (isMissingTable(error)) return new Map();
    throw error;
  }
}

/** The organization in scope's mode for one service. */
export async function resolveServiceMode(service: ManagedService): Promise<ResolvedMode> {
  const key = `${currentOrganizationId()}:${service}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const explicit = (await explicitModes()).get(service);
  const value: ResolvedMode = explicit
    ? { mode: explicit, explicit: true }
    : { mode: (await hasOwnCredentials(service)) ? "own" : "managed", explicit: false };
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

export async function serviceMode(service: ManagedService): Promise<ServiceMode> {
  return (await resolveServiceMode(service)).mode;
}

/** Every service's mode, for the settings page. */
export async function allServiceModes(): Promise<Record<ManagedService, ResolvedMode>> {
  const entries = await Promise.all(MANAGED_SERVICES.map(async (service) => [service, await resolveServiceMode(service)] as const));
  return Object.fromEntries(entries) as Record<ManagedService, ResolvedMode>;
}

/** Records an explicit choice (an owner or admin on Advanced → Use your own providers). */
export async function setServiceMode(service: ManagedService, mode: ServiceMode, userId: string | null, reason = "chosen in settings"): Promise<ResolvedMode> {
  const values = { mode, reason, updatedBy: userId, updatedAt: new Date() };
  await db.insert(providerCredentialModes)
    .values({ organizationId: currentOrganizationId(), service, ...values })
    .onConflictDoUpdate({ target: [providerCredentialModes.organizationId, providerCredentialModes.service], set: values });
  clearServiceModeCache(currentOrganizationId());
  return { mode, explicit: true };
}

/**
 * Called when a workspace saves its own credentials for a service: with no
 * explicit choice yet, saving them is the choice of My own provider. An
 * explicit Included choice is left as it is (the saved key then waits unused).
 */
export async function chooseOwnOnSave(service: ManagedService, userId: string | null): Promise<void> {
  const current = await resolveServiceMode(service);
  if (!current.explicit) await setServiceMode(service, "own", userId, "saved its own credentials");
}
