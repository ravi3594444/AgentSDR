import "server-only";

import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { gridProviderCredentials, gridProviders } from "@/lib/grid/schema";
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
} from "@/lib/integrations/credentials";
import {
  PLATFORM_INTEGRATIONS,
  PLATFORM_SETTINGS_LABEL,
  getPlatformIntegration,
  type PlatformCredentials,
  type PlatformKey,
  type GmailWatchRegistration,
  type PlatformStatus,
  type UnipileWebhookRegistration,
} from "./catalog";
import { registerUnipileWebhooks, unipileWebhookEndpoints, unregisterUnipileWebhooks, type UnipileWebhookEndpoint } from "./unipileWebhooks";
import { verifyPlatformCredentials } from "./verify";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import type { ServiceMode } from "@/lib/managed/catalog";
import { chooseOwnOnSave, serviceMode } from "@/lib/managed/modes.server";
import { getPlatformCredential } from "@/lib/managed/store.server";

/**
 * Unipile as an Included service: the platform's Unipile, shared by every
 * Included workspace, with account ownership enforced (src/lib/unipile/):
 * every sync keeps only owned accounts, the client refuses calls for others,
 * new accounts arrive only through the verified connection flow, and
 * webhooks are routed by owner. (A shared key without that layer would let
 * one workspace list another's accounts.)
 */
const MANAGED_UNIPILE = true;
export const MANAGED_UNIPILE_ENABLED = MANAGED_UNIPILE;

/** Which credentials Unipile resolves to for the organization in scope. Google and R2 are always the organization's own. */
export async function platformCredentialSource(key: PlatformKey): Promise<ServiceMode> {
  if (key !== "unipile" || !MANAGED_UNIPILE) return "own";
  return serviceMode("unipile");
}

/**
 * Storage for platform integrations (see catalog.ts).
 *
 * Each platform is one row in grid_providers under the fixed key
 * `platform-<key>` — the same singleton pattern as the OpenRouter BYOK
 * settings — with its whole credential object encrypted in
 * grid_provider_credentials, exactly as enrichment and AI accounts are. The
 * row's config carries `platformKey`, so neither the integrations nor the AI
 * listings (which filter on their own markers) ever pick it up.
 *
 * Reads are cached in-process for CACHE_TTL_MS: the Unipile client and the
 * Gmail sender sit on hot paths, and a DB round trip plus an AES-GCM decrypt
 * per call is waste. Saving or disconnecting clears this process's cache;
 * another instance picks the change up within the TTL.
 *
 * Integrations are per organization: every function works on the
 * organization in scope, and the cache is keyed by (organization, platform)
 * so one organization can never be served another's credentials.
 */

const CACHE_TTL_MS = 30_000;
const PLATFORM_ROW_NAME = "Platform integration";

type Cached = { value: Record<string, string> | null; expires: number };
const cache = new Map<string, Cached>();

function cacheKey(key: PlatformKey, source: ServiceMode = "own"): string {
  return `${currentOrganizationId()}:${key}:${source}`;
}

type PlatformConfig = {
  platformKey: PlatformKey;
  /** Non-secret field values, readable without a decrypt. */
  values: Record<string, string>;
  secretsSet: string[];
  verifiedAt: string;
  /** Unipile only: the last webhook registration (unipileWebhooks.ts). */
  webhooks?: UnipileWebhookRegistration;
  /** Google only: the last Gmail watch registration (outreach/mailboxWatch.ts). */
  gmailWatch?: GmailWatchRegistration;
};

export class PlatformNotConnectedError extends Error {
  constructor(readonly platform: PlatformKey) {
    const name = getPlatformIntegration(platform)?.name ?? platform;
    super(`${name} is not connected — connect it in ${PLATFORM_SETTINGS_LABEL[platform]}`);
    this.name = "PlatformNotConnectedError";
  }
}

export function isPlatformNotConnectedError(error: unknown): error is PlatformNotConnectedError {
  return error instanceof PlatformNotConnectedError;
}

function rowKey(key: PlatformKey): string {
  return `platform-${key}`;
}

