import "server-only";

import { failWebhookEvent, finishWebhookEvent } from "@/lib/linkedin/webhooks/inbox";
import { serializeError } from "@/lib/linkedin/serializeError";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ingestInstagramWebhook, type WebhookLog, type WebhookOutcome } from "./messages";
import { clockSkewMs } from "./parse";

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
let cachedSkew: { value: number; at: number } | null = null;

/**
 * The correction for the ledger's createdAt (parse.ts clockSkewMs): the
 * database's local clock as the driver reads it, minus the real time.
 * Cached for an hour; on any error 0, the reading used before.
 */
export async function ledgerClockSkewMs(): Promise<number> {
  if (cachedSkew && Date.now() - cachedSkew.at < 60 * 60 * 1000) return cachedSkew.value;
  try {
    const rows = (await db.execute(sql`select localtimestamp as local_now`)) as unknown as { local_now: Date | string }[];
    const raw = rows[0]?.local_now;
    // Parsed exactly as Drizzle parses the ledger's createdAt (a zone-less value taken as UTC).
    const localNow = raw instanceof Date ? raw : new Date(`${String(raw)}+0000`);
    if (Number.isNaN(localNow.getTime())) return 0;
    cachedSkew = { value: clockSkewMs(localNow, new Date()), at: Date.now() };
    return cachedSkew.value;
  } catch {
    return 0;
  }
}

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
