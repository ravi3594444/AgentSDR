import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/auth/schema";
import { decryptIntegrationCredentials, encryptIntegrationCredentials } from "@/lib/integrations/credentials";
import {
  EMPTY_MANAGED_AI_SETTINGS,
  PLATFORM_CREDENTIAL_INFO,
  PLATFORM_CREDENTIAL_KEYS,
  managedAiProblem,
  normalizeManagedAiSettings,
  secretHint,
  type ManagedAiSettings,
  type PlatformCredentialKey,
  type PlatformCredentialStatus,
} from "./catalog";
import { platformCredentials, platformSettings } from "./schema";

/**
 * The platform's own credentials for each Included service, and the
 * Included AI engine settings. GLOBAL rows: they belong to the platform, not
 * to an organization, so nothing here reads the organization scope.
 *
 * Secrets are encrypted with INTEGRATION_CREDENTIALS_KEY (the same envelope
 * as every integration) and decrypted only on the server, immediately before
 * a provider call. Nothing here returns a secret to a caller that renders it:
 * listPlatformCredentialStatus gives non-secret values and masked hints only.
 *
 * Reads are cached in-process for CACHE_TTL_MS, keyed by provider: storing,
 * replacing or removing a credential clears this process's entry at once,
 * and another instance picks the change up within the TTL (a rotated key may
 * be used for up to 30 s more there).
 */

const CACHE_TTL_MS = 30_000;
const AI_SETTINGS_KEY = "ai";

type Loaded = { values: Record<string, string>; fingerprint: string } | null;
const cache = new Map<PlatformCredentialKey, { value: Loaded; expires: number }>();
let aiCache: { value: ManagedAiSettings; expires: number } | null = null;

export class PlatformCredentialError extends Error {}

/** Clears this process's cached platform credentials and AI settings. */
export function clearPlatformCredentialCache(): void {
  cache.clear();
  aiCache = null;
}

function isMissingTable(error: unknown): boolean {
  for (let current: unknown = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    if ((current as { code?: unknown }).code === "42P01") return true;
  }
  return false;
}

/** The sha256 a key is compared by (another organization saving the same key, a quota scope). Never the key. */
export function credentialFingerprint(key: PlatformCredentialKey, values: Record<string, string>): string {
  const material = key === "unipile" ? `${values.baseUrl ?? ""}\n${values.apiKey ?? ""}` : (values.apiKey ?? "");
  return createHash("sha256").update(`${key}:${material.trim()}`).digest("hex");
}

