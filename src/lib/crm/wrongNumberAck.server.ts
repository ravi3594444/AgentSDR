import "server-only";

import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { autopilotReplies, autopilotTakeovers } from "@/lib/assistant/schema";
import { db } from "@/lib/db";
import { people } from "@/lib/leads/schema";
import { isSuppressed } from "@/lib/outreach/suppression";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { AUTOPILOT_ACTOR, AUTOPILOT_LIMITS } from "./autopilot";
import { runMembershipFor } from "./autopilot.server";
import { appendCrmEvent } from "./events";
import { isPersonDoNotContact, setPersonDoNotContactInTransaction } from "./policies";
import { lockCrmRecord, type CrmRecord } from "./records";
import { withCrmTransaction, type CrmExecutor, type CrmTransaction } from "./repository";
import { crmClassifications, crmConversationMessages, crmConversations, crmDrafts, crmRecords, crmSubcategories, crmWrongRoutes } from "./schema";
import { sendDraft, type CrmSendAdapter } from "./send";
import { whatsappAccounts, whatsappChats, whatsappMessages } from "@/lib/whatsapp/schema";
import { ACK_CLAIMABLE, candidateRoutes, closingAcknowledgement, detectsOptOutWording, isWrongRouteChannel, normalizeRoute, type WrongRouteAckStatus, type WrongRouteChannel } from "./wrongNumber";
import { findWrongRoutes, recordWrongRouteInTransaction, setAcknowledgementInTransaction, type CrmWrongRoute } from "./wrongRoutes";

/**
 * A reply that says "wrong number", handled once for both reply paths (the
 * reply agent and the classifier):
 *
 *   record the route as wrong and stop outreach on it (one transaction, before
 *   anything is sent) → write the one closing acknowledgement as a draft →
 *   Automatic run: reserve it under the organization's lock after reading
 *   every rule again, then send it through sendDraft; Review mode (or no
 *   run): it waits for a person in Action required.
 *
 * The claim is the crm_wrong_routes row (unique per organization, channel
 * and route), so a duplicate webhook, a repeated "wrong number", a retried
 * job or a second worker finds it and never writes a second apology. A
 * retry of the same message picks up where it stopped; an attempt that may
 * have reached the provider is uncertain and is never resent. Do Not
 * Contact, an explicit opt-out and a takeover always mean nothing is sent.
 */

export type CloseWrongNumberInput = {
  messageId: string;
  /** Who read it as a wrong number: the reply agent, the classifier, or a person confirming the classification. */
  source: "reply_agent" | "classifier" | "human";
  /** The person who confirmed it (source "human"). */
  actorRef?: string | null;
  /** The model's acknowledgement; checked here, and replaced by the fixed line in their language when it fails or is missing. */
  acknowledgement: string | null;
  /** The same message asks to stop or not be contacted: Do Not Contact, nothing sent. */
  optOut: boolean;
  reasoning?: string | null;
  /** Automatic sends are allowed on this server (production, or a test that says so). */
  sendAllowed: boolean;
  provider?: string | null;
  model?: string | null;
};

export type CloseWrongNumberOutcome = {
  routeId: string | null;
  /** False when the route was already recorded: a repeat or a retry, never a second apology. */
  created: boolean;
  ackStatus: WrongRouteAckStatus;
  ackReason: string | null;
  draftId: string | null;
  acknowledgement: string | null;
  /** One line for the reply agent's log and the Replies list. */
  summary: string;
};

type Scope = {
  messageId: string;
  sentAt: Date;
  leadMessage: string;
  subject: string | null;
  recordId: string;
  conversationId: string;
  channel: WrongRouteChannel;
  route: string | null;
  personId: string;
  /** The Person's email: an unsubscribed or bounced address takes no apology either. */
  email: string | null;
};

