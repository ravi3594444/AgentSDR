/**
 * Backfills the CRM conversation with the outreach that was actually sent,
 * before any inbound reply is recorded. Without this, the classifier and
 * drafter see a first reply with no idea what was pitched.
 *
 * Outreach history is read from the channel's own store, never written by
 * it: `outreach_emails` (src/lib/outreach/schema.ts) for email, the
 * LinkedIn "Message" table (src/lib/linkedin/schema.ts) for LinkedIn, and
 * `whatsapp_messages` (src/lib/whatsapp/schema.ts) for WhatsApp — what the
 * rep sent in the chat before the lead's first reply reached the CRM. Each
 * row is inserted into `crm_conversation_messages` as an outbound message
 * through the same `insertConversationMessageInTransaction` idempotent
 * upsert the inbound and CRM-send paths already use, so re-running this is
 * always safe.
 */
import { browserContactRoutes, browserOutreachSends } from "@/lib/browserOutreach/schema";
import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  connections as linkedinConnections,
  leads as linkedinLeads,
  messages as linkedinMessages,
  type MessageType as LinkedinMessageType,
} from "@/lib/linkedin/schema";
import { outreachCampaigns, outreachEmails, outreachLeads } from "@/lib/outreach/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { whatsappAccounts, whatsappChats, whatsappMessages } from "@/lib/whatsapp/schema";
import { instagramAccounts, instagramChats, instagramMessages } from "@/lib/instagram/schema";
import { htmlToPlainText, looksLikeHtml } from "@/lib/email/htmlToText";
import {
  insertConversationMessageInTransaction,
  type InsertConversationMessageInput,
} from "./conversations";
import { CrmConflictError, type CrmTransaction } from "./repository";
import type { CrmChannel } from "./schema";

export type BackfillOutreachHistoryInput = {
  conversationId: string;
  personId: string;
  channel: CrmChannel;
  accountRef: string;
};

export type BackfillOutreachHistoryResult = { inserted: number };

/** What every row, from either channel, resolves to before the shared context fields are attached. */
type PendingOutboundMessage = Omit<
  InsertConversationMessageInput,
  "conversationId" | "personId" | "channel" | "accountRef"
>;

export type EmailOutreachRow = {
  id: string;
  subject: string | null;
  body: string | null;
  messageId: string | null;
  sentAt: Date | null;
  stepNumber: number;
  campaignId: string | null;
};

/** Converts one sent `outreach_emails` row into an outbound message, or null to skip it. */
export function emailOutreachRowToMessageInput(row: EmailOutreachRow): PendingOutboundMessage | null {
  if (!row.sentAt) return null;
  const rawBody = row.body ?? "";
  const isHtml = looksLikeHtml(rawBody);
  const bodyText = (isHtml ? htmlToPlainText(rawBody) : rawBody).trim();
  if (!bodyText) return null;
  return {
    direction: "outbound",
    idempotencyKey: `outreach-email:${row.id}`,
    providerMessageId: row.messageId,
    subject: row.subject,
    bodyText,
    bodyHtml: isHtml ? rawBody : null,
    raw: {
      source: "outreach_emails",
      id: row.id,
      step: row.stepNumber,
      campaignId: row.campaignId,
    },
    sentAt: row.sentAt,
  };
}

export type LinkedinOutreachRow = {
  id: string;
  type: LinkedinMessageType;
  text: string | null;
  linkedinMessageId: string | null;
  createdAt: Date;
  duplicateOfMessageId: string | null;
  campaignId: string | null;
};

/** Converts one "Message" row into an outbound message, or null to skip it. */
export function linkedinOutreachRowToMessageInput(row: LinkedinOutreachRow): PendingOutboundMessage | null {
  if (row.type === "RECEIVED") return null;
  if (row.duplicateOfMessageId) return null;
  const bodyText = (row.text ?? "").trim();
  if (!bodyText) return null;
  return {
    direction: "outbound",
    idempotencyKey: `linkedin-outreach:${row.id}`,
    providerMessageId: row.linkedinMessageId,
    subject: null,
    bodyText,
    raw: {
      source: "Message",
      id: row.id,
      type: row.type,
      campaignId: row.campaignId,
    },
    sentAt: row.createdAt,
  };
}

