import "server-only";

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/auth/schema";
import { apifySettings } from "@/lib/apify/schema";
import { brightdataSettings } from "@/lib/brightdata/schema";
import { gridProviders } from "@/lib/grid/schema";
import { decryptIntegrationCredential } from "@/lib/integrations/credentials";
import { tavilySettings } from "@/lib/tavily/schema";
import { tinyfishSettings } from "@/lib/tinyfish/schema";
import { getOwnByokSettings } from "@/lib/ai/byok";
import { getAiConnection, getAiCredentials } from "@/lib/ai/connections";
import { getOwnPlatformCredentials } from "@/lib/platform/credentials";
import { currentOrganizationId, runInOrganization } from "@/lib/tenancy/scope";
import { normalizeManagedAiSettings, PLATFORM_CREDENTIAL_INFO, type PlatformCredentialKey } from "./catalog";
import { getManagedAiSettings, saveManagedAiSettings, storePlatformCredential, type PlatformCredentialVerifier } from "./store.server";

/**
 * Adopting an existing operator configuration as the platform's defaults.
 *
 * Only on an operator's explicit request, naming one organization (for
 * example the initial one) and which providers: nothing here guesses which
 * organization's credentials belong to the platform, and nothing runs on
 * its own. The organization's own credentials are copied, not moved: its
 * rows, its choice (My own provider) and its history stay exactly as they
 * were. Each copy is verified like any credential the operator types in, and
 * records where it came from. Unipile gets a webhook secret of its own, so
 * the organization's registrations are never shared with the platform's.
 */

export type AdoptSource = { organizationId: string; name: string; available: PlatformCredentialKey[] };

