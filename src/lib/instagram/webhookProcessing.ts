import "server-only";

import { failWebhookEvent, finishWebhookEvent } from "@/lib/linkedin/webhooks/inbox";
import { serializeError } from "@/lib/linkedin/serializeError";
import { ingestInstagramWebhook, type WebhookLog, type WebhookOutcome } from "./messages";

/**
 * Processes one Instagram delivery already recorded (and claimed) in the
 * webhook ledger, and settles its row: ok or skipped, or errored with the
 * ledger's backoff — "dead" once WEBHOOK_MAX_ATTEMPTS is reached — for the
 * replay job to take again. Shared by the webhook route (after its 200) and
 * src/jobs/replayInstagramWebhooks.ts, in the organization's scope. Never
 * throws.
 *
 * `receivedAt` is when the delivery first reached AgentSDR
 * (parse.ts deliveryReceivedAt), so a replay judges history as the first
 * attempt would have.
 */
export async function processInstagramWebhookDelivery(
  eventId: string,
  payload: unknown,
  receivedAt: Date,
): Promise<WebhookOutcome> {
  const entries: WebhookLog = [];
  try {
    const status = await ingestInstagramWebhook(payload, entries, receivedAt);
    await finishWebhookEvent(eventId, status, entries);
    return status;
  } catch (error) {
    entries.push({ level: "error", message: `Unhandled error: ${serializeError(error)}`, time: new Date().toISOString() });
    console.error("[webhook/instagram-message] processing failed", error);
    await failWebhookEvent(eventId, entries).catch(() => {});
    return "error";
  }
}