async function load(key: PlatformCredentialKey): Promise<Loaded> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  let value: Loaded = null;
  try {
    const [row] = await db
      .select({ encryptedPayload: platformCredentials.encryptedPayload, fingerprint: platformCredentials.fingerprint })
      .from(platformCredentials)
      .where(eq(platformCredentials.provider, key))
      .limit(1);
    value = row ? { values: decryptIntegrationCredentials(row.encryptedPayload), fingerprint: row.fingerprint } : null;
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

/** The platform's decrypted credential values, or null when none is stored. Server-only: never return these from a route. */
export async function getPlatformCredential(key: PlatformCredentialKey): Promise<Record<string, string> | null> {
  return (await load(key))?.values ?? null;
}

/** The fingerprint of the stored credential, or null. */
export async function platformCredentialFingerprint(key: PlatformCredentialKey): Promise<string | null> {
  return (await load(key))?.fingerprint ?? null;
}

/** Which platform credentials are stored, without decrypting any. */
export async function storedPlatformCredentialKeys(): Promise<Set<PlatformCredentialKey>> {
  try {
    const rows = await db.select({ provider: platformCredentials.provider }).from(platformCredentials);
    return new Set(rows.map((row) => row.provider));
  } catch (error) {
    if (isMissingTable(error)) return new Set();
    throw error;
  }
}

/** What the operator panel shows: stored or not, non-secret values, masked hints. Never a secret. */
export async function listPlatformCredentialStatus(): Promise<PlatformCredentialStatus[]> {
  const rows = await db
    .select({
      provider: platformCredentials.provider,
      config: platformCredentials.config,
      updatedAt: platformCredentials.updatedAt,
      sourceOrganizationId: platformCredentials.sourceOrganizationId,
    })
    .from(platformCredentials);
  const sourceIds = [...new Set(rows.map((row) => row.sourceOrganizationId).filter((id): id is string => Boolean(id)))];
  const names = sourceIds.length
    ? new Map((await db.select({ id: organizations.id, name: organizations.name }).from(organizations).where(inArray(organizations.id, sourceIds))).map((row) => [row.id, row.name]))
    : new Map<string, string>();
  return PLATFORM_CREDENTIAL_KEYS.map((key) => {
    const row = rows.find((candidate) => candidate.provider === key);
    const config = (row?.config ?? {}) as { values?: Record<string, string>; hints?: Record<string, string>; verifiedAt?: string; webhooks?: { status: string; message?: string; at?: string } };
    return {
      key,
      stored: Boolean(row),
      values: config.values ?? {},
      hints: config.hints ?? {},
      verifiedAt: config.verifiedAt ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      adoptedFrom: row?.sourceOrganizationId ? { organizationId: row.sourceOrganizationId, name: names.get(row.sourceOrganizationId) ?? null } : null,
      ...(key === "unipile" ? { webhooks: config.webhooks ? { status: config.webhooks.status, message: config.webhooks.message, at: config.webhooks.at } : null } : {}),
    };
  });
}

/** Trims, keeps blank secrets from the stored row, fills Unipile's generated webhook secret, and checks required fields. */
export function mergePlatformCredentialInput(
  key: PlatformCredentialKey,
  input: Record<string, unknown>,
  existing: Record<string, string> | null,
): Record<string, string> {
  const info = PLATFORM_CREDENTIAL_INFO[key];
  const allowed = new Set(info.fields.map((field) => field.key));
  if (Object.keys(input).some((field) => !allowed.has(field))) throw new PlatformCredentialError("One or more fields are invalid");
  if (Object.values(input).some((value) => value !== undefined && value !== null && typeof value !== "string")) {
    throw new PlatformCredentialError("Field values must be text");
  }
  const merged: Record<string, string> = {};
  for (const field of info.fields) {
    const given = String(input[field.key] ?? "").trim();
    merged[field.key] = given || (field.secret ? (existing?.[field.key] ?? "") : "");
    if (merged[field.key].length > 16_384) throw new PlatformCredentialError(`${field.label} is too long`);
    if (field.secret && merged[field.key] && /\s/.test(merged[field.key])) throw new PlatformCredentialError(`${field.label} cannot contain spaces`);
  }
  const missing = info.fields.find((field) => field.required && !merged[field.key]);
  if (missing) throw new PlatformCredentialError(`${missing.label} is required`);
  if (key === "unipile" && !merged.notifySecret) merged.notifySecret = randomBytes(32).toString("base64url");
  return merged;
}

/** A check run before a credential is stored; throws an Error whose message is safe to show. */
export type PlatformCredentialVerifier = (key: PlatformCredentialKey, values: Record<string, string>) => Promise<Record<string, string> | void>;

/**
 * Verifies, then stores (or replaces) the platform's credential for `key`.
 * A secret left blank keeps the stored one. `verify` may return normalized
 * values (a DSN with its scheme) that are stored instead.
 */
export async function storePlatformCredential(
  key: PlatformCredentialKey,
  input: Record<string, unknown>,
  options: { userId: string | null; verify: PlatformCredentialVerifier; sourceOrganizationId?: string | null },
): Promise<PlatformCredentialStatus> {
  cache.delete(key);
  const existing = await getPlatformCredential(key);
  const merged = mergePlatformCredentialInput(key, input, existing);
  let values = merged;
  try {
    values = (await options.verify(key, merged)) ?? merged;
  } catch (error) {
    throw new PlatformCredentialError(error instanceof Error ? error.message : "The credentials could not be verified");
  }
  const info = PLATFORM_CREDENTIAL_INFO[key];
  const config = {
    values: Object.fromEntries(info.fields.filter((field) => !field.secret && values[field.key]).map((field) => [field.key, values[field.key]])),
    hints: Object.fromEntries(info.fields.filter((field) => field.secret && values[field.key]).map((field) => [field.key, secretHint(values[field.key])])),
    verifiedAt: new Date().toISOString(),
  };
  const now = new Date();
  const row = {
    encryptedPayload: encryptIntegrationCredentials(values),
    config,
    fingerprint: credentialFingerprint(key, values),
    sourceOrganizationId: options.sourceOrganizationId ?? null,
    updatedBy: options.userId,
    updatedAt: now,
  };
  await db.insert(platformCredentials).values({ provider: key, ...row }).onConflictDoUpdate({ target: platformCredentials.provider, set: row });
  cache.delete(key);
  return (await listPlatformCredentialStatus()).find((status) => status.key === key)!;
}

/** Removes the platform's credential. Included workspaces stop using that provider at once in this process, within 30 s elsewhere. */
export async function removePlatformCredential(key: PlatformCredentialKey): Promise<boolean> {
  const removed = await db.delete(platformCredentials).where(eq(platformCredentials.provider, key)).returning({ provider: platformCredentials.provider });
  cache.delete(key);
  aiCache = null;
  return removed.length > 0;
}

/** The Included AI engine and its models (operator only; customers never receive it). */
export async function getManagedAiSettings(): Promise<ManagedAiSettings> {
  if (aiCache && aiCache.expires > Date.now()) return aiCache.value;
  let value = EMPTY_MANAGED_AI_SETTINGS;
  try {
    const [row] = await db.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.key, AI_SETTINGS_KEY)).limit(1);
    value = row ? normalizeManagedAiSettings(row.value) : EMPTY_MANAGED_AI_SETTINGS;
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  aiCache = { value, expires: Date.now() + CACHE_TTL_MS };
  return value;
}

/** Saves the Included AI settings; refuses settings that could not run, so no workspace is left on a broken engine. */
export async function saveManagedAiSettings(input: unknown, userId: string | null): Promise<ManagedAiSettings> {
  const settings = normalizeManagedAiSettings(input);
  if ((input as { engine?: unknown } | null)?.engine === "claude-code") {
    if (settings.engine !== "claude-code" || !userId) throw new PlatformCredentialError("Choose your signed-in Claude Code account and approved workspaces.");
    const { validateSharedClaudeSettings } = await import("@/lib/ai/claudeCode/shared.server");
    await validateSharedClaudeSettings(settings, userId);
  }
  if (settings.engine) {
    const problem = managedAiProblem(settings, await storedPlatformCredentialKeys());
    if (problem) throw new PlatformCredentialError(problem);
  }
  const value = settings as unknown as Record<string, unknown>;
  await db.insert(platformSettings).values({ key: AI_SETTINGS_KEY, value, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedBy: userId, updatedAt: new Date() } });
  aiCache = null;
  return settings;
}
