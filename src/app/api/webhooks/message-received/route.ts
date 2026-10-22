import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { campaigns, connections, leads, linkedInAccounts, webhookEvents } from "@/lib/linkedin/schema";
import type { LeadStatus } from "@/lib/linkedin/schema";
import { saveInboundMessage } from "@/lib/linkedin/messages/inboundMessage";
import { processLeadAcceptance } from "@/lib/linkedin/acceptanceMessage";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { serializeError } from "@/lib/linkedin/serializeError";
import { companies, people } from "@/lib/leads/schema";
import { personProfile } from "@/lib/leads/variables";
import { fillTemplate } from "@/lib/outreach/render";
import {
  beginWebhookDelivery,
  failWebhookEvent,
  finishWebhookEvent,
  internalWebhookReplayId,
} from "@/lib/linkedin/webhooks/inbox";
import { currentOrganizationId, inOrg, maybeCurrentOrganizationId, runInOrganization } from "@/lib/tenancy/scope";
import { checkUnipileWebhookSecret, gateUnipileWebhook, organizationIdForLinkedinAccount } from "@/lib/linkedin/organizations.server";

const REPLY_STATUSES: LeadStatus[] = [
  "ACCEPT_MESSAGE_SENT",
  "FOLLOW_UP_1_SENT",
  "FOLLOW_UP_2_SENT",
  "FOLLOW_UP_3_SENT",
  "COMPLETED",
];

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
    console.warn(`[webhook/message-received] Account ${accountId ?? "?"} ignored: ${gate.reason}`);
    return NextResponse.json({ ok: true });
  }
  if (!organizationId) {
    console.warn(`[webhook/message-received] No organization for account ${accountId ?? "?"} — ignored`);
    return NextResponse.json({ ok: true });
  }

  return runInOrganization(organizationId, async () => {
    if (!replay && gate.verdict === "legacy") {
      const secret = await checkUnipileWebhookSecret(organizationId, req);
      if (secret === "mismatch") return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      if (secret === "absent") console.warn("[webhook/message-received] Request carries no secret — accepted");
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
        senderId: body.sender?.attendee_provider_id ?? null,
        chatId: body.chat_id ?? null,
        messageText: body.message ?? null,
        rawBody: body,
      });
    const webhookEvent = delivery.event;
    webhookEventId = webhookEvent.id;
    if (!delivery.claimed) return response;

    const finish = async (status: string) => {
      await finishWebhookEvent(webhookEvent.id, status, log.entries);
    };

    if (body.event !== "message_received" || body.account_type !== "LINKEDIN") {
      log.info(`Event "${body.event}" ignored — not a message_received LINKEDIN event`);
      await finish("skipped");
      return response;
    }

    log.info(`message_received event — processing inbound message`);

    const accountLinkedinId: string | undefined = body.account_id;
    const senderProviderId: string | undefined = body.sender?.attendee_provider_id;
    const messageText: string = body.message ?? "";
    const chatId: string | undefined = body.chat_id;
    const incomingMessageId: string | undefined = body.message_id ?? body.id;

    const isSender: boolean = body.is_sender === true;
    const attendees: Array<{
      attendee_name?: string | null;
      attendee_provider_id?: string | null;
      attendee_specifics?: { occupation?: string | null } | null;
    }> = Array.isArray(body.attendees) ? body.attendees : [];
    const accountUserProviderId: string | undefined = body.account_info?.user_id;

    // For message echoes (is_sender=true), sender.* is our own account.
    // We need the counterparty participant to map to a Lead.
    let participantProviderId: string | undefined = senderProviderId;
    let participantName: string | null = body.sender?.attendee_name ?? null;
    let participantHeadline: string | null = body.sender?.attendee_specifics?.occupation ?? null;
    if (isSender) {
      const otherParticipant = attendees.find((a) => {
        const id = a?.attendee_provider_id;
        return (
          typeof id === "string" &&
          id.length > 0 &&
          id !== senderProviderId &&
          id !== accountUserProviderId
        );
      });
      if (otherParticipant?.attendee_provider_id) {
        participantProviderId = otherParticipant.attendee_provider_id;
        participantName = otherParticipant.attendee_name ?? participantName;
        participantHeadline = otherParticipant.attendee_specifics?.occupation ?? participantHeadline;
        log.info(`is_sender=true detected — using counterparty providerId: ${participantProviderId}`);
      } else {
        // sender.* is our own LinkedIn account on echoed outbound messages.
        // Treating it as the counterparty creates a bogus Connection and CRM
        // identity exception for ourselves, so an echo without a resolvable
        // attendee is not safe to ingest.
        log.warn(`is_sender=true but no counterparty attendee found — skipping unresolved echo`);
        await finish("skipped");
        return response;
      }
    }

    if (!accountLinkedinId || !participantProviderId) {
      log.error(`Missing required fields — account_id: ${accountLinkedinId}, participant provider_id: ${participantProviderId}`);
      await finish("error");
      return response;
    }

    // When someone accepts a connection request, Unipile echoes back our invitation message
    // as a message_received with is_sender=true. That echo IS the acceptance signal we rely on —
    // do NOT skip it here. We only skip is_sender messages that are NOT acceptance echoes
    // (e.g. our own follow-up messages being echoed back after sending).
    // The acceptance echo check happens further down once we know the lead's status.

    log.info(`Sender: ${participantName ?? participantProviderId} | chatId: ${chatId ?? "none"} | message: "${messageText.slice(0, 60)}${messageText.length > 60 ? "…" : ""}"`);

    const [account] = await db
      .select()
      .from(linkedInAccounts)
      .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.linkedinId, accountLinkedinId)))
      .limit(1);
    if (!account) {
      log.warn(`No LinkedInAccount found for linkedinId=${accountLinkedinId}`);
      await finish("skipped");
      return response;
    }
    log.info(`Matched account: @${account.username}`);

    // `include: { campaign: { select: { type: true } } }` becomes a leftJoin
    // (campaignId is nullable) reshaped back into `lead.campaign`.
    const leadRows = await db
      .select({ lead: leads, person: people, company: companies, campaignType: campaigns.type, campaignStatus: campaigns.status, campaignInvitationMessage: campaigns.invitationMessage, campaignAcceptanceMessage: campaigns.acceptanceMessage })
      .from(leads)
      .innerJoin(people, eq(leads.personId, people.id))
      .leftJoin(companies, eq(people.companyId, companies.id))
      .leftJoin(campaigns, eq(leads.campaignId, campaigns.id))
      .where(and(
        inOrg(leads),
        eq(leads.providerId, participantProviderId),
        eq(leads.linkedinAccountId, account.id),
        isNull(leads.supersededByLeadId),
      ))
      .orderBy(desc(leads.requestSentAt), desc(leads.createdAt))
      .limit(2);
    if (leadRows.length > 1) {
      log.error(`Ambiguous provider/account match across ${leadRows.length} Leads — inbound message was not assigned to a campaign`);
      await finish("error");
      return response;
    }
    const [leadRow] = leadRows;
    const lead = leadRow
      ? { ...leadRow.lead, invitationMessage: leadRow.campaignInvitationMessage ?? leadRow.lead.invitationMessage, acceptanceMessage: leadRow.campaignAcceptanceMessage ?? leadRow.lead.acceptanceMessage, ...personProfile(leadRow.person, leadRow.company), campaign: leadRow.campaignType ? { type: leadRow.campaignType, status: leadRow.campaignStatus } : null }
      : undefined;
    if (lead) {
      log.info(`Lead found: ${lead.linkedinUrl} (status: ${lead.status})`);
    } else {
      log.warn(`No lead found for providerId=${participantProviderId} — message will be saved to connection only`);
    }

    // Personal campaigns are private outreach — never forward their replies to AgentSDR's CRM.
    const isPersonalCampaignLead = lead?.campaign?.type === "PERSONAL";

    const [connection] = await db
      .insert(connections)
      .values({
        organizationId: currentOrganizationId(),
        providerId: participantProviderId,
        name: lead?.name ?? participantName,
        headline: lead?.headline ?? participantHeadline,
        profilePictureUrl: lead?.profilePictureUrl ?? null,
        linkedinUrl: lead?.linkedinUrl ?? null,
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
          chatId: chatId ?? undefined,
          name: lead?.name ?? participantName ?? undefined,
          headline: lead?.headline ?? participantHeadline ?? undefined,
          linkedinUrl: lead?.linkedinUrl ?? undefined,
          ...(lead && { profilePictureUrl: lead.profilePictureUrl, leadId: lead.id }),
          updatedAt: new Date(),
        },
      })
      .returning();
    log.info(`Connection upserted: id=${connection.id}`);

    await db
      .update(webhookEvents)
      .set({ connectionId: connection.id })
      .where(and(inOrg(webhookEvents), eq(webhookEvents.id, webhookEvent.id)));

    if (!lead) {
      if (isSender) {
        log.info(`Message from ourselves (is_sender=true) with no linked lead — skipping`);
        await finish("skipped");
        return response;
      }
      // Keep unsolicited LinkedIn messages visible in the LinkedIn inbox, but
      // do not turn every connection message into CRM work. A CRM record is
      // created only for a Person we actually enrolled in outreach, matching
      // the Gmail rule that ignores senders who were never outreach targets.
      await saveInboundMessage({
        text: messageText,
        linkedinMessageId: incomingMessageId,
        connectionId: connection.id,
      });
      log.info(`Message saved to LinkedIn inbox only — sender is not an AgentSDR campaign lead`);
      await finish("ok");
      return response;
    }

    // If this message was sent by us (is_sender=true) and the lead is not in REQUEST_SENT,
    // it's an echo of one of our own sent messages (follow-up, acceptance, etc.) — skip it.
    // The only is_sender=true message we process is the acceptance echo, which arrives
    // when the lead is still in REQUEST_SENT and the text matches the invitation.
    if (isSender && lead.status !== "REQUEST_SENT") {
      log.info(`Message from ourselves (is_sender=true) in status ${lead.status} — skipping echo of our own sent message`);
      await finish("skipped");
      return response;
    }

    // ── Lead is REQUEST_SENT ──
    if (lead.status === "REQUEST_SENT") {
      // Product decision: if we're the sender and lead is still REQUEST_SENT,
      // treat this webhook as acceptance echo (no text match required).
      const isAcceptanceEcho = isSender;

      if (isAcceptanceEcho) {
        if (lead.campaign?.status !== "ACTIVE") {
          log.info(`Campaign is ${lead.campaign?.status ?? "missing"} — skipping automated acceptance while paused`);
          await finish("skipped");
          return response;
        }
        if (isMigrationControlPaused("linkedinOutbound")) {
          log.info("LinkedIn outbound is paused — acceptance echo recorded and delivery left retryable");
          await finish("skipped");
          return response;
        }
        log.info(`is_sender=true while REQUEST_SENT — treating as acceptance echo`);

        const acceptanceResult = await processLeadAcceptance(
          lead,
          { id: connection.id, providerId: connection.providerId, chatId: connection.chatId },
          account,
          (message) => log.info(message),
        );
        if (acceptanceResult === "retry") log.warn("Acceptance delivery deferred until a chat is available");
        if (acceptanceResult === "blocked") log.warn("Acceptance blocked by Person-global DNC");
      } else {
        log.info(`Message is a genuine reply while in REQUEST_SENT — saving as RECEIVED and advancing to REPLIED`);
        if (isPersonalCampaignLead) {
          log.info(`Lead belongs to a personal campaign — skipping AgentSDR forward`);
        }
        await saveInboundMessage({
          text: messageText,
          linkedinMessageId: incomingMessageId,
          connectionId: connection.id,
          leadId: lead.id,
          forward: isPersonalCampaignLead
            ? undefined
            : {
                personId: lead.personId,
                providerId: participantProviderId,
                name: lead.name ?? participantName,
                headline: lead.headline ?? participantHeadline,
                linkedinUrl: lead.linkedinUrl ?? connection.linkedinUrl,
                chatId,
                accountId: account.linkedinId,
                accountUsername: account.username,
                sentAt: new Date(),
              },
        });
        await db.update(leads).set({ status: "REPLIED" }).where(and(inOrg(leads), eq(leads.id, lead.id)));
        log.info(`Lead status advanced: REQUEST_SENT → REPLIED`);
      }
      await finish("ok");
      return response;
    }

    // ── Lead is in a post-acceptance status or ongoing REPLIED conversation ──
    const handlesInboundReply =
      REPLY_STATUSES.includes(lead.status) || lead.status === "REPLIED";

    if (handlesInboundReply) {
      const isLateEcho =
        lead.status === "ACCEPT_MESSAGE_SENT" &&
        lead.invitationMessage &&
        messageText.trim() === fillTemplate(lead.invitationMessage, lead.variables).trim();

      if (isLateEcho) {
        log.info(`Late echo detected (invitation text arrived after ACCEPT_MESSAGE_SENT) — ignoring`);
        await finish("skipped");
        return response;
      }

      if (isPersonalCampaignLead) {
        log.info(`Lead belongs to a personal campaign — skipping AgentSDR forward`);
      }
      const result = await saveInboundMessage({
        text: messageText,
        linkedinMessageId: incomingMessageId,
        connectionId: connection.id,
        leadId: lead.id,
        forward: isPersonalCampaignLead
          ? undefined
          : {
              personId: lead.personId,
              providerId: participantProviderId,
              name: lead.name ?? participantName,
              headline: lead.headline ?? participantHeadline,
              linkedinUrl: lead.linkedinUrl ?? connection.linkedinUrl,
              chatId,
              accountId: account.linkedinId,
              accountUsername: account.username,
              sentAt: new Date(),
            },
      });

      if (result === "duplicate") {
        log.info(`Duplicate inbound message — already stored`);
      }
      if (lead.status === "REPLIED") {
        log.info(`Follow-up inbound message saved on REPLIED thread`);
      } else {
        log.info(`Genuine reply received — advancing to REPLIED (was: ${lead.status})`);
        await db.update(leads).set({ status: "REPLIED" }).where(and(inOrg(leads), eq(leads.id, lead.id)));
        log.info(`Lead status advanced: ${lead.status} → REPLIED`);
      }
    }

    await finish("ok");
  } catch (err) {
    const errMsg = serializeError(err);
    log.error(`Unhandled error: ${errMsg}`);
    console.error("[webhook/message-received] Error:", err);
    try {
      if (webhookEventId) {
        await failWebhookEvent(webhookEventId, log.entries);
      }
    } catch {}
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return response;
}
