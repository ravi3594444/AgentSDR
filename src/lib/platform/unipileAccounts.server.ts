import "server-only";

import { syncAllAccounts } from "@/functions/syncAllAccounts";
import { syncInstagramAccounts } from "@/lib/instagram/accounts";
import { syncUnipileMailboxes } from "@/lib/outreach/mailboxProviders";
import { syncWhatsappAccounts } from "@/lib/whatsapp/accounts";
import { runInOrganization } from "@/lib/tenancy/scope";

/**
 * After a Unipile connection is saved: every account list read again from
 * it (LinkedIn, WhatsApp, Instagram, email), so accounts the new workspace
 * does not list stop showing as connected now rather than at the next
 * worker sync, and the ones it lists appear. Each runs on its own; one
 * failing is logged and the others still run. The save route does not wait
 * for it.
 */
export async function resyncUnipileAccounts(organizationId: string): Promise<void> {
  const syncs: [string, () => Promise<unknown>][] = [
    ["LinkedIn", syncAllAccounts],
    ["WhatsApp", syncWhatsappAccounts],
    ["Instagram", syncInstagramAccounts],
    ["email", syncUnipileMailboxes],
  ];
  await runInOrganization(organizationId, async () => {
    for (const [channel, sync] of syncs) {
      try {
        await sync();
      } catch (error) {
        console.error(`[platform] Reading the ${channel} accounts after the Unipile connection was saved failed:`, error);
      }
    }
  });
}
