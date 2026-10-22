import "server-only";

import type { PlatformCredentialKey } from "./catalog";

/**
 * What else happens when an operator stores or removes a default key. Unipile
 * registers or removes the platform's own webhooks (src/lib/unipile/); the
 * other providers need nothing.
 */
export async function onPlatformCredentialStored(key: PlatformCredentialKey): Promise<void> {
  void key;
}

export async function onPlatformCredentialRemoved(key: PlatformCredentialKey): Promise<void> {
  void key;
}
