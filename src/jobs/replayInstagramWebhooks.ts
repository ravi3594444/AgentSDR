import "server-only";

import { isPlatformConnected } from "@/lib/platform/credentials";
import { claimWebhookEvent, replayableWebhookEvents, type WebhookReplayScope } from "@/lib/linkedin/webhooks/inbox";
import { deliveryReceivedAt } from "@/lib/instagram/parse";
import { processInstagramWebhookDelivery } from "@/lib/instagram/webhookProcessing";
import { runInOrganization } from "@/lib/tenancy/scope";

export type InstagramReplaySummary = {
  candidates: number;
  claimed: number;
  succeeded: number;
  failed: number;
};

/** Every Instagram delivery in the ledger (message_received and the receipts). */
export const INSTAGRAM_WEBHOOK_REPLAY_SCOPE: WebhookReplayScope = { accountType: "INSTAGRAM" };

/**
 * Processes again the Instagram webhook deliveries that failed: errored rows
 * whose backoff has passed, and rows left "processing" past the ledger's
 * lease (WEBHOOK_PROCESSING_LEASE_MS — the process died mid-way). The route
 * answers Unipile 200 before processing, so Unipile never retries these
 * itself. Runs with the LinkedIn replay (src/lib/scheduler/jobs.ts, and the
 * replay-webhooks endpoint), in the same ledger, with its backoff
 * (webhookRetryDelayMs) and attempt limit (WEBHOOK_MAX_ATTEMPTS, then
 * "dead"): claimWebhookEvent takes each row once.
 *
 * One global queue; each delivery runs in its own organization's scope,
 * exactly as the route runs it (processInstagramWebhookDelivery): what is
 * already stored is not stored again, and a stored message the CRM has not
 * recorded is forwarded again. An organization whose Unipile is not
 * connected is skipped (its rows wait), as in the LinkedIn replay: the
 * inquiry check reads the chat from Unipile.
 */
export async function replayInstagramWebhooks(limit = 100, organizationId?: string): Promise<InstagramReplaySummary> {
  const events = await replayableWebhookEvents(limit, new Date(), organizationId, INSTAGRAM_WEBHOOK_REPLAY_SCOPE);
  const summary: InstagramReplaySummary = { candidates: events.length, claimed: 0, succeeded: 0, failed: 0 };
  const unipileByOrg = new Map<string, boolean>();

  for (const { id, organizationId: eventOrganizationId } of events) {
    try {
      await runInOrganization(eventOrganizationId, async () => {
        let connected = unipileByOrg.get(eventOrganizationId);
        if (connected === undefined) {
          connected = await isPlatformConnected("unipile");
          unipileByOrg.set(eventOrganizationId, connected);
        }
        if (!connected) {
          console.log(`[replayInstagramWebhooks] Unipile is not connected for organization ${eventOrganizationId} — skipping`);
          return;
        }

        const event = await claimWebhookEvent(id);
        if (!event) return;
        summary.claimed += 1;
        const outcome = await processInstagramWebhookDelivery(event.id, event.rawBody, deliveryReceivedAt(event.createdAt));
        if (outcome === "error") summary.failed += 1;
        else summary.succeeded += 1;
      });
    } catch (error) {
      // A claim or connection check that failed (the database); the row stays due.
      console.error(`[replayInstagramWebhooks] delivery ${id} could not be replayed:`, error);
      summary.failed += 1;
    }
  }

  if (summary.candidates) console.log(`[replayInstagramWebhooks] ${JSON.stringify(summary)}`);
  return summary;
}
