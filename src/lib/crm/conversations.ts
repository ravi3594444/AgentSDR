import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { leads as linkedinLeads } from "@/lib/linkedin/schema";
import { whatsappAccounts, whatsappChats, whatsappCampaignLeads, whatsappCampaigns } from "@/lib/whatsapp/schema";
import { sameWhatsappContact } from "@/lib/whatsapp/contactIdentity";
import { people } from "@/lib/leads/schema";
import { outreachCampaigns, outreachLeads, outreachMailboxQueue } from "@/lib/outreach/schema";
import {
  crmConversationMessages,
  crmConversations,
  crmDrafts,
  crmRecords,
  type CrmChannel,
} from "./schema";
import { appendCrmEvent } from "./events";
import { backfillOutreachHistoryInTransaction } from "./outreachHistory";
import { CrmConflictError, type CrmTransaction, withCrmTransaction } from "./repository";
import { getOrCreateCrmRecordForInbound, lockCrmRecord, type CrmRecord } from "./records";
import {
  getPersonContactPolicy,
  lockPersonContactPolicyScope,
} from "./policies";
import { assertWorkflowTransition, workflowStateForInbound } from "./stateMachine";
import { enqueueCrmJobInTransaction } from "./queue";
import { interruptActiveSequenceRunInTransaction } from "./sequences";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";

export type CrmConversation = typeof crmConversations.$inferSelect;
export type CrmConversationMessage = typeof crmConversationMessages.$inferSelect;