async function loadScope(executor: CrmExecutor, messageId: string): Promise<Scope | null> {
  const [row] = await executor.select({ message: crmConversationMessages, conversation: crmConversations, record: crmRecords, person: people })
    .from(crmConversationMessages)
    .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
    .innerJoin(crmRecords, eq(crmRecords.id, crmConversations.crmRecordId))
    .innerJoin(people, eq(people.id, crmRecords.personId))
    .where(and(inOrg(crmRecords), inOrg(crmConversations), eq(crmConversationMessages.id, messageId))).limit(1);
  if (!row || row.message.direction !== "inbound" || !isWrongRouteChannel(row.conversation.channel)) return null;
  const channel = row.conversation.channel;
  const scope: Scope = {
    messageId,
    sentAt: row.message.sentAt,
    leadMessage: row.message.bodyText ?? "",
    subject: row.message.subject,
    recordId: row.record.id,
    conversationId: row.conversation.id,
    channel,
    route: null,
    personId: row.record.personId,
    email: row.person.email,
  };
  const routes = channel === "whatsapp"
    ? await whatsappRoutes(executor, messageId, row.conversation, row.person.phone)
    : candidateRoutes(channel, {
      providerContactId: row.conversation.providerContactId,
      email: row.person.email,
      phone: row.person.phone,
      linkedinUrl: row.person.linkedinUrl,
    });
  // The route already recorded, when the chat runs into one (a repeat, a
  // duplicate record's chat with the same number); else the chat's own.
  const known = await findWrongRoutes(executor, { channel, routes, personId: row.record.personId });
  return { ...scope, route: known[0]?.route ?? routes[0] ?? null };
}

/**
 * The WhatsApp routes of the number that wrote, its own first. The chat
 * row WhatsApp delivered the message on knows that number when AgentSDR
 * opened the chat with it, even after the chat moved to a privacy id
 * ("…@lid"); a privacy-id chat with no known number is recorded by the id
 * itself, never by the Person's phone, which may be another number (an
 * operator's correction). Without a chat row (a message recorded on the CRM
 * only) the conversation's contact and the Person's phone are all there is.
 */
async function whatsappRoutes(
  executor: CrmExecutor,
  messageId: string,
  conversation: { providerContactId: string | null; providerThreadId: string | null; accountRef: string },
  personPhone: string | null,
): Promise<string[]> {
  const organizationId = currentOrganizationId();
  const [byMessage] = await executor.select({ phone: whatsappChats.phone, providerId: whatsappChats.providerId })
    .from(whatsappMessages)
    .innerJoin(whatsappChats, eq(whatsappChats.id, whatsappMessages.chatId))
    .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, whatsappChats.accountId))
    .where(and(eq(whatsappMessages.crmConversationMessageId, messageId), eq(whatsappAccounts.organizationId, organizationId)))
    .limit(1);
  const [byThread] = byMessage || !conversation.providerThreadId ? [] : await executor.select({ phone: whatsappChats.phone, providerId: whatsappChats.providerId })
    .from(whatsappChats)
    .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, whatsappChats.accountId))
    .where(and(
      eq(whatsappChats.unipileChatId, conversation.providerThreadId),
      eq(whatsappAccounts.unipileAccountId, conversation.accountRef),
      eq(whatsappAccounts.organizationId, organizationId),
    ))
    .limit(1);
  const chat = byMessage ?? byThread ?? null;
  const unique = (values: (string | null | undefined)[]) => [...new Set(values.map((value) => normalizeRoute("whatsapp", value)).filter((route): route is string => Boolean(route)))];
  const contact = normalizeRoute("whatsapp", conversation.providerContactId) ?? normalizeRoute("whatsapp", chat?.providerId);
  const privacyId = Boolean(contact?.endsWith("@lid"));
  if (chat?.phone) return unique([chat.phone, privacyId ? null : contact]);
  if (!privacyId) return unique([contact, personPhone]);
  return chat ? unique([contact]) : unique([personPhone, contact]);
}

