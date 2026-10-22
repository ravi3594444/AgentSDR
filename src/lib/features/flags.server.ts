import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { defaultFeatureState, featureStateFromRows, FEATURES, type FeatureKey, type FeatureState } from "./catalog";
import { organizationFeatures } from "./schema";

/**
 * The organization's features, with defaults from catalog.ts and saved
 * overrides from its own rows. Before the features table is installed,
 * everything reads as off. Reads are cached per organization
 * for CACHE_TTL_MS, like the sending rules; saving clears this process's
 * entry.
 */

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { state: FeatureState; expires: number }>();

export class FeatureDisabledError extends Error {
  readonly status = 409;
  constructor(readonly feature: FeatureKey) {
    super(`${FEATURES[feature].label} is off for this organization. An owner or admin can turn it on in Settings → Providers & features.`);
    this.name = "FeatureDisabledError";
  }
}

/** The optional features' tables do not exist yet: the database needs this release's migration. */
export class FeaturesNotInstalledError extends Error {
  constructor() {
    super("Optional features need a database update first: the server's operator runs `bun scripts/add-instagram-intake-discovery.ts` (see CHANGELOG). Until then everything else works as before.");
    this.name = "FeaturesNotInstalledError";
  }
}

/** A query on a table a migration has not created yet (42P01 undefined_table). */
export function isMissingTable(error: unknown): boolean {
  for (let current: unknown = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === "42P01") return true;
  }
  return false;
}

async function load(): Promise<FeatureState> {
  try {
    const rows = await db.select({ key: organizationFeatures.key, enabled: organizationFeatures.enabled })
      .from(organizationFeatures)
      .where(inOrg(organizationFeatures));
    return featureStateFromRows(rows);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    // The default-on harness must not run before feature tables exist.
    return { ...defaultFeatureState(), research_agent_v2: false };
  }
}

/** Every optional feature of the organization in scope, on or off. */
export async function featureState(): Promise<FeatureState> {
  const key = currentOrganizationId();
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return { ...hit.state };
  const state = await load();
  cache.set(key, { state, expires: Date.now() + CACHE_TTL_MS });
  return { ...state };
}

export async function featureEnabled(feature: FeatureKey): Promise<boolean> {
  return (await featureState())[feature];
}

/** Throws FeatureDisabledError (409) when the feature is off. */
export async function requireFeature(feature: FeatureKey): Promise<void> {
  if (!(await featureEnabled(feature))) throw new FeatureDisabledError(feature);
}

/** Turns a feature on or off for the organization in scope; the caller checks the permission. */
export async function setFeature(feature: FeatureKey, enabled: boolean, userId: string | null): Promise<FeatureState> {
  try {
    await db.insert(organizationFeatures).values({
      organizationId: currentOrganizationId(),
      key: feature,
      enabled,
      updatedBy: userId,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [organizationFeatures.organizationId, organizationFeatures.key],
      set: { enabled, updatedBy: userId, updatedAt: new Date() },
    });
  } catch (error) {
    if (isMissingTable(error)) {
      throw new FeaturesNotInstalledError();
    }
    throw error;
  }
  cache.delete(currentOrganizationId());
  return featureState();
}

/** Test and script hook: forget cached switches. */
export function clearFeatureCache(): void {
  cache.clear();
}

/** One feature's row, for the settings page's "turned on by … at …". */
export async function featureRow(feature: FeatureKey) {
  try {
    const [row] = await db.select().from(organizationFeatures)
      .where(and(inOrg(organizationFeatures), eq(organizationFeatures.key, feature))).limit(1);
    return row ?? null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}
