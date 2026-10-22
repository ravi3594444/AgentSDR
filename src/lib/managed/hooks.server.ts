import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import type { UnipileWebhookRegistration } from "@/lib/platform/catalog";
import { normalizeUnipileCredentials } from "@/lib/platform/credentials";
import { MANAGED_WEBHOOK_ORG, registerUnipileWebhooks, unregisterUnipileWebhooks } from "@/lib/platform/unipileWebhooks";
import type { PlatformCredentialKey } from "./catalog";
import { platformCredentials } from "./schema";
import { getPlatformCredential } from "./store.server";

/**
 * What else happens when an operator stores or removes a default key. For
 * Unipile, the platform registers its own webhooks once (org=managed, its
 * own secret) for every Included workspace, replacing its earlier ones, and
 * removes them when the key is removed. The other providers need nothing.
 */
export async function onPlatformCredentialStored(key: PlatformCredentialKey): Promise<UnipileWebhookRegistration | null> {
  if (key !== "unipile") return null;
  const values = await getPlatformCredential("unipile");
  if (!values) return null;
  const registration = await registerUnipileWebhooks(MANAGED_WEBHOOK_ORG, normalizeUnipileCredentials(values));
  const [row] = await db.select({ config: platformCredentials.config }).from(platformCredentials).where(eq(platformCredentials.provider, "unipile")).limit(1);
  if (row) await db.update(platformCredentials).set({ config: { ...row.config, webhooks: registration } }).where(eq(platformCredentials.provider, "unipile"));
  return registration;
}

/** Before the key is removed: the platform's registrations are removed with it (best effort). */
export async function onPlatformCredentialRemoved(key: PlatformCredentialKey): Promise<void> {
  if (key !== "unipile") return;
  const values = await getPlatformCredential("unipile");
  if (values) await unregisterUnipileWebhooks(MANAGED_WEBHOOK_ORG, normalizeUnipileCredentials(values));
}
