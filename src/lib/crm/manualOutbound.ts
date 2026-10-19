import { and, eq, gt, gte, inArray } from "drizzle-orm";
import {
  insertConversationMessageInTransaction,
  upsertConversationInTransaction,
  type CrmConversation,
  type CrmConversationMessage,
} from "./conversations";
import { appendCrmEvent, type CrmEventActor } from "./events";
import type { CrmExecutor, CrmTransaction } from "./repository";
import { lockCrmRecord, type CrmRecord } from "./records";
import {
  crmClassifications,
  crmConversationMessages,
  crmConversations,
  crmDrafts,
  crmRecords,
  type CrmChannel,
} from "./schema";
import { interruptActiveSequenceRunInTransaction } from "./sequences";
import { setAsideAcknowledgementsInTransaction } from "./wrongRoutes";
import { inOrg } from "@/lib/tenancy/scope";

/**
 * A message the rep sent to the lead outside a CRM draft — typed on their
 * phone, or sent from a messaging surface (WhatsApp Messages, Calling) that
 * does not go through sendDraft — recorded on the CRM conversation as
 * outbound, so the record knows the lead was answered.
 *
 * When it answers the latest inbound reply, it has the effect a hand-written
 * draft sent through sendDraft has (send.ts, the non-sequence branch): the
 * active sequence is interrupted, open drafts go stale, the reply's
 * classification is acknowledged and the record leaves Action required —
 * unless an uncertain delivery still has to be confirmed. What the rep sent is the reply; the AI's pending one is
 * not needed any more. Open owner decisions and a takeover are left as they
 * are, and a message older than the latest reply (a late echo) or a repeat
 * delivery changes nothing.
 */

export type ManualOutboundDecision =
  /** It answers the latest inbound: the record leaves Action required. */
  | "answered"
  /**
   * It answers the latest inbound, but that reply is still being classified.
   * Only the message is recorded; the classification job sees the reply was
   * answered (latestInboundAnswered) and settles the record instead of drafting.
   */
  | "await_classification"
  /** Recorded as history only; the workflow is left alone. */
  | "record_only";

export type ManualOutboundRecordState = Pick<
  CrmRecord,
  "workflowState" | "latestInboundMessageId" | "lastInboundAt" | "lastOutboundAt"
>;

/** Whether an outbound message has gone out since the record's latest inbound reply. */
export function latestInboundAnswered(
  record: Pick<CrmRecord, "latestInboundMessageId" | "lastInboundAt" | "lastOutboundAt">,
): boolean {
  if (!record.latestInboundMessageId || !record.lastInboundAt || !record.lastOutboundAt) return false;
  return record.lastOutboundAt.getTime() >= record.lastInboundAt.getTime();
}

/**
 * What a manual outbound message sent at `sentAt` does to the record, read
 * before the message updates last_outbound_at. Pure, for the tests.
 */
export function manualOutboundDecision(record: ManualOutboundRecordState, sentAt: Date): ManualOutboundDecision {
  // A call-only record (no inbound reply) is WhatsApp Calling's: its
  // follow-up date is mirrored from there (calls/crmFollowUp.ts) and must
  // not be cleared by a message.
  if (!record.latestInboundMessageId) return "record_only";
  // Older than the latest reply (e.g. a late webhook echo): it cannot be the
  // answer to it.
  if (record.lastInboundAt && sentAt.getTime() < record.lastInboundAt.getTime()) return "record_only";
  // The reply was already answered; this is conversation, not a transition.
  if (latestInboundAnswered(record)) return "record_only";
  switch (record.workflowState) {
    case "action_required":
    case "waiting":
      return "answered";
    case "unclassified":
    case "classifying":
      return "await_classification";
    // idle: nothing pending. paused / closed: a person set that on purpose.
    // error: needs a person to look at what failed (and error → idle is not
    // a transition the state machine allows).
    case "idle":
    case "paused":
    case "closed":
    case "error":
      return "record_only";
  }
}