export type WhatsappOutreachRow = {
  id: string;
  unipileMessageId: string | null;
  body: string;
  origin: "lead" | "agentsdr" | "phone";
  sentAt: Date;
  unipileChatId: string;
  /** Set when the message is already on a CRM conversation (a CRM send, or the bridge). */
  crmConversationMessageId: string | null;
};

/**
 * Converts one outbound `whatsapp_messages` row into an outbound message, or
 * null to skip it. The idempotency key is crmBridge.ts's, so a message the
 * bridge already recorded (or records later) is the same CRM row.
 */
export function whatsappOutreachRowToMessageInput(row: WhatsappOutreachRow): PendingOutboundMessage | null {
  if (row.origin === "lead") return null;
  if (row.crmConversationMessageId) return null;
  // Null only while an AgentSDR send is in flight; the webhook echo records it.
  if (!row.unipileMessageId) return null;
  const bodyText = row.body.trim();
  if (!bodyText) return null;
  return {
    direction: "outbound",
    idempotencyKey: `whatsapp:${row.unipileMessageId}`,
    providerMessageId: row.unipileMessageId,
    subject: null,
    bodyText,
    raw: {
      source: "whatsapp_messages",
      id: row.id,
      origin: row.origin,
      unipileChatId: row.unipileChatId,
    },
    sentAt: row.sentAt,
  };
}

/** What the rep sent from this WhatsApp number to the Person's chats. */
async function loadWhatsappOutreachRows(
  tx: CrmTransaction,
  personId: string,
  unipileAccountId: string,
): Promise<WhatsappOutreachRow[]> {
  return tx
    .select({
      id: whatsappMessages.id,
      unipileMessageId: whatsappMessages.unipileMessageId,
      body: whatsappMessages.body,
      origin: whatsappMessages.origin,
      sentAt: whatsappMessages.sentAt,
      unipileChatId: whatsappChats.unipileChatId,
      crmConversationMessageId: whatsappMessages.crmConversationMessageId,
    })
    .from(whatsappMessages)
    .innerJoin(whatsappChats, eq(whatsappChats.id, whatsappMessages.chatId))
    .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, whatsappChats.accountId))
    .where(and(
      inOrg(whatsappAccounts),
      eq(whatsappChats.personId, personId),
      eq(whatsappAccounts.unipileAccountId, unipileAccountId),
      eq(whatsappMessages.direction, "outbound"),
    ));
}

/**
 * What the owner sent from this Instagram account in the Person's chats
 * (from AgentSDR or the Instagram app), so the first reply that reaches the
 * CRM is read with what came before it. Same row shape and rules as
 * WhatsApp; only outbound messages are copied, so nothing from the lead
 * becomes a new inbound message. History (imported, sent before the
 * account's cutoff, or late — `historical`) never reaches the CRM, so it is
 * not copied either.
 */
async function loadInstagramOutreachRows(
  tx: CrmTransaction,
  personId: string,
  unipileAccountId: string,
): Promise<WhatsappOutreachRow[]> {
  const rows = await tx
    .select({
      id: instagramMessages.id,
      unipileMessageId: instagramMessages.unipileMessageId,
      body: instagramMessages.body,
      origin: instagramMessages.origin,
      sentAt: instagramMessages.sentAt,
      unipileChatId: instagramChats.unipileChatId,
      crmConversationMessageId: instagramMessages.crmConversationMessageId,
    })
    .from(instagramMessages)
    .innerJoin(instagramChats, eq(instagramChats.id, instagramMessages.chatId))
    .innerJoin(instagramAccounts, eq(instagramAccounts.id, instagramChats.accountId))
    .where(and(
      inOrg(instagramAccounts),
      eq(instagramChats.personId, personId),
      eq(instagramAccounts.unipileAccountId, unipileAccountId),
      eq(instagramMessages.direction, "outbound"),
      eq(instagramMessages.historical, false),
    ));
  return rows;
}

