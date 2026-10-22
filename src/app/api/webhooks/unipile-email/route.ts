import { getPlatformCredentials } from "@/lib/platform/credentials";
import { timingSafeEqual } from "node:crypto";
import { after, type NextRequest, NextResponse } from "next/server";
import { createStepLogger } from "@/lib/debugLog";
import {
  beginWebhookDelivery,
  claimWebhookEvent,
  failWebhookEvent,
  finishWebhookEvent,
} from "@/lib/linkedin/webhooks/inbox";
import { serializeError } from "@/lib/linkedin/serializeError";
import { currentOrganizationId, runInOrganization } from "@/lib/tenancy/scope";
import { gateUnipileWebhook } from "@/lib/linkedin/organizations.server";
import { ingestUnipileEmail, organizationOfUnipileMailbox } from "@/lib/outreach/unipileInbound";
import { unipileEmailEventKey } from "@/lib/outreach/unipileMail";

/**
 * POST /api/webhooks/unipile-email?org=… — Unipile's email webhook (event
 * mail_received) for inboxes linked in Unipile and used as sending
 * mailboxes. Registered with the others when the Unipile integration is
 * saved (src/lib/platform/unipileWebhooks.ts); public in proxy.ts, so it
 * checks the organization's Unipile webhook secret itself, the same way
 * /api/webhooks/whatsapp-message does. The payload's account_id names the
 * mailbox, and the mailbox its organization.
 *
 * Every delivery is written to the webhook ledger (WebhookEvent, account
 * type EMAIL) first, which also collapses Unipile's retries; the answer is
 * 200 as soon as it is recorded, and the email is filed after the response
 * (next/server `after`). Only a failure to record answers 500, so Unipile
 * retries.
 */

async function authorized(req: NextRequest): Promise<boolean> {
  const expected = (await getPlatformCredentials("unipile"))?.notifySecret;
  const provided = req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-unipile-secret");
  if (!expected || !provided) return false;
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const payload = body as Record<string, unknown>;

  const accountId = text(payload.account_id);
  const organizationId = accountId ? await organizationOfUnipileMailbox(accountId) : null;

  const gate = await gateUnipileWebhook(req, organizationId, accountId);
  if (gate.verdict === "reject") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (gate.verdict === "ignore") return NextResponse.json({ ok: true, skipped: true });
  if (!organizationId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return runInOrganization(organizationId, () => handle(req, payload, gate.verdict === "accept"));
}

async function handle(req: NextRequest, payload: Record<string, unknown>, secretChecked: boolean): Promise<NextResponse> {
  if (!secretChecked && !(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Only new mail is ours; mail_sent / mail_moved are acknowledged and dropped.
  const event = text(payload.event) ?? "unknown";
  if (event !== "mail_received") return NextResponse.json({ ok: true, skipped: true });

  const organizationId = currentOrganizationId();
  const from = payload.from_attendee && typeof payload.from_attendee === "object" ? (payload.from_attendee as Record<string, unknown>) : null;

  let eventId: string;
  try {
    const delivery = await beginWebhookDelivery(
      payload,
      {
        event,
        accountType: "EMAIL",
        accountId: text(payload.account_id),
        senderId: text(from?.identifier),
        chatId: text(payload.thread_id),
        messageText: text(payload.subject),
        rawBody: payload,
      },
      { providerEventKey: unipileEmailEventKey(payload) },
    );
    eventId = delivery.event.id;
    if (!delivery.claimed) {
      const reclaimed = delivery.event.processingStatus === "error" ? await claimWebhookEvent(eventId) : null;
      if (!reclaimed) return NextResponse.json({ ok: true, duplicate: true });
    }
  } catch (error) {
    console.error(`[webhook/unipile-email] could not record delivery: ${serializeError(error)}`);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  after(() => runInOrganization(organizationId, async () => {
    const log = createStepLogger();
    try {
      const status = await ingestUnipileEmail(payload, log);
      await finishWebhookEvent(eventId, status, log.steps);
    } catch (error) {
      console.error("[webhook/unipile-email] processing failed", error);
      await failWebhookEvent(eventId, log.steps).catch(() => {});
    }
  }));

  return NextResponse.json({ ok: true });
}