/**
 * Whether the rep answered this inbound message before the AI got to it: an
 * outbound message on the same record, sent after the reply and recorded
 * after the reply reached the CRM. The second condition keeps a late-synced
 * email reply from counting as answered by a send that went out before the
 * CRM knew about it.
 */
export async function inboundAnsweredSince(
  executor: CrmExecutor,
  recordId: string,
  inboundMessageId: string,
): Promise<boolean> {
  const [inbound] = await executor
    .select({ sentAt: crmConversationMessages.sentAt, createdAt: crmConversationMessages.createdAt })
    .from(crmConversationMessages)
    .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
    .where(and(inOrg(crmConversations), eq(crmConversationMessages.id, inboundMessageId)))
    .limit(1);
  if (!inbound) return false;
  const [answer] = await executor
    .select({ id: crmConversationMessages.id })
    .from(crmConversationMessages)
    .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
    .where(and(
      inOrg(crmConversations),
      eq(crmConversations.crmRecordId, recordId),
      eq(crmConversationMessages.direction, "outbound"),
      // Typed comparisons, not raw sql: a Date interpolated into sql`` is sent
      // as its toString() ("Wed Sep 30 2026 … (Coordinated Universal Time)"),
      // which Postgres cannot read — the classification job failed on it.
      gte(crmConversationMessages.sentAt, inbound.sentAt),
      gt(crmConversationMessages.createdAt, inbound.createdAt),
    ))
    .limit(1);
  return Boolean(answer);
}

/** What still waits on a person once the latest reply has been answered. */
export type PendingAfterAnswer = "delivery_uncertain";

/**
 * Where an answered record goes: out of Action required, unless a send whose
 * delivery is uncertain still has to be confirmed (it is never assumed). A
 * classification still proposed does not hold it: the reply was handled, and
 * the record stays findable with its proposal in All replies. Pure, for the
 * tests.
 */
export function settledWorkflowState(pending: readonly PendingAfterAnswer[]): "idle" | "action_required" {
  return pending.length ? "action_required" : "idle";
}

async function pendingAfterAnswer(tx: CrmTransaction, record: CrmRecord): Promise<PendingAfterAnswer[]> {
  const [uncertain] = await tx.select({ id: crmDrafts.id }).from(crmDrafts)
    .where(and(eq(crmDrafts.crmRecordId, record.id), eq(crmDrafts.status, "delivery_uncertain"))).limit(1);
  return uncertain ? ["delivery_uncertain"] : [];
}

/**
 * Settles a record whose latest reply the rep already answered: the end of
 * an answering manual message, and the classification job's ending when one
 * arrived while it ran (the "await_classification" decision). The record
 * leaves Action required unless something else still waits on a person
 * (settledWorkflowState). Owner decisions are not touched — an open question
 * (a quote, a meeting) is the owner's to settle in Needs you — and neither is
 * a takeover: answering by hand does not change the reply mode.
 */
export async function settleAnsweredRecordInTransaction(
  tx: CrmTransaction,
  record: CrmRecord,
  input: { reason: string; actorType: CrmEventActor; actorRef?: string | null },
): Promise<void> {
  if (record.workflowState === "idle") return;
  const pending = await pendingAfterAnswer(tx, record);
  const workflowState = settledWorkflowState(pending);
  if (record.workflowState === workflowState && record.nextActionAt === null) return;
  const now = new Date();
  await tx.update(crmRecords).set({ workflowState, nextActionAt: null, updatedAt: now })
    .where(eq(crmRecords.id, record.id));
  if (record.latestInboundMessageId) {
    await tx.update(crmClassifications).set({ acknowledgedAt: now, updatedAt: now }).where(and(
      eq(crmClassifications.crmRecordId, record.id),
      eq(crmClassifications.messageId, record.latestInboundMessageId),
      inArray(crmClassifications.status, ["auto_applied", "accepted", "overridden"]),
    ));
  }
  await appendCrmEvent(tx, {
    personId: record.personId,
    crmRecordId: record.id,
    pipelineId: record.pipelineId,
    eventType: "workflow.state_changed",
    actorType: input.actorType,
    actorRef: input.actorRef,
    fromData: { workflowState: record.workflowState, nextActionAt: record.nextActionAt },
    toData: { workflowState, nextActionAt: null },
    meta: { reason: input.reason, ...(pending.length ? { stillPending: pending } : {}) },
    contextVersion: record.contextVersion,
  });
}