/** An outbound Instagram message as a CRM message: the WhatsApp rules with Instagram's key and source. */
export function instagramOutreachRowToMessageInput(row: WhatsappOutreachRow): PendingOutboundMessage | null {
  const message = whatsappOutreachRowToMessageInput(row);
  if (!message) return null;
  return {
    ...message,
    idempotencyKey: `instagram:${row.unipileMessageId}`,
    raw: { ...(message.raw as Record<string, unknown>), source: "instagram_messages" },
  };
}

async function loadEmailOutreachRows(tx: CrmTransaction, personId: string): Promise<EmailOutreachRow[]> {
  return tx
    .select({
      id: outreachEmails.id,
      subject: outreachEmails.subject,
      body: outreachEmails.body,
      messageId: outreachEmails.messageId,
      sentAt: outreachEmails.sentAt,
      stepNumber: outreachEmails.stepNumber,
      campaignId: outreachLeads.campaignId,
    })
    .from(outreachEmails)
    .innerJoin(outreachLeads, eq(outreachLeads.id, outreachEmails.leadId))
    .where(and(
      inArray(
        outreachLeads.campaignId,
        tx.select({ id: outreachCampaigns.id }).from(outreachCampaigns).where(inOrg(outreachCampaigns)),
      ),
      eq(outreachLeads.personId, personId),
      eq(outreachEmails.status, "sent"),
    ));
}

/**
 * A Person's outbound LinkedIn messages, scoped through both of "Message"'s
 * link paths: rows attached directly to one of the Person's Leads, and rows
 * attached to a Connection that itself belongs to one of the Person's Leads
 * (that second path is how a CUSTOM_SENT message written after connection —
 * see src/lib/crm/send.ts — is found even though it never carries a leadId).
 */
async function loadLinkedinOutreachRows(tx: CrmTransaction, personId: string): Promise<LinkedinOutreachRow[]> {
  const personLeads = await tx
    .select({ id: linkedinLeads.id, campaignId: linkedinLeads.campaignId })
    .from(linkedinLeads)
    .where(and(inOrg(linkedinLeads), eq(linkedinLeads.personId, personId)));
  if (!personLeads.length) return [];
  const leadIds = personLeads.map((lead) => lead.id);
  const campaignByLead = new Map(personLeads.map((lead) => [lead.id, lead.campaignId]));

  const personConnections = await tx
    .select({ id: linkedinConnections.id, leadId: linkedinConnections.leadId })
    .from(linkedinConnections)
    .where(inArray(linkedinConnections.leadId, leadIds));
  const connectionIds = personConnections.map((connection) => connection.id);
  const leadByConnection = new Map(
    personConnections
      .filter((connection): connection is { id: string; leadId: string } => connection.leadId !== null)
      .map((connection) => [connection.id, connection.leadId]),
  );

  const scopeCondition = connectionIds.length
    ? or(inArray(linkedinMessages.leadId, leadIds), inArray(linkedinMessages.connectionId, connectionIds))
    : inArray(linkedinMessages.leadId, leadIds);

  const rows = await tx
    .select({
      id: linkedinMessages.id,
      type: linkedinMessages.type,
      text: linkedinMessages.text,
      linkedinMessageId: linkedinMessages.linkedinMessageId,
      createdAt: linkedinMessages.createdAt,
      duplicateOfMessageId: linkedinMessages.duplicateOfMessageId,
      leadId: linkedinMessages.leadId,
      connectionId: linkedinMessages.connectionId,
    })
    .from(linkedinMessages)
    .where(and(
      scopeCondition,
      ne(linkedinMessages.type, "RECEIVED"),
      isNull(linkedinMessages.duplicateOfMessageId),
    ));

  return rows.map((row) => {
    const leadIdForCampaign = row.leadId ?? (row.connectionId ? leadByConnection.get(row.connectionId) : undefined);
    return {
      id: row.id,
      type: row.type,
      text: row.text,
      linkedinMessageId: row.linkedinMessageId,
      createdAt: row.createdAt,
      duplicateOfMessageId: row.duplicateOfMessageId,
      campaignId: (leadIdForCampaign ? campaignByLead.get(leadIdForCampaign) : undefined) ?? null,
    };
  });
}

