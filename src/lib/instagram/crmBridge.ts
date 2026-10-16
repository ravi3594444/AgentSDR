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
import { INSTAGRAM_NO_TEXT_BODY } from "./contract";

/**
 * Where Instagram messages meet the CRM: a reply from someone AgentSDR knows
 * lands on their CRM record as an inbound message on an "instagram"
 * conversation (classified, drafted, queued in Action required, like the
 * other channels), and what the owner typed in the Instagram app is
 * recorded as outbound, so the record knows the person was answered.
 *
 * Called by src/lib/instagram/messages.ts after a message is stored in
 * instagram_messages — never for history. Never throws: a CRM failure must
 * not lose the message; it is logged and returned as `error`, the message
 * stays in the Instagram inbox, and the webhook delivery is marked errored so
 * the replay (src/jobs/replayInstagramWebhooks.ts) forwards it again — the
 * idempotency key below makes that safe.
 *
 * CRM identity: accountRef is the Unipile account id, providerThreadId the
 * Unipile chat id, providerContactId the person's Instagram id, and every
 * message's idempotency key `instagram:<unipileMessageId>` — the same key
 * outreachHistory.ts uses when it backfills the chat on the first reply.
 * The quarantine payload carries unipileChatId, providerContactId,
 * unipileMessageId, body and sentAt, which identity replay
 * (src/lib/crm/identity.ts) reads back.
 *
 * Which record an outbound message lands on: the one already holding this
 * chat's conversation, else the Person's record in the default pipeline. A
 * Person with no CRM record gets none from an outbound message; when they
 * reply, ingest backfills what was sent from instagram_messages.
 */

export type InstagramCrmMessageInput = {
  /** The AgentSDR person the chat belongs to. */
  personId: string;
  /** The Unipile account id — the CRM conversation's accountRef. */
  unipileAccountId: string;
  /** The Unipile chat id — the conversation's providerThreadId. */
  unipileChatId: string;
  /** The person's Instagram id — the conversation's providerContactId. */
  providerContactId: string | null;
  /** Unipile's message id; the CRM idempotency key derives from it. */
  unipileMessageId: string;
  body: string;
  sentAt: Date;
  raw: Record<string, unknown> | null;
};

export function instagramCrmBodyText(body: string): string {
  return body.trim() || INSTAGRAM_NO_TEXT_BODY;
}

export function instagramCrmIdempotencyKey(unipileMessageId: string): string {
  return `instagram:${unipileMessageId}`;
}

function validDate(value: Date): Date {
  return Number.isNaN(value.getTime()) ? new Date() : value;
}

