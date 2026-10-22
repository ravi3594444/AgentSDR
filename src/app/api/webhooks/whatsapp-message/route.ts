import { getPlatformCredentials } from "@/lib/platform/credentials";
import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { after, type NextRequest, NextResponse } from "next/server";
import {
  beginWebhookDelivery,
  claimWebhookEvent,
  failWebhookEvent,
  finishWebhookEvent,
} from "@/lib/linkedin/webhooks/inbox";
import { serializeError } from "@/lib/linkedin/serializeError";
import { db } from "@/lib/db";
import { whatsappAccounts } from "@/lib/whatsapp/schema";
import { currentOrganizationId, runInOrganization } from "@/lib/tenancy/scope";
import { gateUnipileWebhook } from "@/lib/linkedin/organizations.server";
import { ingestWhatsappWebhook, type WebhookLog } from "@/lib/whatsapp/messages";
import { whatsappWebhookEventKey } from "@/lib/whatsapp/parse";

/**
 * POST /api/webhooks/whatsapp-message?secret=… — Unipile's messaging webhook
 * for the linked WhatsApp numbers (events message_received, message_read,
 * message_delivered). Public in proxy.ts, so it checks the notify secret
 * stored with the Unipile integration (?secret= or x-unipile-secret) itself.
 * The payload's account_id names the organization that linked the number;
 * the secret checked is that organization's, and everything after runs in
 * its scope.
 *
 * Every delivery is written raw to the webhook ledger (WebhookEvent — the
 * LinkedIn webhooks page shows it, account type WHATSAPP) before anything
 * else, which also collapses Unipile's retries. Unipile retries non-2xx and
 * gives up after 30 s, so the answer is 200 as soon as the delivery is
 * recorded; it is processed after the response (next/server `after`), and
 * the outcome lands on the ledger row. Only a failure to record answers 500,
 * so Unipile retries.
 */

/**
 * The shared secret of the organization that owns the number. Each
 * organization connects its own Unipile, so the notify secret is per
 * organization and must be read (and compared) inside that scope.
 */
async function authorized(req: NextRequest): Promise<boolean> {
  const expected = (await getPlatformCredentials("unipile"))?.notifySecret;
  const provided = req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-unipile-secret");
  if (!expected || !provided) return false;
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The organization that linked this Unipile account. Unipile account ids are
 * globally unique, so the account names its organization; this is the one
 * deliberately unscoped read, and nothing is trusted until the secret of
 * that organization matches.
 */
async function organizationOfAccount(accountId: string): Promise<string | null> {
  const [account] = await db
    .select({ organizationId: whatsappAccounts.organizationId })
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.unipileAccountId, accountId))
    .limit(1);
  return account?.organizationId ?? null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    // Nothing to resolve an organization from, so nothing can be authorized.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const payload = body as Record<string, unknown>;

  // Only WhatsApp is ours. Another provider's event (a webhook registered for
  // every account) is dropped before anything is read or recorded — a
  // LINKEDIN row in the ledger would be picked up by the LinkedIn replay job.
  const accountType = text(payload.account_type);
  if (accountType && accountType.toUpperCase() !== "WHATSAPP") {
    return NextResponse.json({ ok: true, skipped: true });
  }

  // The number names its organization; without a linked number there is no
  // organization whose secret could vouch for the request.
  const accountId = text(payload.account_id);
  const organizationId = accountId ? await organizationOfAccount(accountId) : null;

  // A URL AgentSDR registered itself carries `org=` and the secret header:
  // gateUnipileWebhook checks both, and drops an account that is not this
  // organization's. A hand-registered URL (no `org`) keeps the rule below.
  const gate = await gateUnipileWebhook(req, organizationId, accountId);
  if (gate.verdict === "reject") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (gate.verdict === "ignore") return NextResponse.json({ ok: true, skipped: true });
  if (!organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return runInOrganization(organizationId, () => handle(req, payload, gate.verdict === "accept"));
}

async function handle(req: NextRequest, payload: Record<string, unknown>, secretChecked: boolean): Promise<NextResponse> {
  if (!secretChecked && !(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const organizationId = currentOrganizationId();
  const sender = payload.sender && typeof payload.sender === "object" ? (payload.sender as Record<string, unknown>) : null;

  let eventId: string;
  try {
    const delivery = await beginWebhookDelivery(
      payload,
      {
        event: text(payload.event) ?? "unknown",
        accountType: "WHATSAPP",
        accountId: text(payload.account_id),
        senderId: text(sender?.attendee_provider_id),
        chatId: text(payload.chat_id),
        messageText: text(payload.message),
        rawBody: payload,
      },
      { providerEventKey: whatsappWebhookEventKey(payload) },
    );
    eventId = delivery.event.id;
    if (!delivery.claimed) {
      // A retry. Take it up only when the first attempt failed.
      const reclaimed = delivery.event.processingStatus === "error" ? await claimWebhookEvent(eventId) : null;
      if (!reclaimed) return NextResponse.json({ ok: true, duplicate: true });
    }
  } catch (error) {
    console.error(`[webhook/whatsapp-message] could not record delivery: ${serializeError(error)} — payload: ${JSON.stringify(payload)}`);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  // after() may not carry the request's async context, so the scope is
  // opened again from the organization resolved above.
  after(() => runInOrganization(organizationId, async () => {
    const entries: WebhookLog = [];
    try {
      const status = await ingestWhatsappWebhook(payload, entries);
      await finishWebhookEvent(eventId, status, entries);
    } catch (error) {
      entries.push({ level: "error", message: `Unhandled error: ${serializeError(error)}`, time: new Date().toISOString() });
      console.error("[webhook/whatsapp-message] processing failed", error);
      await failWebhookEvent(eventId, entries).catch(() => {});
    }
  }));

  return NextResponse.json({ ok: true });
}