async function loadPendingOutreach(
  tx: CrmTransaction,
  input: BackfillOutreachHistoryInput,
): Promise<(PendingOutboundMessage | null)[]> {
  switch (input.channel) {
    case "email":
      return (await loadEmailOutreachRows(tx, input.personId)).map(emailOutreachRowToMessageInput);
    case "linkedin":
      return (await loadLinkedinOutreachRows(tx, input.personId)).map(linkedinOutreachRowToMessageInput);
    case "whatsapp":
      return (await loadWhatsappOutreachRows(tx, input.personId, input.accountRef)).map(whatsappOutreachRowToMessageInput);
    case "instagram":
      return (await loadInstagramOutreachRows(tx, input.personId, input.accountRef)).map(instagramOutreachRowToMessageInput);
    case "browser":
      return (await loadBrowserOutreachRows(tx, input.personId, input.accountRef)).map(browserOutreachRowToMessageInput);
  }
}

export type BrowserOutreachRow = { id: string; body: string; sentAt: Date | null; threadUrl: string | null; step: number; kind: "step" | "reply" };

/** Converts one confirmed browser send into an outbound message, or null to skip it. */
export function browserOutreachRowToMessageInput(row: BrowserOutreachRow): PendingOutboundMessage | null {
  if (!row.sentAt || !row.body.trim()) return null;
  return {
    direction: "outbound",
    idempotencyKey: `browser:${row.id}`,
    providerMessageId: null,
    subject: null,
    bodyText: row.body.trim(),
    raw: { source: "browser_outreach_sends", id: row.id, step: row.step, kind: row.kind, threadUrl: row.threadUrl },
    sentAt: row.sentAt,
  };
}

/** The confirmed browser messages to this person from the account `accountRef` ("<site>:<handle>") names. */
async function loadBrowserOutreachRows(tx: CrmTransaction, personId: string, accountRef: string): Promise<BrowserOutreachRow[]> {
  const [site, handle] = accountRef.split(":", 2);
  if (!site || !handle) return [];
  return tx.select({
    id: browserOutreachSends.id,
    body: browserOutreachSends.body,
    sentAt: browserOutreachSends.sentAt,
    threadUrl: browserOutreachSends.threadUrl,
    step: browserOutreachSends.step,
    kind: browserOutreachSends.kind,
  }).from(browserOutreachSends)
    .innerJoin(browserContactRoutes, eq(browserContactRoutes.id, browserOutreachSends.routeId))
    .where(and(
      inOrg(browserOutreachSends),
      eq(browserOutreachSends.personId, personId),
      eq(browserOutreachSends.status, "sent"),
      eq(browserContactRoutes.site, site as "x"),
      eq(browserOutreachSends.senderHandle, handle),
    ))
    .orderBy(asc(browserOutreachSends.sentAt));
}

/**
 * Inserts every one of the Person's sent outreach messages for `channel`
 * into the given conversation as outbound `crm_conversation_messages` rows.
 * Idempotent: safe to call again for a conversation that already has some
 * or all of this history recorded.
 *
 * A per-row `CrmConflictError` (the same idempotency/provider id already
 * exists under another conversation or direction — e.g. a CRM-sent LinkedIn
 * message that also landed in "Message" as CUSTOM_SENT with the same
 * linkedinMessageId) is swallowed and the row is skipped rather than
 * failing the whole backfill. Any other error propagates.
 */
export async function backfillOutreachHistoryInTransaction(
  tx: CrmTransaction,
  input: BackfillOutreachHistoryInput,
): Promise<BackfillOutreachHistoryResult> {
  const pending = await loadPendingOutreach(tx, input);

  let inserted = 0;
  for (const message of pending) {
    if (!message) continue;
    try {
      const { created } = await insertConversationMessageInTransaction(tx, {
        conversationId: input.conversationId,
        personId: input.personId,
        channel: input.channel,
        accountRef: input.accountRef,
        ...message,
      });
      if (created) inserted += 1;
    } catch (err) {
      if (err instanceof CrmConflictError) continue;
      throw err;
    }
  }
  return { inserted };
}
