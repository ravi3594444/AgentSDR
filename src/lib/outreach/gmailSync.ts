/**
 * Syncs one mailbox's new inbound mail and feeds each message through the
 * reply bridge. Called either from the Pub/Sub push webhook (real-time,
 * pushHistoryId supplied) or as a periodic catch-up sweep.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailboxes } from "./schema";
import { inboundEvents } from "@/lib/inbox/schema";
import { fetchNewInboundMessages, isStaleHistoryCursorError, testMailboxConnection } from "./gmail";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { ingestGmailReply } from "./replyBridge";
import { createStepLogger } from "@/lib/debugLog";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

type SyncMailboxOptions = {
  fetch?: typeof fetchNewInboundMessages;
  ingest?: typeof ingestGmailReply;
  testConnection?: typeof testMailboxConnection;
};

/**
 * Runs inside the mailbox's organization scope — the Pub/Sub webhook resolves
 * the mailbox to its organization and opens the scope before calling this.
 * A mailbox of another organization is simply not found.
 */
export async function syncMailboxInbox(mailboxId: string, options: SyncMailboxOptions = {}) {
  if (!options.fetch && !(await isPlatformConnected("google"))) {
    console.log("[outreach/gmailSync] Google Workspace is not connected; inbox sync skipped");
    return { synced: 0 };
  }
  const [mailbox] = await db.select().from(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId))).limit(1);
  if (!mailbox || mailbox.status !== "connected") return { synced: 0 };
  if (mailbox.provider !== "google") return { synced: 0 }; // Unipile mailboxes are fed by its email webhook
  if (!mailbox.lastHistoryId) return { synced: 0 }; // nothing to diff against yet

  let syncResult;
  try {
    syncResult = await (options.fetch ?? fetchNewInboundMessages)(mailbox.emailAddress, mailbox.lastHistoryId);
  } catch (err) {
    // A stale cursor (Gmail's history retention window passed, or the
    // stored id predates it) means every future push would fail identically
    // forever unless we re-bootstrap — jump the cursor to "now" so future
    // pushes resume working. This does mean any mail that arrived between
    // the last successful sync and now is missed; there's no way to recover
    // that once the cursor itself is gone (Gmail's own limitation).
    if (isStaleHistoryCursorError(err)) {
      const test = await (options.testConnection ?? testMailboxConnection)(mailbox.emailAddress);
      await db
        .update(mailboxes)
        .set({
          lastHistoryId: test.ok ? test.historyId : mailbox.lastHistoryId,
          lastError: "history cursor expired — re-bootstrapped to current inbox state; messages received during the gap were not synced",
        })
        .where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
      return { synced: 0, error: "stale_cursor_rebootstrapped" };
    }

    const message = err instanceof Error ? err.message : String(err);
    await db.update(mailboxes).set({ lastError: `sync failed: ${message}` }).where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
    throw err;
  }

  const { messages, newHistoryId } = syncResult;

  let synced = 0;
  const failures: string[] = [];
  for (const msg of messages) {
    const log = createStepLogger();
    log.info(`Gmail inbound message ${msg.gmailMessageId} — processing`);
    try {
      const result = await (options.ingest ?? ingestGmailReply)(mailbox.emailAddress, msg, log);
      log.finish(result.skipped ? "skipped" : "ok");
      await db.insert(inboundEvents).values({
        organizationId: currentOrganizationId(),
        source: "gmail",
        eventType: "inbound_message",
        title: msg.fromName || msg.fromEmail || null,
        status: log.status,
        steps: log.steps,
        payload: msg as unknown as object,
        processed: true,
      });
      if (!result.skipped) synced += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(message);
      log.finish("error");
      await db.insert(inboundEvents).values({
        organizationId: currentOrganizationId(),
        source: "gmail",
        eventType: "inbound_message",
        title: msg.fromName || msg.fromEmail || null,
        status: log.status,
        steps: log.steps,
        payload: msg as unknown as object,
        processed: false,
        error: message,
      });
      failures.push(`${msg.gmailMessageId}: ${message}`);
    }
  }

  if (failures.length > 0) {
    const message = `sync incomplete; ${failures.length} message(s) require retry: ${failures.join("; ")}`;
    await db.update(mailboxes).set({ lastError: message }).where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
    throw new Error(message);
  }

  if (newHistoryId && newHistoryId !== mailbox.lastHistoryId) {
    await db.update(mailboxes).set({ lastHistoryId: newHistoryId, lastError: null }).where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
  }

  return { synced };
}
