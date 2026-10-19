import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { createStepLogger, type StepLogger } from "@/lib/debugLog";
import { inboundEvents } from "@/lib/inbox/schema";
import { people } from "@/lib/leads/schema";
import { ingestInboundReply } from "@/lib/crm/conversations";
import { quarantineCrmIdentity } from "@/lib/crm/identity";
import { recordManualOutboundInTransaction } from "@/lib/crm/manualOutbound";
import { resolvePipelineId } from "@/lib/crm/records";
import { CrmConflictError, type CrmTransaction, withCrmTransaction } from "@/lib/crm/repository";
import { crmConversations, crmRecords } from "@/lib/crm/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

/**
 * Where WhatsApp messages meet the CRM: a lead's reply lands on their CRM
 * record as an inbound message on a "whatsapp" conversation (classified,
 * drafted, queued in Action required, as LinkedIn replies are), and what
 * the rep sent — from AgentSDR or straight from their phone — is recorded as
 * outbound, so the record knows the lead was answered.
 *
 * Called by src/lib/whatsapp/messages.ts after a message is stored in
 * whatsapp_messages (and by send.ts after an AgentSDR send). Never throws: a
 * CRM failure must not lose the message or fail Unipile's webhook; it is
 * logged, and the message stays in the Messages tab.
 *
 * CRM identity: accountRef is the rep's Unipile account id, providerThreadId
 * the Unipile chat id, providerContactId "<digits>@s.whatsapp.net", and every
 * message's idempotency key `whatsapp:<unipileMessageId>` — the same key
 * outreachHistory.ts uses when it backfills the chat on the first reply.
 *
 * Which record an outbound message lands on: the one already holding this
 * chat's conversation, else the Person's record in the default pipeline (the
 * one an inbound reply would land on). A Person with no CRM record gets
 * none from an outbound message — records are created by a reply or a call
 * (records.ts), and a stray chat the rep starts is neither. Nothing is lost:
 * when the lead replies, ingest backfills what the rep sent in the chat from
 * whatsapp_messages (outreachHistory.ts).
 */

export type WhatsappCrmMessageInput = {
  /** The AgentSDR person the chat's number belongs to. */
  personId: string;
  /** The Unipile account id of the rep's number — the CRM conversation's accountRef. */
  unipileAccountId: string;
  /** The Unipile chat id — the conversation's providerThreadId. */
  unipileChatId: string;
  /** "<digits>@s.whatsapp.net" — the conversation's providerContactId. */
  providerContactId: string | null;
  /** Unipile's message id; the CRM idempotency key derives from it. */
  unipileMessageId: string;
  body: string;
  sentAt: Date;
  raw: Record<string, unknown> | null;
};

/** What the CRM stores for a message with no text (a photo, voice note, sticker…). */
export const WHATSAPP_NO_TEXT_BODY = "(WhatsApp message with no text — an attachment, voice note or sticker)";

export function whatsappCrmBodyText(body: string): string {
  return body.trim() || WHATSAPP_NO_TEXT_BODY;
}

export function whatsappCrmIdempotencyKey(unipileMessageId: string): string {
  return `whatsapp:${unipileMessageId}`;
}

function validDate(value: Date): Date {
  return Number.isNaN(value.getTime()) ? new Date() : value;
}

/** The audit payload: stable and replayable, without Unipile's raw body (whatsapp_messages keeps that). */
function auditPayload(input: WhatsappCrmMessageInput): Record<string, unknown> {
  return {
    personId: input.personId,
    unipileAccountId: input.unipileAccountId,
    unipileChatId: input.unipileChatId,
    providerContactId: input.providerContactId,
    unipileMessageId: input.unipileMessageId,
    body: input.body,
    sentAt: validDate(input.sentAt).toISOString(),
  };
}