function later(current: Date | null, next: Date): Date {
  return current && current.getTime() > next.getTime() ? current : next;
}

export type RecordManualOutboundInput = {
  recordId: string;
  personId: string;
  channel: CrmChannel;
  accountRef: string;
  providerThreadId?: string | null;
  providerContactId?: string | null;
  idempotencyKey: string;
  providerMessageId?: string | null;
  bodyText: string;
  raw?: Record<string, unknown> | null;
  sentAt: Date;
  /** The sequence-interruption reason, e.g. "manual_outbound_whatsapp". */
  reason: string;
  actorType: CrmEventActor;
  actorRef?: string | null;
  /** Free-form audit detail, e.g. { origin: "phone" }. */
  meta?: Record<string, unknown>;
};

export type RecordManualOutboundResult = {
  conversation: CrmConversation;
  message: CrmConversationMessage;
  duplicate: boolean;
  decision: ManualOutboundDecision | null;
};

export async function recordManualOutboundInTransaction(
  tx: CrmTransaction,
  input: RecordManualOutboundInput,
): Promise<RecordManualOutboundResult> {
  const { conversation } = await upsertConversationInTransaction(tx, {
    crmRecordId: input.recordId,
    personId: input.personId,
    channel: input.channel,
    accountRef: input.accountRef,
    providerThreadId: input.providerThreadId,
    providerContactId: input.providerContactId,
  });
  const { message, created } = await insertConversationMessageInTransaction(tx, {
    conversationId: conversation.id,
    personId: input.personId,
    channel: input.channel,
    accountRef: input.accountRef,
    direction: "outbound",
    idempotencyKey: input.idempotencyKey,
    providerMessageId: input.providerMessageId,
    subject: null,
    bodyText: input.bodyText,
    raw: input.raw,
    sentAt: input.sentAt,
  });
  // Already recorded — by an earlier delivery of this webhook, or by
  // sendDraft itself (the same provider message id).
  if (!created) return { conversation, message, duplicate: true, decision: null };

  const record = await lockCrmRecord(tx, input.recordId);
  const decision = manualOutboundDecision(record, input.sentAt);
  const now = new Date();
  const answered = decision === "answered";

  await tx.update(crmRecords).set({
    lastOutboundAt: later(record.lastOutboundAt, input.sentAt),
    lastInteractionAt: later(record.lastInteractionAt, input.sentAt),
    updatedAt: now,
  }).where(eq(crmRecords.id, record.id));

  await appendCrmEvent(tx, {
    personId: record.personId,
    crmRecordId: record.id,
    pipelineId: record.pipelineId,
    eventType: "message.recorded",
    actorType: input.actorType,
    actorRef: input.actorRef,
    toData: { messageId: message.id, channel: input.channel, direction: "outbound", sentAt: input.sentAt },
    meta: { conversationId: conversation.id, decision, idempotencyKey: message.idempotencyKey, ...input.meta },
    contextVersion: record.contextVersion,
  });
  if (answered) {
    await interruptActiveSequenceRunInTransaction(tx, {
      recordId: record.id,
      reason: input.reason,
      contextVersion: record.contextVersion,
    });
    const staled = await tx.update(crmDrafts).set({ status: "stale", updatedAt: now }).where(and(
      eq(crmDrafts.crmRecordId, record.id),
      inArray(crmDrafts.status, ["generating", "awaiting_review", "failed"]),
    )).returning({ id: crmDrafts.id });
    // A wrong-number apology waiting for review is not sent on top of their answer, nor written again later.
    await setAsideAcknowledgementsInTransaction(tx, { draftIds: staled.map((draft) => draft.id), reason: "someone answered the message by hand" });
    await settleAnsweredRecordInTransaction(tx, record, input);
  }
  return { conversation, message, duplicate: false, decision };
}