/** The audit payload: stable and replayable, without Unipile's raw body (instagram_messages keeps that). */
function auditPayload(input: InstagramCrmMessageInput): Record<string, unknown> {
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

/**
 * What became of a message on the CRM: its CRM message id when it was
 * recorded; `error` when recording failed (worth retrying). Both null means
 * it was deliberately left out (no record for an outbound message, or the
 * person was quarantined for identity review).
 */
export type InstagramCrmResult = { crmConversationMessageId: string | null; error: string | null };

/** A reply → the CRM. */
export async function forwardInstagramInboundToCrm(
  input: InstagramCrmMessageInput,
): Promise<InstagramCrmResult> {
  const log = createStepLogger();
  const payload = auditPayload(input);
  let eventId: string | null = null;
  try {
    const [person] = await db.select({ id: people.id, fullName: people.fullName })
      .from(people).where(and(inOrg(people), eq(people.id, input.personId))).limit(1);
    const [event] = await db.insert(inboundEvents).values({
      organizationId: currentOrganizationId(),
      source: "instagram",
      eventType: "message_received",
      title: person?.fullName || input.providerContactId || input.unipileChatId,
      payload,
      processed: false,
    }).returning({ id: inboundEvents.id });
    eventId = event?.id ?? null;
    log.info("message_received — processing Instagram delivery");

    const idempotencyKey = instagramCrmIdempotencyKey(input.unipileMessageId);
    if (!person) {
      await quarantineCrmIdentity({
        channel: "instagram",
        accountRef: input.unipileAccountId,
        sourceEventKey: idempotencyKey,
        identityValue: input.providerContactId,
        reason: `Referenced canonical Person ${input.personId} was not found`,
        payload,
      });
      log.warn(`Person ${input.personId} not found — quarantined for identity review`);
      log.finish("skipped");
      await finishAudit(eventId, log);
      return { crmConversationMessageId: null, error: null };
    }

    const result = await ingestInboundReply({
      personId: person.id,
      channel: "instagram",
      accountRef: input.unipileAccountId,
      providerThreadId: input.unipileChatId,
      providerContactId: input.providerContactId,
      idempotencyKey,
      providerMessageId: input.unipileMessageId,
      bodyText: instagramCrmBodyText(input.body),
      raw: input.raw,
      sentAt: validDate(input.sentAt),
      actorRef: "unipile",
    });
    log.info(result.duplicate ? "CRM already stored this Instagram reply" : "Instagram reply routed to CRM");
    log.finish(result.duplicate ? "skipped" : "ok");
    await finishAudit(eventId, log);
    return { crmConversationMessageId: result.message.id, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[instagram/crmBridge] inbound CRM forwarding failed:", message);
    log.error(message);
    log.finish("error");
    await finishAudit(eventId, log, message);
    return { crmConversationMessageId: null, error: message };
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
    }).where(and(inOrg(inboundEvents), eq(inboundEvents.id, eventId)));
  } catch (auditError) {
    console.error("[instagram/crmBridge] audit update failed:", auditError instanceof Error ? auditError.message : auditError);
  }
}

/**
 * The record an outbound message in this chat belongs to, or null to leave
 * it out of the CRM (see the header for the rule).
 */
async function recordForOutbound(tx: CrmTransaction, input: InstagramCrmMessageInput): Promise<string | null> {
  const [conversation] = await tx.select({ crmRecordId: crmConversations.crmRecordId, personId: crmConversations.personId })
    .from(crmConversations)
    .where(and(
      inOrg(crmConversations),
      eq(crmConversations.channel, "instagram"),
      eq(crmConversations.accountRef, input.unipileAccountId),
      eq(crmConversations.providerThreadId, input.unipileChatId),
    ))
    .limit(1);
  if (conversation) {
    if (conversation.personId !== input.personId) {
      throw new CrmConflictError("This Instagram chat's CRM conversation belongs to another Person");
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
 * What the owner sent → the CRM, as outbound. `origin` "phone" is a message
 * AgentSDR did not send (typed in the Instagram app): it counts as the
 * person having been answered (see manualOutbound.ts).
 */
export async function recordInstagramOutboundInCrm(
  input: InstagramCrmMessageInput & { origin: "agentsdr" | "phone" },
): Promise<InstagramCrmResult> {
  try {
    return await withCrmTransaction(async (tx) => {
      const recordId = await recordForOutbound(tx, input);
      if (!recordId) return { crmConversationMessageId: null, error: null };
      const result = await recordManualOutboundInTransaction(tx, {
        recordId,
        personId: input.personId,
        channel: "instagram",
        accountRef: input.unipileAccountId,
        providerThreadId: input.unipileChatId,
        providerContactId: input.providerContactId,
        idempotencyKey: instagramCrmIdempotencyKey(input.unipileMessageId),
        providerMessageId: input.unipileMessageId,
        bodyText: instagramCrmBodyText(input.body),
        raw: input.raw ? { ...input.raw, origin: input.origin } : { origin: input.origin },
        sentAt: validDate(input.sentAt),
        reason: "manual_outbound_instagram",
        actorType: "integration",
        actorRef: "unipile",
        meta: { origin: input.origin },
      });
      return { crmConversationMessageId: result.message.id, error: null };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[instagram/crmBridge] outbound CRM recording failed:", message);
    return { crmConversationMessageId: null, error: message };
  }
}