async function load(key: PlatformKey): Promise<Record<string, string> | null> {
  const source = await platformCredentialSource(key);
  const hit = cache.get(cacheKey(key, source));
  if (hit && hit.expires > Date.now()) return hit.value;

  if (source === "managed") {
    // The platform's Unipile (an Included service): never this organization's own row, and never a fallback to it.
    const value = await getPlatformCredential("unipile");
    cache.set(cacheKey(key, source), { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  }

  const value = await loadOwn(key);
  cache.set(cacheKey(key, source), { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * The organization's own saved credentials, whatever it chose. Saving,
 * webhook registration and disconnecting work on these only: the platform's
 * credentials are never merged into, revealed through or unregistered from
 * an organization's row.
 */
async function loadOwn(key: PlatformKey): Promise<Record<string, string> | null> {
  const [row] = await db
    .select({ enabled: gridProviders.enabled, encryptedPayload: gridProviderCredentials.encryptedPayload })
    .from(gridProviders)
    .leftJoin(gridProviderCredentials, eq(gridProviderCredentials.providerId, gridProviders.id))
    .where(and(inOrg(gridProviders), eq(gridProviders.key, rowKey(key))))
    .limit(1);
  return row?.enabled && row.encryptedPayload ? decryptIntegrationCredentials(row.encryptedPayload) : null;
}

/** The organization's own saved credentials, normalized, whatever it chose: for an operator adopting them as defaults. Server-only. */
export async function getOwnPlatformCredentials<K extends PlatformKey>(key: K): Promise<PlatformCredentials[K] | null> {
  const own = await loadOwn(key);
  return own ? normalize(key, own) : null;
}

/** Thrown when an action that only makes sense for the organization's own Unipile is asked while it uses the Included one. */
export class ManagedPlatformError extends Error {
  constructor(platform: PlatformKey) {
    super(`${getPlatformIntegration(platform)?.name ?? platform} is the Included service for this workspace: the platform registers its webhooks, and its secrets are never shown. Choose My own provider to manage your own.`);
    this.name = "ManagedPlatformError";
  }
}

/** Decrypted credentials, or null when the platform is not connected. Server-only — never return these from an API route. */
export async function getPlatformCredentials<K extends PlatformKey>(
  key: K,
): Promise<PlatformCredentials[K] | null> {
  const value = await load(key);
  return value ? (normalize(key, value) as PlatformCredentials[K]) : null;
}

/** Like getPlatformCredentials, but throws PlatformNotConnectedError instead of returning null. */
export async function requirePlatformCredentials<K extends PlatformKey>(
  key: K,
): Promise<PlatformCredentials[K]> {
  const credentials = await getPlatformCredentials(key);
  if (!credentials) throw new PlatformNotConnectedError(key);
  return credentials;
}

export async function isPlatformConnected(key: PlatformKey): Promise<boolean> {
  return (await load(key)) !== null;
}

export async function listPlatformStatus(): Promise<PlatformStatus[]> {
  const rows = await db
    .select({ key: gridProviders.key, enabled: gridProviders.enabled, config: gridProviders.config })
    .from(gridProviders)
    .where(and(inOrg(gridProviders), sql`${gridProviders.config} ? 'platformKey'`));
  return PLATFORM_INTEGRATIONS.map(({ key }) => {
    const row = rows.find((candidate) => candidate.key === rowKey(key));
    const config = row?.enabled ? (row.config as Partial<PlatformConfig>) : null;
    return {
      key,
      connected: Boolean(config),
      values: config?.values ?? {},
      secretsSet: config?.secretsSet ?? [],
      verifiedAt: config?.verifiedAt ?? null,
      webhooks: config?.webhooks ?? null,
      gmailWatch: config?.gmailWatch ?? null,
    };
  });
}

/**
 * Verifies, then saves. On an update, a secret field left blank keeps its
 * saved value, so the form never needs to hold a secret it was not given.
 */
export async function savePlatformIntegration(key: PlatformKey, input: Record<string, unknown>): Promise<PlatformStatus> {
  const integration = getPlatformIntegration(key);
  if (!integration) throw new Error("Unknown integration");

  const allowed = new Set(integration.fields.map((field) => field.key));
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw new Error("One or more fields are invalid");
  }
  if (Object.values(input).some((value) => value !== undefined && typeof value !== "string")) {
    throw new Error("Field values must be text");
  }

  cache.delete(cacheKey(key));
  // The organization's own saved values only: a blank secret keeps its own, never the platform's.
  const existing = (await loadOwn(key)) ?? {};
  const merged: Record<string, string> = {};
  for (const field of integration.fields) {
    const given = String(input[field.key] ?? "").trim();
    merged[field.key] = given || (field.secret ? (existing[field.key] ?? "") : "");
    if (merged[field.key].length > 16_384) throw new Error(`${field.label} is too long`);
  }
  const missing = integration.fields.find((field) => field.required && !merged[field.key]);
  if (missing) throw new Error(`${missing.label} is required`);
  // Unipile's webhook secret is ours to make: nobody should have to invent one.
  if (key === "unipile" && !merged.notifySecret) merged.notifySecret = randomBytes(32).toString("base64url");

  const credentials = normalize(key, merged);
  await verifyPlatformCredentials(key, credentials);

  const stored = credentials as unknown as Record<string, string>;
  const config: PlatformConfig = {
    platformKey: key,
    values: Object.fromEntries(
      integration.fields.filter((field) => !field.secret).map((field) => [field.key, stored[field.key] ?? ""]),
    ),
    secretsSet: integration.fields.filter((field) => field.secret && stored[field.key]).map((field) => field.key),
    verifiedAt: new Date().toISOString(),
  };
  const encryptedPayload = encryptIntegrationCredentials(stored);

  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(gridProviders)
      .values({ organizationId: currentOrganizationId(), key: rowKey(key), name: PLATFORM_ROW_NAME, config, enabled: true })
      .onConflictDoUpdate({
        target: [gridProviders.organizationId, gridProviders.key],
        set: { config, enabled: true, updatedAt: new Date() },
      })
      .returning({ id: gridProviders.id });
    await tx
      .insert(gridProviderCredentials)
      .values({ providerId: row.id, encryptedPayload })
      .onConflictDoUpdate({
        target: gridProviderCredentials.providerId,
        set: { encryptedPayload, updatedAt: new Date() },
      });
  });

  cache.delete(cacheKey(key));
  // Saving its own Unipile, with no explicit choice yet, is the choice of My own provider.
  if (key === "unipile") await chooseOwnOnSave("unipile", null);
  const webhooks =
    key === "unipile"
      ? await storeWebhookRegistration(
          await registerUnipileWebhooks(currentOrganizationId(), credentials as PlatformCredentials["unipile"]),
        )
      : null;
  return {
    key,
    connected: true,
    values: config.values,
    secretsSet: config.secretsSet,
    verifiedAt: config.verifiedAt,
    webhooks,
  };
}

/** Record a Unipile webhook registration on the integration's row, for Settings to show. */
async function storeWebhookRegistration(registration: UnipileWebhookRegistration): Promise<UnipileWebhookRegistration> {
  const [row] = await db
    .select({ id: gridProviders.id, config: gridProviders.config })
    .from(gridProviders)
    .where(and(inOrg(gridProviders), eq(gridProviders.key, rowKey("unipile"))))
    .limit(1);
  if (row) {
    await db
      .update(gridProviders)
      .set({ config: { ...row.config, webhooks: registration }, updatedAt: new Date() })
      .where(and(inOrg(gridProviders), eq(gridProviders.id, row.id)));
  }
  return registration;
}

/** Record a Gmail watch registration on the Google integration's row, for Settings and Getting Started. */
export async function storeGmailWatchRegistration(registration: GmailWatchRegistration): Promise<void> {
  const [row] = await db
    .select({ id: gridProviders.id, config: gridProviders.config })
    .from(gridProviders)
    .where(and(inOrg(gridProviders), eq(gridProviders.key, rowKey("google"))))
    .limit(1);
  if (!row) return;
  await db
    .update(gridProviders)
    .set({ config: { ...row.config, gmailWatch: registration }, updatedAt: new Date() })
    .where(and(inOrg(gridProviders), eq(gridProviders.id, row.id)));
}

/** Register Unipile's webhooks again (Settings → Advanced → Use your own providers → Unipile → Register again). */
export async function reregisterUnipileWebhooks(): Promise<UnipileWebhookRegistration> {
  if ((await platformCredentialSource("unipile")) === "managed") throw new ManagedPlatformError("unipile");
  const own = await loadOwn("unipile");
  if (!own) throw new PlatformNotConnectedError("unipile");
  return storeWebhookRegistration(await registerUnipileWebhooks(currentOrganizationId(), normalize("unipile", own)));
}

/**
 * Registers Unipile's webhooks again when the stored registration predates
 * one AgentSDR now needs (the email webhook, added after the first two), so
 * an organization that connected Unipile earlier gets it without visiting
 * Settings. Null when nothing needed doing.
 */
export async function ensureUnipileWebhook(key: string): Promise<UnipileWebhookRegistration | null> {
  // The Included Unipile's webhooks are the platform's, registered once for every Included workspace.
  if ((await platformCredentialSource("unipile")) === "managed") return null;
  const [row] = await db
    .select({ config: gridProviders.config })
    .from(gridProviders)
    .where(and(inOrg(gridProviders), eq(gridProviders.key, rowKey("unipile"))))
    .limit(1);
  const stored = (row?.config as { webhooks?: UnipileWebhookRegistration | null } | undefined)?.webhooks;
  if (stored?.status === "registered" && stored.items?.some((item) => item.key === key)) return null;
  return reregisterUnipileWebhooks();
}

/**
 * The webhook URLs and the secret, for an admin who chose to reveal them —
 * to register them by hand when automatic registration cannot run. The
 * only place a stored secret leaves the server; the route gates it on the
 * integrations permission.
 */
export async function revealUnipileWebhookSetup(): Promise<{ endpoints: UnipileWebhookEndpoint[] | null; secret: string }> {
  // Only the organization's own secret is ever revealed; the platform's never leaves the server.
  if ((await platformCredentialSource("unipile")) === "managed") throw new ManagedPlatformError("unipile");
  const own = await loadOwn("unipile");
  if (!own) throw new PlatformNotConnectedError("unipile");
  return { endpoints: unipileWebhookEndpoints(currentOrganizationId()), secret: normalize("unipile", own).notifySecret };
}

/** Deletes the row and its credentials (cascade). Features depending on it stop at once in this process. */
export async function disconnectPlatformIntegration(key: PlatformKey): Promise<void> {
  if (key === "unipile") {
    // The organization's own Unipile's registrations only.
    const own = await loadOwn("unipile");
    if (own) await unregisterUnipileWebhooks(currentOrganizationId(), normalize("unipile", own));
  }
  await db.delete(gridProviders).where(and(inOrg(gridProviders), eq(gridProviders.key, rowKey(key))));
  cache.delete(cacheKey(key));
}

/**
 * Organizations that have `key` connected — for webhooks and workers that
 * must find which organization owns an inbound event (e.g. whose Unipile
 * notify secret matches). Runs outside any scope; callers then resolve the
 * credentials per organization inside runInOrganization(orgId, …).
 */
export async function listOrganizationsWithPlatform(key: PlatformKey): Promise<string[]> {
  const rows = await db
    .select({ organizationId: gridProviders.organizationId })
    .from(gridProviders)
    .where(and(eq(gridProviders.key, rowKey(key)), eq(gridProviders.enabled, true)));
  return rows.map((row) => row.organizationId);
}

/** Unipile's credentials as stored: the DSN given a scheme and no trailing slash. Throws a user-facing Error for a malformed DSN. */
export function normalizeUnipileCredentials(raw: Record<string, string>): PlatformCredentials["unipile"] {
  return normalize("unipile", raw);
}

function normalize<K extends PlatformKey>(key: K, raw: Record<string, string>): PlatformCredentials[K] {
  const text = (name: string) => (raw[name] ?? "").trim();
  if (key === "unipile") {
    // The dashboard shows the DSN without a scheme; accept it as shown.
    const dsn = text("baseUrl").replace(/\/+$/, "");
    const baseUrl = dsn && !/^[a-z]+:\/\//i.test(dsn) ? `https://${dsn}` : dsn;
    if (baseUrl && !/^https:\/\/[^\s/]+$/.test(baseUrl)) {
      throw new Error("Unipile DSN must look like api8.unipile.com:13851");
    }
    const value: PlatformCredentials["unipile"] = {
      baseUrl,
      apiKey: text("apiKey"),
      notifySecret: text("notifySecret"),
    };
    return value as PlatformCredentials[K];
  }
  if (key === "google") {
    const value: PlatformCredentials["google"] = {
      clientEmail: text("clientEmail"),
      privateKey: text("privateKey"),
      gmailWatchTopic: text("gmailWatchTopic"),
    };
    return value as PlatformCredentials[K];
  }
  const value: PlatformCredentials["r2"] = {
    accountId: text("accountId"),
    accessKeyId: text("accessKeyId"),
    secretAccessKey: text("secretAccessKey"),
    bucket: text("bucket"),
  };
  return value as PlatformCredentials[K];
}