/** A lead's reply → the CRM. Returns the CRM message id when it was recorded. */
export async function forwardWhatsappInboundToCrm(
  input: WhatsappCrmMessageInput,
): Promise<{ crmConversationMessageId: string | null }> {
  const log = createStepLogger();
  const payload = auditPayload(input);
  let eventId: string | null = null;
  try {
    const [person] = await db.select({ id: people.id, fullName: people.fullName })
      .from(people).where(and(inOrg(people), eq(people.id, input.personId))).limit(1);
    const [event] = await db.insert(inboundEvents).values({
      organizationId: currentOrganizationId(),
      source: "whatsapp",
      eventType: "message_received",
      title: person?.fullName || input.providerContactId || input.unipileChatId,
      payload,
      processed: false,
    }).returning({ id: inboundEvents.id });
    eventId = event?.id ?? null;
    log.info("message_received — processing WhatsApp delivery");

    const idempotencyKey = whatsappCrmIdempotencyKey(input.unipileMessageId);
    if (!person) {
      await quarantineCrmIdentity({
        channel: "whatsapp",
        accountRef: input.unipileAccountId,
        sourceEventKey: idempotencyKey,
        identityValue: input.providerContactId,
        reason: `Referenced canonical Person ${input.personId} was not found`,
        payload,
      });
      log.warn(`Person ${input.personId} not found — quarantined for identity review`);
      log.finish("skipped");
      await finishAudit(eventId, log);
      return { crmConversationMessageId: null };
    }

    const result = await ingestInboundReply({
      personId: person.id,
      channel: "whatsapp",
      accountRef: input.unipileAccountId,
      providerThreadId: input.unipileChatId,
      providerContactId: input.providerContactId,
      idempotencyKey,
      providerMessageId: input.unipileMessageId,
      bodyText: whatsappCrmBodyText(input.body),
      raw: input.raw,
      sentAt: validDate(input.sentAt),
      actorRef: "unipile",
    });
    log.info(result.duplicate ? "CRM already stored this WhatsApp reply" : "WhatsApp reply routed to CRM");
    log.finish(result.duplicate ? "skipped" : "ok");
    await finishAudit(eventId, log);
    return { crmConversationMessageId: result.message.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[whatsapp/crmBridge] inbound CRM forwarding failed:", message);
    log.error(message);
    log.finish("error");
    await finishAudit(eventId, log, message);
    return { crmConversationMessageId: null };
  }
}

async function finishAudit(
  eventId: string | null,
  log: StepLogger,
  error: string | null = null,
): Promise<void> {
  if (!eventId) return;
  try {
    await db.update(inboundEvents).set({
      processed: error === null,
      error,
      status: log.status,
      steps: log.steps,
    }).where(eq(inboundEvents.id, eventId));
  } catch (auditError) {
    console.error("[whatsapp/crmBridge] audit update failed:", auditError instanceof Error ? auditError.message : auditError);
  }
}

/**
 * The record an outbound message in this chat belongs to, or null to leave
 * it out of the CRM (see the header for the rule).
 */
async function recordForOutbound(tx: CrmTransaction, input: WhatsappCrmMessageInput): Promise<string | null> {
  const [conversation] = await tx.select({ crmRecordId: crmConversations.crmRecordId, personId: crmConversations.personId })
    .from(crmConversations)
    .where(and(
      inOrg(crmConversations),
      eq(crmConversations.channel, "whatsapp"),
      eq(crmConversations.accountRef, input.unipileAccountId),
      eq(crmConversations.providerThreadId, input.unipileChatId),
    ))
    .limit(1);
  if (conversation) {
    if (conversation.personId !== input.personId) {
      throw new CrmConflictError("This WhatsApp chat's CRM conversation belongs to another Person");
    }
    return conversation.crmRecordId;
  }
  const pipelineId = await resolvePipelineId(tx, undefined);
  const [record] = await tx.select({ id: crmRecords.id }).from(crmRecords)
    .where(and(inOrg(crmRecords), eq(crmRecords.personId, input.personId), eq(crmRecords.pipelineId, pipelineId)))
    .limit(1);
  return record?.id ?? null;
}

/**
 * What the rep sent → the CRM, as outbound. `origin` "phone" is a message
 * AgentSDR did not send (typed on the phone or in WhatsApp Web): it counts as
 * the rep having answered. So does "agentsdr" (sent from the Messages tab or
 * Calling rather than through a CRM draft) — see manualOutbound.ts for when
 * that takes the record out of Action required — and "campaign" (a campaign
 * step, which the CRM labels as one rather than as the owner's answer).
 */
export async function recordWhatsappOutboundInCrm(
  input: WhatsappCrmMessageInput & { origin: "agentsdr" | "phone" | "campaign" },
): Promise<{ crmConversationMessageId: string | null }> {
  try {
    return await withCrmTransaction(async (tx) => {
      const recordId = await recordForOutbound(tx, input);
      if (!recordId) return { crmConversationMessageId: null };
      const result = await recordManualOutboundInTransaction(tx, {
        recordId,
        personId: input.personId,
        channel: "whatsapp",
        accountRef: input.unipileAccountId,
        providerThreadId: input.unipileChatId,
        providerContactId: input.providerContactId,
        idempotencyKey: whatsappCrmIdempotencyKey(input.unipileMessageId),
        providerMessageId: input.unipileMessageId,
        bodyText: whatsappCrmBodyText(input.body),
        raw: input.raw ? { ...input.raw, origin: input.origin } : { origin: input.origin },
        sentAt: validDate(input.sentAt),
        reason: "manual_outbound_whatsapp",
        actorType: "integration",
        actorRef: "unipile",
        meta: { origin: input.origin },
      });
      return { crmConversationMessageId: result.message.id };
    });
  } catch (error) {
    console.error(
      "[whatsapp/crmBridge] outbound CRM recording failed:",
      error instanceof Error ? error.message : error,
    );
    return { crmConversationMessageId: null };
  }
}