/** Organizations with credentials of their own, and which: names and provider keys only, never a secret. */
export async function adoptableSources(): Promise<AdoptSource[]> {
  const found = new Map<string, Set<PlatformCredentialKey>>();
  const add = (organizationId: string, key: PlatformCredentialKey) => {
    const set = found.get(organizationId) ?? new Set<PlatformCredentialKey>();
    set.add(key);
    found.set(organizationId, set);
  };
  for (const row of await db.select({ organizationId: gridProviders.organizationId, key: gridProviders.key, aiProviderKey: sql<string | null>`${gridProviders.config} ->> 'aiProviderKey'` }).from(gridProviders)
    .where(and(eq(gridProviders.enabled, true), sql`(${gridProviders.key} = 'platform-unipile' OR ${gridProviders.config} ->> 'aiProviderKey' IN ('openrouter', 'aimlapi'))`))) {
    if (row.key === "platform-unipile") add(row.organizationId, "unipile");
    if (row.aiProviderKey === "openrouter" || row.aiProviderKey === "aimlapi") add(row.organizationId, row.aiProviderKey);
  }
  for (const row of await db.select({ organizationId: tinyfishSettings.organizationId }).from(tinyfishSettings).where(isNotNull(tinyfishSettings.encryptedKey))) add(row.organizationId, "tinyfish");
  for (const row of await db.select({ organizationId: tavilySettings.organizationId }).from(tavilySettings).where(isNotNull(tavilySettings.encryptedKey))) add(row.organizationId, "tavily");
  for (const row of await db.select({ organizationId: brightdataSettings.organizationId }).from(brightdataSettings).where(isNotNull(brightdataSettings.encryptedKey))) add(row.organizationId, "brightdata");
  for (const row of await db.select({ organizationId: apifySettings.organizationId }).from(apifySettings).where(isNotNull(apifySettings.encryptedToken))) add(row.organizationId, "apify");
  if (!found.size) return [];
  const names = await db.select({ id: organizations.id, name: organizations.name }).from(organizations);
  return names
    .filter((org) => found.has(org.id))
    .map((org) => ({ organizationId: org.id, name: org.name, available: [...found.get(org.id)!].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The organization in scope's own values for one provider, in the platform credential's field names; null when it has none. */
async function ownValues(key: PlatformCredentialKey): Promise<{ values: Record<string, string>; ai?: Awaited<ReturnType<typeof getOwnByokSettings>> } | null> {
  switch (key) {
    case "unipile": {
      const own = await getOwnPlatformCredentials("unipile");
      // A fresh webhook secret for the platform (left blank: generated on store).
      return own ? { values: { baseUrl: own.baseUrl, apiKey: own.apiKey } } : null;
    }
    case "openrouter":
    case "aimlapi": {
      const settings = await getOwnByokSettings();
      // The AI connection the organization selected, when it is this provider's.
      const selected = settings.connectionId ? await getAiConnection(settings.connectionId) : null;
      if (!selected || selected.providerKey !== key) return null;
      const credentials = await getAiCredentials(selected.id);
      if (!credentials?.apiKey) return null;
      return { values: key === "openrouter" ? { apiKey: credentials.apiKey, managementKey: credentials.managementKey ?? "" } : { apiKey: credentials.apiKey }, ai: settings };
    }
    case "anthropic":
    case "exa":
      return null;
    case "tinyfish": {
      const [row] = await db.select({ encryptedKey: tinyfishSettings.encryptedKey }).from(tinyfishSettings).where(eq(tinyfishSettings.organizationId, currentOrganizationId())).limit(1);
      return row?.encryptedKey ? { values: { apiKey: decryptIntegrationCredential(row.encryptedKey) } } : null;
    }
    case "tavily": {
      const [row] = await db.select({ encryptedKey: tavilySettings.encryptedKey }).from(tavilySettings).where(eq(tavilySettings.organizationId, currentOrganizationId())).limit(1);
      return row?.encryptedKey ? { values: { apiKey: decryptIntegrationCredential(row.encryptedKey) } } : null;
    }
    case "brightdata": {
      const [row] = await db.select({ encryptedKey: brightdataSettings.encryptedKey, serpZone: brightdataSettings.serpZone }).from(brightdataSettings).where(eq(brightdataSettings.organizationId, currentOrganizationId())).limit(1);
      return row?.encryptedKey ? { values: { apiKey: decryptIntegrationCredential(row.encryptedKey), serpZone: row.serpZone ?? "" } } : null;
    }
    case "apify": {
      const [row] = await db.select({ encryptedToken: apifySettings.encryptedToken }).from(apifySettings).where(eq(apifySettings.organizationId, currentOrganizationId())).limit(1);
      return row?.encryptedToken ? { values: { apiKey: decryptIntegrationCredential(row.encryptedToken) } } : null;
    }
  }
}

export type AdoptResult = { adopted: PlatformCredentialKey[]; skipped: { key: PlatformCredentialKey; reason: string }[]; aiSettingsAdopted: boolean };

/**
 * Copies the named organization's own credentials for `keys` into the
 * platform's store. When an AI key is adopted and no Included engine is
 * chosen yet, that organization's AI model choice becomes the Included one.
 */
export async function adoptFromOrganization(
  organizationId: string,
  keys: PlatformCredentialKey[],
  options: { userId: string; verify: PlatformCredentialVerifier },
): Promise<AdoptResult> {
  const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (!org) throw new Error("No such organization");
  const result: AdoptResult = { adopted: [], skipped: [], aiSettingsAdopted: false };
  await runInOrganization(organizationId, async () => {
    {
      for (const key of [...new Set(keys)]) {
        if (!PLATFORM_CREDENTIAL_INFO[key]) continue;
        const own = await ownValues(key);
        if (!own) {
          result.skipped.push({ key, reason: key === "anthropic" ? "Anthropic keys are stored by the operator; no workspace has one" : "this organization has no saved credentials for it" });
          continue;
        }
        try {
          await storePlatformCredential(key, own.values, { userId: options.userId, verify: options.verify, sourceOrganizationId: organizationId });
          result.adopted.push(key);
        } catch (error) {
          result.skipped.push({ key, reason: error instanceof Error ? error.message : "could not be verified" });
          continue;
        }
        if (own.ai && (key === "openrouter" || key === "aimlapi") && !(await getManagedAiSettings()).engine && own.ai.defaultModel) {
          await saveManagedAiSettings(normalizeManagedAiSettings({
            engine: key,
            defaultModel: own.ai.defaultModel,
            researchModel: key === "aimlapi" ? own.ai.researchModel : null,
            transcriptionModel: key === "openrouter" ? own.ai.transcriptionModel : null,
            byokOnlyConfirmed: key === "openrouter" ? own.ai.byokOnlyConfirmed : false,
          }), options.userId);
          result.aiSettingsAdopted = true;
        }
      }
    }
  });
  return result;
}