/** What stops the acknowledgement, read again before every step that could send it. */
async function ackBlocker(executor: CrmExecutor, scope: Scope, optOut: boolean): Promise<string | null> {
  if (optOut) return "they asked not to be contacted";
  if (await isPersonDoNotContact(executor, scope.personId)) return "the lead is marked Do Not Contact";
  if (scope.channel === "email" && scope.email && await isSuppressed(scope.email)) return "the address unsubscribed or bounced";
  const [takeover] = await executor.select({ id: autopilotTakeovers.id }).from(autopilotTakeovers)
    .where(and(inOrg(autopilotTakeovers), eq(autopilotTakeovers.conversationId, scope.conversationId))).limit(1);
  if (takeover) return "you are handling this conversation yourself";
  const [record] = await executor.select({ latestInboundMessageId: crmRecords.latestInboundMessageId })
    .from(crmRecords).where(and(inOrg(crmRecords), eq(crmRecords.id, scope.recordId))).limit(1);
  if (record?.latestInboundMessageId && record.latestInboundMessageId !== scope.messageId) return "a newer message arrived";
  const [answered] = await executor.select({ n: count() }).from(crmConversationMessages)
    .where(and(eq(crmConversationMessages.conversationId, scope.conversationId), eq(crmConversationMessages.direction, "outbound"), gt(crmConversationMessages.sentAt, scope.sentAt)));
  if (Number(answered?.n ?? 0) > 0) return "someone already answered after this message";
  return null;
}

/** Nothing is left for a person (no draft to review, nothing unresolved): the record leaves Action required. Do Not Contact and a takeover keep theirs. */
async function settleRecord(tx: CrmTransaction, scope: Scope, pendingReview: boolean): Promise<void> {
  const now = new Date();
  if (pendingReview) {
    await tx.update(crmRecords).set({ workflowState: "action_required", nextActionAt: now, updatedAt: now }).where(eq(crmRecords.id, scope.recordId));
    return;
  }
  if (await isPersonDoNotContact(tx, scope.personId)) return;
  const [takeover] = await tx.select({ id: autopilotTakeovers.id }).from(autopilotTakeovers)
    .where(and(inOrg(autopilotTakeovers), eq(autopilotTakeovers.conversationId, scope.conversationId))).limit(1);
  if (takeover) return;
  await tx.update(crmRecords).set({ workflowState: "idle", nextActionAt: null, updatedAt: now })
    .where(and(eq(crmRecords.id, scope.recordId), eq(crmRecords.latestInboundMessageId, scope.messageId)));
}

/**
 * The CRM files the message as "Wrong Number" (category other, never
 * interested or not interested). Applied directly when the lead has no
 * other classification; an earlier real one (they were interested on
 * another channel) stays, with this message's proposal beside it.
 */
async function applyWrongNumberClassification(tx: CrmTransaction, record: CrmRecord, messageId: string): Promise<void> {
  const [classification] = await tx.select().from(crmClassifications)
    .where(and(eq(crmClassifications.crmRecordId, record.id), eq(crmClassifications.messageId, messageId)))
    .orderBy(desc(crmClassifications.createdAt)).limit(1);
  if (!classification || classification.status !== "proposed" || classification.proposedCategoryKey !== "other") return;
  if (record.categoryLocked || (record.categoryKey && record.categoryKey !== "other")) return;
  const [subcategory] = await tx.select({ id: crmSubcategories.id }).from(crmSubcategories)
    .where(and(eq(crmSubcategories.pipelineId, record.pipelineId), eq(crmSubcategories.key, "wrong_number"), eq(crmSubcategories.active, true))).limit(1);
  const subcategoryId = subcategory?.id ?? null;
  const now = new Date();
  await tx.update(crmClassifications).set({
    status: "auto_applied",
    proposedSubcategoryId: subcategoryId,
    appliedCategoryKey: "other",
    appliedSubcategoryId: subcategoryId,
    updatedAt: now,
  }).where(eq(crmClassifications.id, classification.id));
  await tx.update(crmRecords).set({ categoryKey: "other", subcategoryId, categorySource: "ai", categoryLocked: false, updatedAt: now })
    .where(eq(crmRecords.id, record.id));
  await appendCrmEvent(tx, {
    personId: record.personId,
    crmRecordId: record.id,
    pipelineId: record.pipelineId,
    eventType: "classification.auto_applied",
    actorType: "ai",
    fromData: { categoryKey: record.categoryKey, subcategoryId: record.subcategoryId },
    toData: { classificationId: classification.id, categoryKey: "other", subcategoryId },
    meta: { decision: "wrong_number" },
    contextVersion: record.contextVersion,
  });
}

