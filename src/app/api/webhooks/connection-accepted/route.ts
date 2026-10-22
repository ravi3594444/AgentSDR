import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaigns, connections, leads, linkedInAccounts, webhookEvents } from "@/lib/linkedin/schema";
import { getChatIdForUser } from "@/services/unipile.service";
import { processLeadAcceptance } from "@/lib/linkedin/acceptanceMessage";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { serializeError } from "@/lib/linkedin/serializeError";
import { companies, people } from "@/lib/leads/schema";
import { personProfile } from "@/lib/leads/variables";
import {
  beginWebhookDelivery,
  failWebhookEvent,
  finishWebhookEvent,
  internalWebhookReplayId,
} from "@/lib/linkedin/webhooks/inbox";
import { currentOrganizationId, inOrg, maybeCurrentOrganizationId, runInOrganization } from "@/lib/tenancy/scope";
import { checkUnipileWebhookSecret, gateUnipileWebhook, organizationIdForLinkedinAccount } from "@/lib/linkedin/organizations.server";

type LogLevel = "info" | "warn" | "error";
type LogEntry = { level: LogLevel; message: string; time: string };

function makeLogger() {
  const entries: LogEntry[] = [];
  const add = (level: LogLevel, message: string) => {
    entries.push({ level, message, time: new Date().toISOString() });
  };
  return {
    info: (msg: string) => add("info", msg),
    warn: (msg: string) => add("warn", msg),
    error: (msg: string) => add("error", msg),
    entries,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Unipile payloads are untyped JSON read field by field
type WebhookBody = any;

// Unipile calls this without a session. URLs AgentSDR registers itself carry
// `org=` and the organization's secret header, and gateUnipileWebhook holds
// them to both. Hand-registered URLs (no `org`) keep the older rule below.
// The organization comes from the data:
// payload account_id -> LinkedInAccount.linkedinId (globally unique) -> its
// organization. An unknown account is acknowledged and ignored, so Unipile
// does not retry it forever. A secret, when the request carries one, must
// match that organization's stored Unipile notify secret.
export async function POST(req: NextRequest) {
  let body: WebhookBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  const replay = internalWebhookReplayId(req) !== null;
  const accountId = typeof body?.account_id === "string" ? body.account_id : null;
  const organizationId = replay && maybeCurrentOrganizationId()
    ? maybeCurrentOrganizationId()
    : accountId ? await organizationIdForLinkedinAccount(accountId) : null;
  const gate = replay ? ({ verdict: "legacy" } as const) : await gateUnipileWebhook(req, organizationId, accountId);
  if (gate.verdict === "reject") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (gate.verdict === "ignore") {
    console.warn(`[webhook/connection-accepted] Account ${accountId ?? "?"} ignored: ${gate.reason}`);
    return NextResponse.json({ ok: true });
  }
  if (!organizationId) {
    console.warn(`[webhook/connection-accepted] No organization for account ${accountId ?? "?"} — ignored`);
    return NextResponse.json({ ok: true });
  }

  return runInOrganization(organizationId, async () => {
    if (!replay && gate.verdict === "legacy") {
      const secret = await checkUnipileWebhookSecret(organizationId, req);
      if (secret === "mismatch") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      if (secret === "absent") console.warn("[webhook/connection-accepted] Request carries no secret — accepted");
    }
    return handle(req, body);
  });
}

async function handle(req: NextRequest, body: WebhookBody) {
  const response = NextResponse.json({ ok: true });
  const log = makeLogger();
  let webhookEventId: string | null = null;

  try {

    const replayEventId = internalWebhookReplayId(req);
    const delivery = replayEventId
      ? { event: { id: replayEventId }, claimed: true }
      : await beginWebhookDelivery(body, {
        event: body.event ?? "unknown",
        accountType: body.account_type ?? null,
        accountId: body.account_id ?? null,
        senderId: body.user_provider_id ?? null,
        chatId: null,
        messageText: null,
        rawBody: body,
      });
    const webhookEvent = delivery.event;
    webhookEventId = webhookEvent.id;
    if (!delivery.claimed) return response;

    const finish = async (status: string) => {
      await finishWebhookEvent(webhookEvent.id, status, log.entries);
    };

    if (body.event !== "new_relation" || body.account_type !== "LINKEDIN") {
      log.info(`Event "${body.event}" ignored — not a new_relation LINKEDIN event`);
      await finish("skipped");
      return response;
    }

    log.info(`new_relation event received — processing connection acceptance`);

    const accountLinkedinId: string | undefined = body.account_id;
    const senderProviderId: string | undefined = body.user_provider_id;

    if (!accountLinkedinId || !senderProviderId) {
      log.error(`Missing required fields — account_id: ${accountLinkedinId}, user_provider_id: ${senderProviderId}`);
      await finish("error");
      return response;
    }

    log.info(`Sender provider ID: ${senderProviderId}`);
    log.info(`Account LinkedIn ID: ${accountLinkedinId}`);

    const [account] = await db
      .select()
      .from(linkedInAccounts)
      .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.linkedinId, accountLinkedinId)))
      .limit(1);
    if (!account) {
      log.warn(`No LinkedInAccount found for linkedinId=${accountLinkedinId} — account not synced yet`);
      await finish("skipped");
      return response;
    }
    log.info(`Matched account: @${account.username}`);

    const senderName: string | null = body.user_full_name ?? null;
    const linkedinUrl: string | null = body.user_profile_url ?? null;
    const profilePictureUrl: string | null = body.user_picture_url ?? null;

    const requestCandidates = await db
      .select({ lead: leads, person: people, company: companies, campaignStatus: campaigns.status, campaignAcceptanceMessage: campaigns.acceptanceMessage })
      .from(leads)
      .innerJoin(people, eq(leads.personId, people.id))
      .leftJoin(companies, eq(people.companyId, companies.id))
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(and(
        inOrg(leads),
        eq(leads.providerId, senderProviderId),
        eq(leads.linkedinAccountId, account.id),
        eq(leads.status, "REQUEST_SENT"),
        isNull(leads.supersededByLeadId),
      ))
      .orderBy(desc(leads.requestSentAt), desc(leads.createdAt))
      .limit(2);
    if (requestCandidates.length > 1) {
      log.error(`Ambiguous provider/account match across ${requestCandidates.length} REQUEST_SENT Leads — no campaign state changed`);
      await finish("error");
      return response;
    }
    const fallbackLeads = requestCandidates.length ? [] : await db
      .select({ lead: leads, person: people, company: companies, campaignStatus: campaigns.status, campaignAcceptanceMessage: campaigns.acceptanceMessage })
      .from(leads)
      .innerJoin(people, eq(leads.personId, people.id))
      .leftJoin(companies, eq(people.companyId, companies.id))
      .innerJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(and(
        inOrg(leads),
        eq(leads.providerId, senderProviderId),
        eq(leads.linkedinAccountId, account.id),
        isNull(leads.supersededByLeadId),
      ))
      .orderBy(desc(leads.requestSentAt), desc(leads.createdAt))
      .limit(2);
    if (fallbackLeads.length > 1) {
      log.error(`Ambiguous provider/account fallback across ${fallbackLeads.length} Leads — no campaign state changed`);
      await finish("error");
      return response;
    }
    const leadRow = requestCandidates[0] ?? fallbackLeads[0];
    const lead = leadRow ? { ...leadRow.lead, acceptanceMessage: leadRow.campaignAcceptanceMessage ?? leadRow.lead.acceptanceMessage, ...personProfile(leadRow.person, leadRow.company), campaignStatus: leadRow.campaignStatus } : null;
    if (lead) {
      log.info(`Lead found in DB: ${lead.linkedinUrl} (status: ${lead.status})`);
    } else {
      log.warn(`No lead found for providerId=${senderProviderId} — connection will be recorded without lead`);
    }

    log.info(`Looking up chatId via Unipile for sender ${senderProviderId}`);
    const chatId = await getChatIdForUser(senderProviderId, accountLinkedinId);
    if (chatId) {
      log.info(`chatId resolved: ${chatId}`);
    } else {
      log.warn(`chatId not available yet — acceptance message will be retried in next outreach cycle`);
    }

    const [connection] = await db
      .insert(connections)
      .values({
        organizationId: currentOrganizationId(),
        providerId: senderProviderId,
        name: lead?.name ?? senderName,
        headline: lead?.headline ?? null,
        profilePictureUrl: lead?.profilePictureUrl ?? profilePictureUrl,
        linkedinUrl: lead?.linkedinUrl ?? linkedinUrl,
        chatId: chatId ?? null,
        leadId: lead?.id ?? null,
        linkedinAccountId: account.id,
        connectedAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [connections.providerId, connections.linkedinAccountId],
        // Keys left `undefined` are omitted from the UPDATE, matching Prisma's
        // "leave the column alone" semantics. `updatedAt` is always set so the
        // SET clause is never empty (Prisma's @updatedAt bumped it too).
        set: {
          ...(chatId ? { chatId } : {}),
          name: lead?.name ?? senderName ?? undefined,
          profilePictureUrl: lead?.profilePictureUrl ?? profilePictureUrl ?? undefined,
          linkedinUrl: lead?.linkedinUrl ?? linkedinUrl ?? undefined,
          ...(lead && { leadId: lead.id, headline: lead.headline ?? undefined }),
          updatedAt: new Date(),
        },
      })
      .returning();
    log.info(`Connection upserted: id=${connection.id}`);

    // The acceptance is the freshest picture we get for a person who was
    // imported without one, and the only picture at all for a lead that
    // never went through profile resolution.
    if (lead && profilePictureUrl) {
      await db.update(people)
        .set({ profilePictureUrl, updatedAt: new Date() })
        .where(and(inOrg(people), eq(people.id, lead.personId), isNull(people.profilePictureUrl)));
    }

    await db
      .update(webhookEvents)
      .set({ connectionId: connection.id })
      .where(and(inOrg(webhookEvents), eq(webhookEvents.id, webhookEvent.id)));

    if (!lead) {
      log.info(`No lead in system — connection recorded, nothing more to do`);
      await finish("ok");
      return response;
    }

    if (lead.status !== "REQUEST_SENT") {
      log.info(`Lead status is ${lead.status} (not REQUEST_SENT) — skipping acceptance to avoid double-send`);
      await finish("skipped");
      return response;
    }
    if (lead.campaignStatus !== "ACTIVE") {
      log.info(`Campaign is ${lead.campaignStatus ?? "missing"} — connection recorded but automated acceptance paused`);
      await finish("skipped");
      return response;
    }
    if (isMigrationControlPaused("linkedinOutbound")) {
      log.info("LinkedIn outbound is paused — connection recorded and acceptance left retryable");
      await finish("skipped");
      return response;
    }

    const acceptanceResult = await processLeadAcceptance(
      lead,
      { id: connection.id, providerId: connection.providerId, chatId: connection.chatId ?? chatId },
      account,
      (msg) => log.info(msg)
    );

    if (acceptanceResult === "blocked") {
      log.warn("Acceptance blocked by Person-global DNC; lead marked FAILED");
    } else if (acceptanceResult === "retry") {
      log.warn(`No chatId — leaving lead as REQUEST_SENT; sendMissedAcceptances will retry next cycle`);
    } else {
      log.info(`Lead status advanced: REQUEST_SENT → ACCEPT_MESSAGE_SENT`);
    }

    await finish("ok");
  } catch (err) {
    const errMsg = serializeError(err);
    log.error(`Unhandled error: ${errMsg}`);
    console.error("[webhook/connection-accepted] Error:", err);
    try {
      if (webhookEventId) {
        await failWebhookEvent(webhookEventId, log.entries);
      }
    } catch {}
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return response;
}