function requiredText(value: string, label: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${label} is required`);
  return clean;
}

function optionalText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

export type UpsertConversationInput = {
  crmRecordId: string;
  personId: string;
  channel: CrmChannel;
  accountRef: string;
  providerThreadId?: string | null;
  providerContactId?: string | null;
};

/** Other channels and genuinely different WhatsApp contacts keep the strict identity check. */
async function contactIdentityAgrees(tx: CrmTransaction, input: UpsertConversationInput, existing: CrmConversation, incoming: string): Promise<boolean> {
  if (!existing.providerContactId || existing.providerContactId === incoming) return true;
  if (input.channel !== "whatsapp") return false;
  if (sameWhatsappContact(existing.providerContactId, incoming)) return true;
  const thread = optionalText(input.providerThreadId);
  if (!thread || existing.providerThreadId !== thread) return false;
  const [proof] = await tx.select({ personPhone: people.phone, chatPhone: whatsappChats.phone, chatProviderId: whatsappChats.providerId })
    .from(whatsappChats)
    .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, whatsappChats.accountId))
    .innerJoin(people, eq(people.id, whatsappChats.personId))
    .where(and(inOrg(whatsappAccounts), inOrg(people), eq(whatsappAccounts.unipileAccountId, input.accountRef.trim()),
      eq(whatsappChats.unipileChatId, thread), eq(whatsappChats.personId, input.personId))).limit(1);
  return Boolean(proof && sameWhatsappContact(existing.providerContactId, incoming, proof));
}

/** App-level advisory locking also makes nullable-thread conversation identity idempotent. */
export async function upsertConversationInTransaction(
  tx: CrmTransaction,
  input: UpsertConversationInput,
): Promise<{ conversation: CrmConversation; created: boolean }> {
  const accountRef = requiredText(input.accountRef, "Conversation account reference");
  const providerThreadId = optionalText(input.providerThreadId);
  const providerContactId = optionalText(input.providerContactId);
  const identity = input.channel === "whatsapp" && providerThreadId ? `thread:${providerThreadId}` : providerContactId
    ? `contact:${providerContactId}`
    : providerThreadId
      ? `thread:${providerThreadId}`
      : `record:${input.crmRecordId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${
    `crm-conversation:${input.channel}:${accountRef}:${identity}`
  }, 0))`);

  let existing: CrmConversation | undefined;
  if (providerThreadId) {
    [existing] = await tx
      .select()
      .from(crmConversations)
      .where(and(
        inOrg(crmConversations),
        eq(crmConversations.channel, input.channel),
        eq(crmConversations.accountRef, accountRef),
        eq(crmConversations.providerThreadId, providerThreadId),
      ))
      .limit(1);
  }
  if (!existing && providerContactId) {
    [existing] = await tx
      .select()
      .from(crmConversations)
      .where(and(
        inOrg(crmConversations),
        eq(crmConversations.crmRecordId, input.crmRecordId),
        eq(crmConversations.personId, input.personId),
        eq(crmConversations.channel, input.channel),
        eq(crmConversations.accountRef, accountRef),
        eq(crmConversations.providerContactId, providerContactId),
        providerThreadId ? isNull(crmConversations.providerThreadId) : undefined,
      ))
      .limit(1);
  }
  if (!existing && !providerThreadId && !providerContactId) {
    [existing] = await tx
      .select()
      .from(crmConversations)
      .where(and(
        inOrg(crmConversations),
        eq(crmConversations.crmRecordId, input.crmRecordId),
        eq(crmConversations.personId, input.personId),
        eq(crmConversations.channel, input.channel),
        eq(crmConversations.accountRef, accountRef),
        isNull(crmConversations.providerThreadId),
        isNull(crmConversations.providerContactId),
      ))
      .limit(1);
  }

  if (existing) {
    if (existing.crmRecordId !== input.crmRecordId || existing.personId !== input.personId) {
      throw new CrmConflictError("Provider conversation identity belongs to another Person");
    }
    if (
      existing.providerContactId
      && providerContactId
      && !(await contactIdentityAgrees(tx, input, existing, providerContactId))
    ) {
      throw new CrmConflictError("Provider thread and contact identities disagree");
    }
    const [updated] = await tx
      .update(crmConversations)
      .set({
        providerThreadId: providerThreadId ?? existing.providerThreadId,
        providerContactId: providerContactId ?? existing.providerContactId,
        status: "active",
        updatedAt: new Date(),
      })
      .where(and(inOrg(crmConversations), eq(crmConversations.id, existing.id)))
      .returning();
    if (!updated) throw new Error("CRM conversation update did not return a row");
    return { conversation: updated, created: false };
  }

  const [created] = await tx
    .insert(crmConversations)
    .values({
      organizationId: currentOrganizationId(),
      crmRecordId: input.crmRecordId,
      personId: input.personId,
      channel: input.channel,
      accountRef,
      providerThreadId,
      providerContactId,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { conversation: created, created: true };

  if (!providerThreadId) {
    throw new CrmConflictError("Concurrent conversation insert could not be resolved without a provider thread ID");
  }
  const [winner] = await tx
    .select()
    .from(crmConversations)
    .where(and(
      inOrg(crmConversations),
      eq(crmConversations.channel, input.channel),
      eq(crmConversations.accountRef, accountRef),
      eq(crmConversations.providerThreadId, providerThreadId),
    ))
    .limit(1);
  if (!winner) throw new Error("CRM conversation upsert completed without a readable row");
  if (winner.crmRecordId !== input.crmRecordId || winner.personId !== input.personId) {
    throw new CrmConflictError("Provider conversation identity belongs to another Person");
  }
  if (
    winner.providerContactId
    && providerContactId
    && !(await contactIdentityAgrees(tx, input, winner, providerContactId))
  ) {
    throw new CrmConflictError("Provider thread and contact identities disagree");
  }
  return { conversation: winner, created: false };
}

export type InsertConversationMessageInput = {
  conversationId: string;
  personId: string;
  channel: CrmChannel;
  accountRef: string;
  direction: "inbound" | "outbound";
  idempotencyKey: string;
  providerMessageId?: string | null;
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
  raw?: Record<string, unknown> | null;
  sentAt: Date;
};

export async function insertConversationMessageInTransaction(
  tx: CrmTransaction,
  input: InsertConversationMessageInput,
): Promise<{ message: CrmConversationMessage; created: boolean }> {
  const accountRef = requiredText(input.accountRef, "Message account reference");
  const idempotencyKey = requiredText(input.idempotencyKey, "Message idempotency key");
  if (!input.bodyText.trim()) throw new Error("Message body is required");
  const providerMessageId = optionalText(input.providerMessageId);

  const [created] = await tx
    .insert(crmConversationMessages)
    .values({
      conversationId: input.conversationId,
      personId: input.personId,
      channel: input.channel,
      accountRef,
      direction: input.direction,
      idempotencyKey,
      providerMessageId,
      subject: optionalText(input.subject),
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml ?? null,
      raw: input.raw ?? null,
      sentAt: input.sentAt,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { message: created, created: true };

  const matches = await tx
    .select()
    .from(crmConversationMessages)
    .where(and(
      inArray(
        crmConversationMessages.conversationId,
        tx.select({ id: crmConversations.id }).from(crmConversations).where(inOrg(crmConversations)),
      ),
      eq(crmConversationMessages.channel, input.channel),
      eq(crmConversationMessages.accountRef, accountRef),
      or(
        eq(crmConversationMessages.idempotencyKey, idempotencyKey),
        providerMessageId
          ? eq(crmConversationMessages.providerMessageId, providerMessageId)
          : undefined,
      ),
    ))
    .limit(2);
  if (new Set(matches.map((candidate) => candidate.id)).size > 1) {
    throw new CrmConflictError("Message idempotency key and provider message ID disagree");
  }
  const [existing] = matches;
  if (!existing) throw new Error("Message upsert completed without a readable row");
  if (
    existing.conversationId !== input.conversationId
    || existing.personId !== input.personId
    || existing.direction !== input.direction
  ) {
    throw new CrmConflictError("Message idempotency identity belongs to another conversation");
  }
  return { message: existing, created: false };
}

export type IngestInboundReplyInput = {
  personId: string;
  pipelineId?: string;
  channel: CrmChannel;
  accountRef: string;
  providerThreadId?: string | null;
  providerContactId?: string | null;
  idempotencyKey: string;
  providerMessageId?: string | null;
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
  raw?: Record<string, unknown> | null;
  sentAt: Date;
  actorRef?: string | null;
};

export type IngestInboundReplyResult = {
  record: CrmRecord;
  conversation: CrmConversation;
  message: CrmConversationMessage;
  duplicate: boolean;
  doNotContact: boolean;
};

export async function ingestInboundReplyInTransaction(
  tx: CrmTransaction,
  input: IngestInboundReplyInput,
): Promise<IngestInboundReplyResult> {
  const { record: initialRecord, created: recordCreated } = await getOrCreateCrmRecordForInbound(tx, {
    personId: input.personId,
    pipelineId: input.pipelineId,
    cause: "first_inbound_reply",
  });
  const { conversation } = await upsertConversationInTransaction(tx, {
    crmRecordId: initialRecord.id,
    personId: input.personId,
    channel: input.channel,
    accountRef: input.accountRef,
    providerThreadId: input.providerThreadId,
    providerContactId: input.providerContactId,
  });
  // So classification has the pitch, not just the reply, the first time a
  // conversation is worked. Per-row conflicts (e.g. outreach already
  // recorded) are swallowed inside the backfill itself; only a genuine DB
  // error reaches here, and that should fail the whole ingest same as any
  // other step below.
  await backfillOutreachHistoryInTransaction(tx, {
    conversationId: conversation.id,
    personId: input.personId,
    channel: input.channel,
    accountRef: input.accountRef,
  });
  const { message, created: messageCreated } = await insertConversationMessageInTransaction(tx, {
    conversationId: conversation.id,
    personId: input.personId,
    channel: input.channel,
    accountRef: input.accountRef,
    direction: "inbound",
    idempotencyKey: input.idempotencyKey,
    providerMessageId: input.providerMessageId,
    subject: input.subject,
    bodyText: input.bodyText,
    bodyHtml: input.bodyHtml,
    raw: input.raw,
    sentAt: input.sentAt,
  });

  if (!messageCreated) {
    const record = await lockCrmRecord(tx, initialRecord.id);
    const doNotContact = (await getPersonContactPolicy(tx, input.personId))?.doNotContact ?? false;
    return { record, conversation, message, duplicate: true, doNotContact };
  }

  await lockPersonContactPolicyScope(tx, input.personId);
  const current = await lockCrmRecord(tx, initialRecord.id);
  const doNotContact = (await getPersonContactPolicy(tx, input.personId))?.doNotContact ?? false;
  const nextWorkflowState = workflowStateForInbound(doNotContact);
  assertWorkflowTransition(current.workflowState, nextWorkflowState);
  const contextVersion = current.contextVersion + 1;
  const now = new Date();
  const [updated] = await tx
    .update(crmRecords)
    .set({
      workflowState: nextWorkflowState,
      activeChannel: input.channel,
      latestInboundMessageId: message.id,
      contextVersion,
      lastInboundAt: input.sentAt,
      lastInteractionAt: input.sentAt,
      nextActionAt: null,
      updatedAt: now,
    })
    .where(eq(crmRecords.id, current.id))
    .returning();
  if (!updated) throw new Error("Inbound CRM record update did not return a row");

  await interruptActiveSequenceRunInTransaction(tx, {
    recordId: current.id,
    reason: "new_inbound_reply",
    contextVersion,
  });
  await tx
    .update(crmDrafts)
    .set({ status: "stale", updatedAt: now })
    .where(and(
      eq(crmDrafts.crmRecordId, current.id),
      inArray(crmDrafts.status, ["generating", "awaiting_review", "failed"]),
    ));

  // A reply wins over every cold-outreach timer for this Person. The two
  // channel stores keep their execution state, separate from CRM classification.
  const emailEnrollments = await tx
    .select({ id: outreachLeads.id })
    .from(outreachLeads)
    .where(and(
      inArray(
        outreachLeads.campaignId,
        tx.select({ id: outreachCampaigns.id }).from(outreachCampaigns).where(inOrg(outreachCampaigns)),
      ),
      eq(outreachLeads.personId, current.personId),
      inArray(outreachLeads.sequenceStatus, ["pending", "initial_sent", "in_follow_up", "reply_processing"]),
    ));
  if (emailEnrollments.length) {
    const ids = emailEnrollments.map((row) => row.id);
    await tx.delete(outreachMailboxQueue).where(inArray(outreachMailboxQueue.leadId, ids));
    await tx.update(outreachLeads).set({ sequenceStatus: "reply_received", nextSendAt: null, updatedAt: now })
      .where(inArray(outreachLeads.id, ids));
  }
  await tx.update(linkedinLeads).set({ status: "REPLIED", updatedAt: now })
    .where(and(
      inOrg(linkedinLeads),
      eq(linkedinLeads.personId, current.personId),
      inArray(linkedinLeads.status, ["PENDING", "REQUEST_SENT", "CONNECTED", "ACCEPT_MESSAGE_SENT", "FOLLOW_UP_1_SENT", "FOLLOW_UP_2_SENT", "FOLLOW_UP_3_SENT"]),
    ));
  await tx.update(whatsappCampaignLeads).set({ status: "replied", repliedAt: now, nextSendAt: null, updatedAt: now })
    .where(and(
      inArray(
        whatsappCampaignLeads.campaignId,
        tx.select({ id: whatsappCampaigns.id }).from(whatsappCampaigns).where(inOrg(whatsappCampaigns)),
      ),
      eq(whatsappCampaignLeads.personId, current.personId),
      inArray(whatsappCampaignLeads.status, ["queued", "in_sequence"]),
    ));

  await enqueueCrmJobInTransaction(tx, {
    kind: "classification",
    entityId: message.id,
    payload: {
      crmRecordId: current.id,
      conversationId: conversation.id,
      expectedContextVersion: contextVersion,
    },
  });

  if (recordCreated) {
    await appendCrmEvent(tx, {
      personId: current.personId,
      crmRecordId: current.id,
      pipelineId: current.pipelineId,
      eventType: "record.created",
      actorType: "system",
      toData: { cause: "first_inbound_reply" },
      contextVersion,
    });
  }
  await appendCrmEvent(tx, {
    personId: current.personId,
    crmRecordId: current.id,
    pipelineId: current.pipelineId,
    eventType: "reply.received",
    actorType: "integration",
    actorRef: input.actorRef,
    fromData: { latestInboundMessageId: current.latestInboundMessageId },
    toData: {
      latestInboundMessageId: message.id,
      channel: input.channel,
      sentAt: input.sentAt,
    },
    meta: {
      conversationId: conversation.id,
      idempotencyKey: message.idempotencyKey,
      providerMessageId: message.providerMessageId,
      doNotContact,
    },
    contextVersion,
  });
  if (current.workflowState !== nextWorkflowState) {
    await appendCrmEvent(tx, {
      personId: current.personId,
      crmRecordId: current.id,
      pipelineId: current.pipelineId,
      eventType: "workflow.state_changed",
      actorType: "system",
      fromData: { workflowState: current.workflowState },
      toData: { workflowState: nextWorkflowState },
      meta: {
        reason: doNotContact ? "inbound_dnc_compliance_review" : "inbound_reply",
        reopened: current.workflowState === "idle" || current.workflowState === "closed",
      },
      contextVersion,
    });
  }
  return { record: updated, conversation, message, duplicate: false, doNotContact };
}

export function ingestInboundReply(
  input: IngestInboundReplyInput,
): Promise<IngestInboundReplyResult> {
  return withCrmTransaction((tx) => ingestInboundReplyInTransaction(tx, input));
}