function emailSubject(scope: Scope): string | null {
  if (scope.channel !== "email") return null;
  const subject = scope.subject?.trim() || "your message";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

async function writeAcknowledgementDraft(tx: CrmTransaction, record: CrmRecord, scope: Scope, text: string, input: CloseWrongNumberInput) {
  const [draft] = await tx.insert(crmDrafts).values({
    crmRecordId: record.id,
    conversationId: scope.conversationId,
    replyForMessageId: scope.messageId,
    sequenceStepRunId: null,
    expectedContextVersion: record.contextVersion,
    channel: scope.channel,
    subject: emailSubject(scope),
    aiBodyText: text,
    status: "awaiting_review",
    provider: input.provider ?? "wrong-number",
    model: input.model ?? "closing-acknowledgement",
    request: { wrongNumberAcknowledgement: true, messageId: scope.messageId },
    response: { acknowledgement: text },
  }).returning();
  await appendCrmEvent(tx, {
    personId: record.personId,
    crmRecordId: record.id,
    pipelineId: record.pipelineId,
    eventType: "draft.generated",
    actorType: "ai",
    actorRef: input.source === "reply_agent" ? AUTOPILOT_ACTOR : input.model ?? null,
    toData: { draftId: draft!.id, revision: draft!.revision, sequenceStepRunId: null },
    meta: { wrongNumberAcknowledgement: true, source: input.source },
    contextVersion: record.contextVersion,
  });
  return draft!;
}

const ROUTE_WORD: Record<WrongRouteChannel, string> = { whatsapp: "number", email: "address", linkedin: "profile", instagram: "account" };

function summarize(channel: WrongRouteChannel, row: Pick<CrmWrongRoute, "ackStatus" | "ackReason"> | null, created: boolean): string {
  const head = `Wrong number: outreach to this ${ROUTE_WORD[channel]} stopped`;
  if (!row) return `${head}, but there is no ${ROUTE_WORD[channel]} to record`;
  const reason = row.ackReason ? ` (${row.ackReason})` : "";
  switch (row.ackStatus) {
    case "sent": return `${head}; one apology sent`;
    case "drafted": return `${head}; the apology waits for you in Action required${reason}`;
    case "reserved":
    case "sending": return `${head}; the apology is being sent`;
    case "failed": return `${head}; the apology could not be sent and is not retried${reason}`;
    case "uncertain": return `${head}; whether the apology arrived is uncertain, so it is not resent${reason}`;
    case "blocked": return `${head}; no apology${reason}`;
    default: return created ? `${head}; no apology` : `${head} earlier; no second apology`;
  }
}

function outcome(scope: Scope, row: CrmWrongRoute | null, created: boolean, acknowledgement: string | null): CloseWrongNumberOutcome {
  return {
    routeId: row?.id ?? null,
    created,
    ackStatus: row?.ackStatus ?? "none",
    ackReason: row?.ackReason ?? null,
    draftId: row?.ackDraftId ?? null,
    acknowledgement,
    summary: summarize(scope.channel, row, created),
  };
}

type Step = { row: CrmWrongRoute | null; created: boolean; dispatch: { draftId: string; revision: number } | null };

/**
 * Records the wrong route for the message, stops outreach on it and, when
 * nothing forbids it, sends or drafts the one closing acknowledgement.
 * Returns null when the message is not an inbound one on a CRM record of
 * the organization in scope.
 */
export async function closeWrongNumber(input: CloseWrongNumberInput, deps: { send?: CrmSendAdapter } = {}): Promise<CloseWrongNumberOutcome | null> {
  const organizationId = currentOrganizationId();
  const scope = await loadScope(db, input.messageId);
  if (!scope) return null;
  const { text } = closingAcknowledgement(input.acknowledgement, scope.leadMessage, scope.channel);
  // An explicit stop in the same message means Do Not Contact and no apology,
  // whoever read it: the caller's reading or the message's own words.
  const optOut = input.optOut || detectsOptOutWording(scope.leadMessage);
  const actorType = input.source === "human" ? "authenticated_operator" : "ai";
  const actorRef = input.source === "reply_agent" ? AUTOPILOT_ACTOR : input.source === "human" ? input.actorRef ?? null : input.model ?? "classifier";

  // 1. Record the route and stop outreach on it, before anything is sent;
  //    write the acknowledgement draft in the same transaction.
  const step: Step = await withCrmTransaction(async (tx) => {
    const { pipelineId } = await lockCrmRecord(tx, scope.recordId);
    if (optOut) {
      await setPersonDoNotContactInTransaction(tx, {
        personId: scope.personId,
        reason: "Wrong number, and they asked not to be contacted (read in their reply)",
        source: "inbound_request",
        actorType,
        actorRef,
      });
    }
    if (!scope.route) return { row: null, created: false, dispatch: null };
    const blocker = await ackBlocker(tx, scope, optOut);
    const membership = await runMembershipFor(tx, scope.personId, scope.channel, scope.conversationId);
    const automatic = Boolean(membership?.automatic && membership.runStatus === "running" && membership.leadStatus === "active" && input.sendAllowed);
    const reviewReason = input.source !== "human" && membership?.automatic && membership.runStatus === "running" && !input.sendAllowed
      ? "Automatic sends only go out from a production server"
      : null;
    const recorded = await recordWrongRouteInTransaction(tx, {
      personId: scope.personId,
      channel: scope.channel,
      route: scope.route,
      crmRecordId: scope.recordId,
      pipelineId,
      conversationId: scope.conversationId,
      messageId: scope.messageId,
      source: input.source,
      reason: input.reasoning?.trim() || "They said this does not reach the intended lead",
      ackStatus: blocker ? "blocked" : "none",
      ackReason: blocker,
      actorType,
      actorRef,
    });
    // Read again: Do Not Contact moves the record's context on.
    const record = await lockCrmRecord(tx, scope.recordId);
    if (!optOut) await applyWrongNumberClassification(tx, record, scope.messageId);
    const row = recorded.row;

    if (recorded.created) {
      if (blocker) {
        await settleRecord(tx, scope, false);
        return { row, created: true, dispatch: null };
      }
      // Automatic: claimed for this worker's send now (reserved), in the same
      // transaction as the draft, so no other worker or repeat can take it.
      // Review: it waits for a person (drafted). Either way the record shows
      // it in Action required until it is sent or set aside.
      const draft = await writeAcknowledgementDraft(tx, record, scope, text, input);
      await setAcknowledgementInTransaction(tx, { id: row.id, from: ["none"], to: automatic ? "reserved" : "drafted", draftId: draft.id, reason: automatic ? null : reviewReason });
      await settleRecord(tx, scope, true);
      return { row, created: true, dispatch: automatic ? { draftId: draft.id, revision: draft.revision } : null };
    }

    // The apology still waiting for review, when this route has one. A
    // person discarding it, or setting it aside by another action (a
    // reclassification, a stage move, an answer of their own), ends it: it is
    // never written again. Set aside by a newer message in this chat, or by a
    // person confirming Wrong Number, it is written again against the current
    // context: still one.
    const waiting = row.ackStatus === "drafted" && row.ackDraftId
      ? (await tx.select({ status: crmDrafts.status, aiBodyText: crmDrafts.aiBodyText, editedBodyText: crmDrafts.editedBodyText })
        .from(crmDrafts).where(eq(crmDrafts.id, row.ackDraftId)).limit(1))[0] ?? null
      : null;
    if (waiting?.status === "discarded") {
      await setAcknowledgementInTransaction(tx, { id: row.id, from: ["drafted"], to: "blocked", reason: "a person set the apology aside" });
      if (row.messageId !== scope.messageId) await settleRecord(tx, scope, false);
      return { row, created: false, dispatch: null };
    }
    const writeAgain = async () => {
      await tx.update(crmDrafts).set({ status: "stale", updatedAt: new Date() })
        .where(and(eq(crmDrafts.id, row.ackDraftId!), inArray(crmDrafts.status, ["generating", "awaiting_review", "failed"])));
      const draft = await writeAcknowledgementDraft(tx, record, scope, waiting?.editedBodyText?.trim() || waiting?.aiBodyText?.trim() || text, input);
      await setAcknowledgementInTransaction(tx, { id: row.id, from: ["drafted"], to: "drafted", draftId: draft.id, reason: row.ackReason });
      await settleRecord(tx, scope, true);
    };

    if (row.messageId === scope.messageId) {
      // The same message again (a retried job, a restart): carry on from
      // where it stopped, never from the start.
      if (row.ackStatus === "sending") {
        // Interrupted after the send began: whether it arrived is unknown.
        await setAcknowledgementInTransaction(tx, { id: row.id, from: ["sending"], to: "uncertain", reason: "the send was interrupted before its outcome was recorded; check whether it arrived" });
        return { row, created: false, dispatch: null };
      }
      if (row.ackStatus === "reserved" && row.ackDraftId) {
        // Claimed but never attempted (prepareSend moves it to sending in
        // the attempt's own transaction): safe to send, once.
        const [draft] = await tx.select({ revision: crmDrafts.revision }).from(crmDrafts).where(eq(crmDrafts.id, row.ackDraftId)).limit(1);
        return { row, created: false, dispatch: draft ? { draftId: row.ackDraftId, revision: draft.revision } : null };
      }
      if (waiting?.status === "stale" && row.conversationId === scope.conversationId) {
        // Set aside without a newer message (a person confirmed Wrong
        // Number): written again, unless something now forbids it.
        if (blocker) {
          await setAcknowledgementInTransaction(tx, { id: row.id, from: ["drafted"], to: "blocked", reason: blocker });
          await settleRecord(tx, scope, false);
        } else {
          await writeAgain();
        }
      }
      return { row, created: false, dispatch: null };
    }

    // A later message on a route already recorded: no second apology.
    if (row.ackStatus === "reserved" && row.ackDraftId) {
      // Claimed for an Automatic send that this newer message has made
      // outdated (it set the draft aside): it never goes out. A send already
      // under way is left to finish; prepareSend refuses a set-aside draft.
      const [draft] = await tx.select({ status: crmDrafts.status }).from(crmDrafts).where(eq(crmDrafts.id, row.ackDraftId)).limit(1);
      if (draft && draft.status !== "awaiting_review" && draft.status !== "sending") {
        await setAcknowledgementInTransaction(tx, { id: row.id, from: ["reserved"], to: "blocked", reason: "a newer message arrived before it was sent" });
      }
    }
    // One still waiting for review in this chat was set aside by this message
    // (every inbound stales the record's drafts), so it is written again
    // against it: still one. (In another record's chat it was left alone.)
    if (row.ackStatus === "drafted" && row.ackDraftId && row.conversationId === scope.conversationId && !blocker) {
      await writeAgain();
      return { row, created: false, dispatch: null };
    }
    if (blocker && ACK_CLAIMABLE.includes(row.ackStatus)) {
      await setAcknowledgementInTransaction(tx, { id: row.id, from: ACK_CLAIMABLE, to: "blocked", reason: blocker });
      if (row.ackDraftId) {
        await tx.update(crmDrafts).set({ status: "stale", updatedAt: new Date() })
          .where(and(eq(crmDrafts.id, row.ackDraftId), inArray(crmDrafts.status, ["generating", "awaiting_review", "failed"])));
      }
    }
    await settleRecord(tx, scope, false);
    return { row, created: false, dispatch: null };
  });

  const reread = async () => step.row
    ? (await db.select().from(crmWrongRoutes).where(and(inOrg(crmWrongRoutes), eq(crmWrongRoutes.id, step.row.id))).limit(1))[0] ?? step.row
    : null;
  if (!step.row || !step.dispatch) return outcome(scope, await reread(), step.created, text);
  const routeId = step.row.id;
  const { draftId, revision } = step.dispatch;

  // 2. Automatic: confirm the claim under the organization's lock (the same
  //    one the reply limits are counted under), after reading every rule
  //    again: a newer message, an opt-out or a takeover since stops it.
  const reservation = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`autopilot:${organizationId}`}, 0))`);
    const [row] = await tx.select().from(crmWrongRoutes).where(and(inOrg(crmWrongRoutes), eq(crmWrongRoutes.id, routeId))).limit(1).for("update");
    if (!row || row.ackDraftId !== draftId || row.ackStatus !== "reserved") return { go: false } as const;
    const blocker = await ackBlocker(tx, scope, false);
    if (blocker) {
      await setAcknowledgementInTransaction(tx, { id: routeId, from: ["reserved"], to: "blocked", reason: blocker });
      await tx.update(crmDrafts).set({ status: "stale", updatedAt: new Date() }).where(and(eq(crmDrafts.id, draftId), eq(crmDrafts.status, "awaiting_review")));
      await settleRecord(tx, scope, false);
      return { go: false } as const;
    }
    const membership = await runMembershipFor(tx, scope.personId, scope.channel, scope.conversationId);
    const counted = inArray(autopilotReplies.status, ["reserved", "sent", "failed"]);
    const [inConversation] = await tx.select({ n: count() }).from(autopilotReplies)
      .where(and(eq(autopilotReplies.organizationId, organizationId), eq(autopilotReplies.conversationId, scope.conversationId), counted));
    const [inDay] = await tx.select({ n: count() }).from(autopilotReplies)
      .where(and(eq(autopilotReplies.organizationId, organizationId), gte(autopilotReplies.createdAt, new Date(Date.now() - 24 * 60 * 60_000)), counted));
    const review = !membership?.automatic ? "the run is in Review mode"
      : membership.runStatus !== "running" ? `the run is ${membership.runStatus}`
        : membership.leadStatus === "opted_out" ? "they asked not to be contacted"
          : Number(inConversation?.n ?? 0) >= AUTOPILOT_LIMITS.perConversation ? "the automatic reply limit for this chat is reached"
            : Number(inDay?.n ?? 0) >= AUTOPILOT_LIMITS.perDay ? `the limit of ${AUTOPILOT_LIMITS.perDay} automatic replies in 24 hours is reached`
              : null;
    if (review) {
      // Not sent automatically: it waits for a person, still the only one.
      await setAcknowledgementInTransaction(tx, { id: routeId, from: ["reserved"], to: "drafted", reason: review });
      return { go: false } as const;
    }
    const reserved = await tx.insert(autopilotReplies).values({
      organizationId,
      draftId,
      revision,
      conversationId: scope.conversationId,
      runId: membership!.runId,
      personId: scope.personId,
      status: "reserved",
      reason: "wrong-number acknowledgement",
    }).onConflictDoNothing().returning({ id: autopilotReplies.id });
    // Not owned: a resumed claim whose reservation an earlier worker made;
    // that worker's sent or reserved is never turned into failed here.
    return { go: true, owned: reserved.length > 0 } as const;
  });
  if (!reservation.go) return outcome(scope, await reread(), step.created, text);

  // 3. The send, through the same path as Approve & send. prepareSend
  //    consumes the single-use claim (reserved → sending); the send path
  //    records sent, failed or uncertain on the row. Never retried here.
  try {
    await sendDraft({
      draftId,
      revision,
      idempotencyKey: `wrong-number-ack:${step.row.messageId ?? input.messageId}`,
      requestId: randomUUID(),
      actorRef: AUTOPILOT_ACTOR,
    }, { send: deps.send });
    await db.update(autopilotReplies).set({ status: "sent", updatedAt: new Date() })
      .where(and(eq(autopilotReplies.organizationId, organizationId), eq(autopilotReplies.draftId, draftId), eq(autopilotReplies.revision, revision)));
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    if (reservation.owned) {
      await db.update(autopilotReplies).set({ status: "failed", reason: `the acknowledgement was not sent: ${message}`.slice(0, 1_000), updatedAt: new Date() })
        .where(and(eq(autopilotReplies.organizationId, organizationId), eq(autopilotReplies.draftId, draftId), eq(autopilotReplies.revision, revision), eq(autopilotReplies.status, "reserved")));
    }
    // Refused before any attempt (the claim is still reserved): it never goes out.
    await withCrmTransaction(async (tx) => {
      if (await setAcknowledgementInTransaction(tx, { id: routeId, from: ["reserved"], to: "blocked", reason: `the send was refused: ${message}` })) {
        await tx.update(crmDrafts).set({ status: "stale", updatedAt: new Date() }).where(and(eq(crmDrafts.id, draftId), eq(crmDrafts.status, "awaiting_review")));
        await settleRecord(tx, scope, false);
      }
    });
  }
  return outcome(scope, await reread(), step.created, text);
}
