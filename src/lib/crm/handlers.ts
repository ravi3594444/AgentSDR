import { and, asc, eq } from "drizzle-orm";
import { handleAutoSendJob, runMembershipFor } from "./autopilot.server";
import { messageParticipants } from "./participants";
import { formatAiInstructions } from "./ai/instructions";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { classifyCrmReply } from "./ai/classify";
import { isBareGreeting } from "./greeting";
import type {
  ClassificationCompletion,
  ClassificationContextInput,
  ClassificationSubcategory,
} from "./ai/types";
import { generateDraftForStep, generateFallbackDraft } from "./drafts";
import { loadCallContextMessages } from "./callHistory";
import { appendCrmEvent } from "./events";
import { inboundAnsweredSince, settleAnsweredRecordInTransaction } from "./manualOutbound";
import { setPersonDoNotContactInTransaction } from "./policies";
import { enqueueCrmJobInTransaction, type CrmJob } from "./queue";
import { CrmConflictError, withCrmTransaction } from "./repository";
import { lockCrmRecord, recordAiClassificationInTransaction } from "./records";
import {
  crmCategories,
  crmClassifications,
  crmConversationMessages,
  crmConversations,
  crmKnowledgeDocumentVersions,
  crmKnowledgeDocuments,
  crmRecords,
  crmSequenceRuns,
  crmSequenceStepRuns,
  crmSequenceSteps,
  crmSettings,
  crmSubcategories,
  crmWrongRoutes,
  type CrmCategoryKey,
} from "./schema";
import { startSequenceRunInTransaction } from "./sequences";
import { PermanentCrmJobError, registerCrmJobHandlers, RetryCrmJobLaterError, STALE_LOCK_MS } from "./worker";
import { replyBudgetForJob } from "./ai/budget.server";
import { claudeHoldUntil } from "@/lib/ai/claudeCode/runner.server";

/** A held Claude Code login (usage limit) puts a classification back: looked at again at most this often, and for at most this long. */
const HELD_CLASSIFICATION_RECHECK_MS = 15 * 60_000;
const HELD_CLASSIFICATION_MAX_WAIT_MS = 8 * 24 * 60 * 60_000;
import { detectsOptOutWording, detectsWrongNumber } from "./wrongNumber";
import { wrongRouteForConversation } from "./wrongRoutes";
import { inOrg } from "@/lib/tenancy/scope";

/** Deliberately conservative: only direct first-person suppression commands match. */
export function detectsExplicitDncIntent(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
  return [
    /\bunsubscribe\s+me\b/,
    /\bremove\s+me\s+from\s+(?:your|the)\s+(?:list|emails?)\b/,
    /\b(?:do not|don't)\s+(?:contact|email|message|call)\s+me\b/,
    /\bstop\s+(?:contacting|emailing|messaging|calling)\s+me\b/,
    /\bno\s+more\s+(?:emails?|messages?|calls?)\b/,
  ].some((pattern) => pattern.test(normalized));
}

/**
 * True when an applied (non-stale) classification landed on the seeded "Do Not
 * Contact" subcategory. That subcategory has no sequence, so unless this is
 * checked separately from the regex-based `detectsExplicitDncIntent`, the
 * classification job would fall through to a fallback draft addressed to
 * someone the AI itself just determined should not be contacted.
 */
export function classifiedIntoDoNotContactSubcategory(
  appliedResult: { applied: boolean; stale: boolean },
  subcategoryId: string | null,
  subcategories: readonly Pick<ClassificationSubcategory, "id" | "key">[],
): boolean {
  if (!appliedResult.applied || appliedResult.stale || !subcategoryId) return false;
  const subcategory = subcategories.find((candidate) => candidate.id === subcategoryId);
  return subcategory?.key === "do_not_contact";
}

function subcategoryKeyOf(subcategoryId: string | null, subcategories: readonly Pick<ClassificationSubcategory, "id" | "key">[]): string | null {
  return subcategoryId ? subcategories.find((candidate) => candidate.id === subcategoryId)?.key ?? null : null;
}

/**
 * True when the classifier's reading closes a wrong number: the "Wrong
 * Number" subcategory on a current classification, applied, or proposed
 * (an "other" category always is, by default) with the plain words or
 * reasonable confidence. Anything less waits for a person, and never gets
 * a sales draft either way.
 */
export function classifiedAsWrongNumber(
  appliedResult: { applied: boolean; stale: boolean },
  subcategoryId: string | null,
  subcategories: readonly Pick<ClassificationSubcategory, "id" | "key">[],
  evidence: { confidence: number; wrongNumberWords: boolean },
): boolean {
  if (appliedResult.stale || subcategoryKeyOf(subcategoryId, subcategories) !== "wrong_number") return false;
  return appliedResult.applied || evidence.wrongNumberWords || evidence.confidence >= 0.6;
}

/** Whether the wrong-number apology may go out automatically from here, with the reply agent's stand-ins in tests. */
function wrongNumberSending(agent: false | import("@/lib/assistant/replyAgent/agent.server").ReplyAgentDependencies) {
  const deps = agent || {};
  return {
    sendAllowed: deps.allowNonProduction ?? (process.env.NODE_ENV === "production" || process.env.AUTOPILOT_ALLOW_NON_PRODUCTION === "true"),
    send: deps.send,
  };
}

function scalarAttributes(raw: Record<string, unknown> | null | undefined) {
  return Object.fromEntries(Object.entries(raw ?? {}).filter((entry): entry is [string, string | number | boolean | null] => {
    const value = entry[1];
    return value === null || ["string", "number", "boolean"].includes(typeof value);
  }));
}

async function classificationContext(messageId: string): Promise<{
  recordId: string;
  conversationId: string;
  channel: string;
  expectedContextVersion: number;
  personId: string;
  /** An explicit opt-out; "wrong number" beside any stop or unsubscribe wording counts as one. */
  dncIntent: boolean;
  /** The message says "wrong number" (or the wrong person) in plain words. */
  wrongNumberWords: boolean;
  /** Any stop, unsubscribe or "don't text me" wording: beside a wrong number it means Do Not Contact, nothing sent. */
  optOutWords: boolean;
  /** The conversation's route was already recorded as a wrong number. */
  routeWrong: boolean;
  /** Only a greeting or an acknowledgement ("Hey", "ok thanks"): never interest, whatever the model says. */
  greetingOnly: boolean;
  input: Parameters<typeof classifyCrmReply>[0];
}> {
  const [scope] = await db.select({ message: crmConversationMessages, conversation: crmConversations, record: crmRecords })
    .from(crmConversationMessages)
    .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
    .innerJoin(crmRecords, eq(crmRecords.id, crmConversations.crmRecordId))
    .where(and(inOrg(crmRecords), inOrg(crmConversations), eq(crmConversationMessages.id, messageId))).limit(1);
  if (!scope) throw new PermanentCrmJobError(`Inbound CRM message ${messageId} was not found`);
  if (scope.message.direction !== "inbound") throw new PermanentCrmJobError("Classification jobs require an inbound message");
  if (scope.record.latestInboundMessageId !== messageId) {
    throw new PermanentCrmJobError("Classification job was superseded by a newer inbound message");
  }
  const [profile, categories, subcategories, messages, settings, currentSubcategory, knowledgeDocuments, calls] = await Promise.all([
    db.select({ person: people, company: companies }).from(people)
      .leftJoin(companies, eq(companies.id, people.companyId))
      .where(and(inOrg(people), eq(people.id, scope.record.personId))).limit(1),
    db.select().from(crmCategories).orderBy(asc(crmCategories.sortOrder)),
    db.select().from(crmSubcategories)
      .where(and(eq(crmSubcategories.pipelineId, scope.record.pipelineId), eq(crmSubcategories.active, true)))
      .orderBy(asc(crmSubcategories.sortOrder)),
    db.select().from(crmConversationMessages)
      .where(eq(crmConversationMessages.conversationId, scope.conversation.id))
      .orderBy(asc(crmConversationMessages.sentAt), asc(crmConversationMessages.id)),
    db.select().from(crmSettings).where(eq(crmSettings.pipelineId, scope.record.pipelineId)).limit(1),
    scope.record.subcategoryId
      ? db.select().from(crmSubcategories).where(eq(crmSubcategories.id, scope.record.subcategoryId)).limit(1)
      : Promise.resolve([]),
    db.select({
      documentId: crmKnowledgeDocuments.id,
      title: crmKnowledgeDocuments.title,
      kind: crmKnowledgeDocuments.kind,
      content: crmKnowledgeDocumentVersions.content,
    }).from(crmKnowledgeDocuments)
      .innerJoin(crmKnowledgeDocumentVersions, and(
        eq(crmKnowledgeDocumentVersions.documentId, crmKnowledgeDocuments.id),
        eq(crmKnowledgeDocumentVersions.version, crmKnowledgeDocuments.latestVersion),
      ))
      .where(and(inOrg(crmKnowledgeDocuments), eq(crmKnowledgeDocuments.active, true), eq(crmKnowledgeDocuments.alwaysInclude, true)))
      .orderBy(asc(crmKnowledgeDocuments.title)),
    // A WhatsApp reply often follows a call; the classifier gets its summary.
    scope.conversation.channel === "whatsapp"
      ? loadCallContextMessages(db, scope.record.personId)
      : Promise.resolve([]),
  ]);
  if (!profile[0]) throw new PermanentCrmJobError(`Person ${scope.record.personId} was not found`);
  const person = profile[0].person;
  const company = profile[0].company;
  const contextInput: ClassificationContextInput = {
    categories: categories.map((category) => ({ key: category.key as CrmCategoryKey, label: category.label })),
    subcategories: subcategories.map((subcategory) => ({
      id: subcategory.id,
      categoryKey: subcategory.categoryKey as CrmCategoryKey,
      key: subcategory.key,
      name: subcategory.name,
      description: subcategory.description,
      classificationGuidance: subcategory.classificationGuidance,
      reviewRequired: subcategory.reviewRequired,
      stageRank: subcategory.stageRank,
    })),
    person: {
      id: person.id,
      fullName: person.fullName,
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email,
      linkedinUrl: person.linkedinUrl,
      title: person.title,
      attributes: scalarAttributes(person.raw),
    },
    company: company ? {
      id: company.id,
      name: company.name,
      domain: company.domain,
      linkedinUrl: company.linkedinUrl,
      attributes: scalarAttributes(company.raw),
    } : null,
    currentClassification: {
      categoryKey: scope.record.categoryKey as CrmCategoryKey | null,
      subcategoryKey: currentSubcategory[0]?.key ?? null,
      categorySource: scope.record.categorySource,
      categoryLocked: scope.record.categoryLocked,
      stageRank: currentSubcategory[0]?.stageRank ?? null,
    },
    latestInboundMessage: {
      id: scope.message.id,
      channel: scope.message.channel,
      direction: "inbound",
      sentAt: scope.message.sentAt,
      subject: scope.message.subject,
      bodyText: scope.message.bodyText,
    },
    recentConversation: [
      ...messages.map((message) => ({
        id: message.id,
        channel: message.channel,
        direction: message.direction,
        sentAt: message.sentAt,
        subject: message.subject,
        bodyText: message.bodyText,
        participants: messageParticipants(message),
      })),
      ...calls,
    ],
    knowledge: knowledgeDocuments.map((document) => ({
      documentId: document.documentId,
      title: document.title,
      kind: document.kind,
      content: document.content,
    })),
  };
  return {
    recordId: scope.record.id,
    conversationId: scope.conversation.id,
    channel: scope.conversation.channel,
    expectedContextVersion: scope.record.contextVersion,
    personId: scope.record.personId,
    dncIntent: detectsExplicitDncIntent(scope.message.bodyText)
      || (detectsWrongNumber(scope.message.bodyText) && detectsOptOutWording(scope.message.bodyText)),
    wrongNumberWords: detectsWrongNumber(scope.message.bodyText),
    optOutWords: detectsOptOutWording(scope.message.bodyText),
    routeWrong: Boolean(await wrongRouteForConversation(db, scope.conversation.id)),
    greetingOnly: isBareGreeting(scope.message.bodyText),
    input: {
      ...contextInput,
      instructions: formatAiInstructions(settings[0]?.classificationInstructions),
      policy: {
        autoApplyConfidence: Number(settings[0]?.autoApplyConfidence ?? "0.85"),
        reviewOther: settings[0]?.reviewOther ?? true,
        customerRequiresReview: settings[0]?.customerRequiresReview ?? true,
      },
    },
  };
}

async function recordClassificationFailure(messageId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await withCrmTransaction(async (tx) => {
    const [scope] = await tx.select({ message: crmConversationMessages, record: crmRecords })
      .from(crmConversationMessages)
      .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
      .innerJoin(crmRecords, eq(crmRecords.id, crmConversations.crmRecordId))
      .where(and(inOrg(crmRecords), eq(crmConversationMessages.id, messageId))).limit(1);
    if (!scope || scope.record.latestInboundMessageId !== messageId) return;
    const record = await lockCrmRecord(tx, scope.record.id);
    const [existing] = await tx.select().from(crmClassifications)
      .where(and(eq(crmClassifications.messageId, messageId), eq(crmClassifications.expectedContextVersion, record.contextVersion)))
      .limit(1);
    if (!existing) {
      await tx.insert(crmClassifications).values({
        crmRecordId: record.id,
        messageId,
        expectedContextVersion: record.contextVersion,
        previousCategoryKey: record.categoryKey,
        previousSubcategoryId: record.subcategoryId,
        status: "failed",
        error: message,
      });
    }
    await tx.update(crmRecords).set({ workflowState: "error", nextActionAt: null, updatedAt: new Date() })
      .where(eq(crmRecords.id, record.id));
    await appendCrmEvent(tx, {
      personId: record.personId, crmRecordId: record.id, pipelineId: record.pipelineId,
      eventType: "classification.failed", actorType: "ai", toData: { messageId },
      meta: { error: message }, contextVersion: record.contextVersion,
    });
  });
}

type ClassificationContext = Awaited<ReturnType<typeof classificationContext>>;

/**
 * A retried job whose classification already committed (the worker died
 * after it): the wrong-number handling it left unfinished, if any — this
 * message's apology claimed (reserved) or mid-send (sending), or a clear
 * wrong-number reading whose route was never recorded. Null when nothing
 * was left, and the job is simply stale. "in_flight" when the claim is
 * younger than a worker may hold a job: the job was requeued while its
 * first worker may still be sending (a stale lock, no heartbeat), so the
 * claim is that worker's, never taken over.
 */
async function unfinishedWrongNumber(
  messageId: string,
  expectedContextVersion: number,
  context: ClassificationContext,
): Promise<{ source: "reply_agent" | "classifier"; optOut: boolean } | { inFlightUntil: Date } | null> {
  const [route] = await db.select({ ackStatus: crmWrongRoutes.ackStatus, ackUpdatedAt: crmWrongRoutes.ackUpdatedAt, source: crmWrongRoutes.source }).from(crmWrongRoutes)
    .where(and(inOrg(crmWrongRoutes), eq(crmWrongRoutes.messageId, messageId))).limit(1);
  if (route) {
    if (route.ackStatus !== "reserved" && route.ackStatus !== "sending") return null;
    if (route.ackUpdatedAt && route.ackUpdatedAt.getTime() > Date.now() - STALE_LOCK_MS) return { inFlightUntil: new Date(route.ackUpdatedAt.getTime() + STALE_LOCK_MS) };
    return { source: route.source === "reply_agent" ? "reply_agent" : "classifier", optOut: false };
  }
  if (context.routeWrong) return null;
  const [classification] = await db.select().from(crmClassifications)
    .where(and(
      eq(crmClassifications.crmRecordId, context.recordId),
      eq(crmClassifications.messageId, messageId),
      eq(crmClassifications.expectedContextVersion, expectedContextVersion),
    )).limit(1);
  if (!classification || classification.status === "stale" || classification.status === "failed") return null;
  const subcategoryId = classification.appliedSubcategoryId ?? classification.proposedSubcategoryId;
  // The reply agent files a message as "Wrong Number" only when it closes it.
  const fromAgent = classification.request?.replyAgent === true;
  const closing = subcategoryKeyOf(subcategoryId, context.input.subcategories) === "wrong_number" && (fromAgent || classifiedAsWrongNumber(
    { applied: classification.status === "auto_applied", stale: false },
    subcategoryId,
    context.input.subcategories,
    { confidence: Number(classification.confidence ?? 0), wrongNumberWords: context.wrongNumberWords },
  ));
  return closing ? { source: fromAgent ? "reply_agent" : "classifier", optOut: context.optOutWords || context.dncIntent } : null;
}

/**
 * After the reply agent, so a reply never stays "classifying": answered
 * before anyone got to it (the owner from their phone, say), it settles the
 * way a manual reply settles it. One the agent left without a classification
 * (it stopped on a limit, or another worker holds the message) settles the
 * same when it was answered meanwhile, and otherwise waits for a person in
 * Action required. One the agent classified is left as the agent left it.
 */
async function settleAfterReplyAgent(recordId: string, messageId: string, answered: boolean): Promise<void> {
  await withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, recordId);
    if (record.latestInboundMessageId !== messageId) return;
    const unclassified = record.workflowState === "classifying" || record.workflowState === "unclassified";
    if (!answered && !unclassified) return;
    if (answered || await inboundAnsweredSince(tx, record.id, messageId)) {
      await settleAnsweredRecordInTransaction(tx, record, { reason: "answered_outside_crm", actorType: "system" });
      return;
    }
    const now = new Date();
    await tx.update(crmRecords).set({ workflowState: "action_required", nextActionAt: now, updatedAt: now }).where(eq(crmRecords.id, record.id));
    await appendCrmEvent(tx, {
      personId: record.personId,
      crmRecordId: record.id,
      pipelineId: record.pipelineId,
      eventType: "workflow.state_changed",
      actorType: "system",
      fromData: { workflowState: record.workflowState, nextActionAt: record.nextActionAt },
      toData: { workflowState: "action_required", nextActionAt: now },
      meta: { reason: "reply_agent_left_unclassified" },
      contextVersion: record.contextVersion,
    });
  });
}

export async function handleClassificationJob(
  job: CrmJob,
  dependencies: {
    complete?: ClassificationCompletion;
    /** The reply agent's stand-ins (tests); false skips it. A stand-in classifier alone skips it too. */
    replyAgent?: false | import("@/lib/assistant/replyAgent/agent.server").ReplyAgentDependencies;
  } = {},
): Promise<void> {
  let context: ClassificationContext;
  try {
    context = await classificationContext(job.entityId);
    const agent = dependencies.replyAgent ?? (dependencies.complete ? false : {});
    const sending = wrongNumberSending(agent);
    const { closeWrongNumber } = await import("./wrongNumberAck.server");
    const expected = Number(job.payload.expectedContextVersion ?? context.expectedContextVersion);
    if (expected !== context.expectedContextVersion) {
      // Requeued after its classification committed: finish the wrong-number
      // handling it left (closeWrongNumber picks up where it stopped, never
      // sends twice), else it is stale.
      const unfinished = await unfinishedWrongNumber(job.entityId, expected, context);
      // Possibly still another worker's send: look again once its claim is past the lock window, never fail it for good.
      if (unfinished && "inFlightUntil" in unfinished) throw new RetryCrmJobLaterError("Classification job context is stale; its wrong-number apology is left to the worker that claimed it until its claim is stale", unfinished.inFlightUntil);
      if (!unfinished) throw new PermanentCrmJobError("Classification job context is stale");
      await closeWrongNumber({ messageId: job.entityId, source: unfinished.source, acknowledgement: null, optOut: unfinished.optOut, sendAllowed: sending.sendAllowed }, { send: sending.send });
      return;
    }
    // A lead of a running assistant outreach run is answered by the reply
    // agent in one step (src/lib/assistant/replyAgent/): it reads the
    // message, replies, tells the owner or stops, and records the
    // classification itself. Anything else — and every explicit opt-out —
    // goes through the classifier below, as before. REPLY_AGENT=off turns it off.
    const budget = await replyBudgetForJob(job);
    if (agent && !context.dncIntent && process.env.REPLY_AGENT !== "off") {
      const { runReplyAgent } = await import("@/lib/assistant/replyAgent/agent.server");
      const outcome = await runReplyAgent(job.entityId, { ...agent, budget });
      if (outcome) {
        await settleAfterReplyAgent(context.recordId, job.entityId, Boolean(outcome.answered));
        return;
      }
    }
    const wrongNumberSubcategoryId = context.input.subcategories.find((subcategory) => subcategory.key === "wrong_number")?.id ?? null;
    // A route already recorded as a wrong number takes nothing more: the
    // reply is filed as "Wrong Number" without the model, and no second
    // apology is written (an explicit opt-out still goes the usual way; a
    // bare "Stop" makes it Do Not Contact and withdraws a waiting apology).
    if (context.routeWrong && !context.dncIntent) {
      await withCrmTransaction((tx) => recordAiClassificationInTransaction(tx, {
        recordId: context.recordId,
        messageId: job.entityId,
        expectedContextVersion: context.expectedContextVersion,
        categoryKey: "other",
        subcategoryId: wrongNumberSubcategoryId,
        confidence: 1,
        reasoning: "This number or address was already recorded as a wrong number; outreach to it is stopped.",
        provider: "rules",
        model: "wrong-route",
        request: { wrongRoute: true },
        response: { wrongRoute: true },
      }));
      await closeWrongNumber({ messageId: job.entityId, source: "classifier", acknowledgement: null, optOut: context.optOutWords, sendAllowed: sending.sendAllowed }, { send: sending.send });
      return;
    }
    let result: Awaited<ReturnType<typeof classifyCrmReply>>;
    try {
      result = await classifyCrmReply(context.input, { complete: dependencies.complete, budget });
    } catch (error) {
      // The model is held (Claude Code usage limit): an explicit opt-out is honoured now, not after the reset.
      if (claudeHoldUntil(error) && context.dncIntent) {
        await withCrmTransaction((tx) => setPersonDoNotContactInTransaction(tx, {
          personId: context.personId,
          reason: "Explicit do-not-contact request in inbound message",
          source: "inbound_request",
          actorType: "ai",
          actorRef: "rules",
        }));
      }
      throw error;
    }
    const closeAs = await withCrmTransaction(async (tx): Promise<{ optOut: boolean } | null> => {
      // "Wrong number, stop messaging me" is Do Not Contact, filed as a wrong number rather than a buyer's no.
      const dncWrongNumber = context.dncIntent && context.wrongNumberWords;
      const appliedResult = await recordAiClassificationInTransaction(tx, {
        recordId: context.recordId,
        messageId: job.entityId,
        expectedContextVersion: context.expectedContextVersion,
        // A bare "Hey" is a reply, not interest: the model's "interested" is not applied to the record.
        categoryKey: dncWrongNumber ? "other" : context.dncIntent ? "not_interested" : context.greetingOnly && result.categoryKey === "interested" ? "other" : result.categoryKey,
        subcategoryId: dncWrongNumber ? wrongNumberSubcategoryId : context.dncIntent ? null : context.greetingOnly && result.categoryKey === "interested" ? null : result.subcategoryId,
        confidence: context.dncIntent ? 1 : context.greetingOnly ? Math.min(result.confidence, 0.5) : result.confidence,
        reasoning: context.dncIntent
          ? `Explicit do-not-contact request detected. ${result.reasoning}`
          : context.greetingOnly
            ? `Only a greeting or acknowledgement; it shows a reply, not intent. ${result.reasoning}`
            : result.reasoning,
        provider: result.provider,
        model: result.model,
        request: result.request,
        response: result.response && typeof result.response === "object"
          ? result.response as Record<string, unknown>
          : { value: result.response },
      });
      if (context.dncIntent) {
        await setPersonDoNotContactInTransaction(tx, {
          personId: context.personId,
          reason: "Explicit do-not-contact request in inbound message",
          source: "inbound_request",
          actorType: "ai",
          actorRef: result.model,
        });
      }
      if (
        !context.dncIntent
        && classifiedIntoDoNotContactSubcategory(appliedResult, result.subcategoryId, context.input.subcategories)
      ) {
        await setPersonDoNotContactInTransaction(tx, {
          personId: context.personId,
          reason: "Classified as Do Not Contact",
          source: "inbound_request",
          actorType: "ai",
          actorRef: result.model,
        });
        return null;
      }
      if (appliedResult.stale) return null;
      // Opted out and said "wrong number": the route is recorded too (closeWrongNumber below), nothing sent.
      if (context.dncIntent) return dncWrongNumber ? { optOut: true } : null;
      // A wrong number never gets a sales draft. When the reading is clear,
      // closeWrongNumber (below: outside this transaction, because it may
      // send) records the route and the one apology — none when the message
      // also asks to stop; an unsure one waits for a person in Action required.
      if (subcategoryKeyOf(result.subcategoryId, context.input.subcategories) === "wrong_number") {
        if (classifiedAsWrongNumber(appliedResult, result.subcategoryId, context.input.subcategories, { confidence: result.confidence, wrongNumberWords: context.wrongNumberWords })) {
          return { optOut: context.optOutWords };
        }
        // Unsure, but the rep already answered it: settled as when the answer
        // comes after (manualOutbound.ts), so the order does not matter.
        const unsure = await lockCrmRecord(tx, context.recordId);
        if (await inboundAnsweredSince(tx, unsure.id, job.entityId)) {
          await settleAnsweredRecordInTransaction(tx, unsure, { reason: "answered_outside_crm", actorType: "system" });
        }
        return null;
      }
      const current = await lockCrmRecord(tx, context.recordId);
      // The rep answered while this ran — e.g. straight from their phone on
      // WhatsApp (manualOutbound.ts): keep the classification, skip the draft.
      // Checked first, so a classification left proposed settles the same
      // whether the answer arrived before or after it.
      if (await inboundAnsweredSince(tx, current.id, job.entityId)) {
        await settleAnsweredRecordInTransaction(tx, current, {
          reason: "answered_outside_crm",
          actorType: "system",
        });
        return null;
      }
      // A classification left for a person to confirm (unsure, "other", a
      // customer) waits in Action required. A lead of the owner's assistant
      // outreach still gets a draft: the reply autopilot reads the message
      // itself and answers it, holds it, or hands it to the owner
      // (src/lib/assistant/autopilotRun.server.ts), so a reply such as "Hey"
      // is never left without an answer and without anyone being told.
      const assistantLead = !appliedResult.applied
        && (await runMembershipFor(tx, context.personId, context.channel, context.conversationId))?.leadStatus === "active";
      if (!appliedResult.applied && !assistantLead) return null;
      // Sequences follow an applied category; an unconfirmed one drafts from the thread.
      const started = appliedResult.applied ? await startSequenceRunInTransaction(tx, {
        recordId: current.id,
        conversationId: context.conversationId,
        triggerMessageId: job.entityId,
        expectedContextVersion: current.contextVersion,
        actorType: "ai",
      }) : null;
      // Every applied reply gets a draft. An assigned sequence supplies the
      // brief; without one the fallback drafts from the conversation itself,
      // so a reply the taxonomy has no playbook for still reaches a human
      // with something to send instead of stalling silently.
      const firstStep = started?.stepRuns[0];
      await enqueueCrmJobInTransaction(tx, {
        kind: "initial_draft",
        entityId: appliedResult.classification.id,
        payload: firstStep ? { stepRunId: firstStep.id } : { recordId: current.id },
      });
      return null;
    });
    if (closeAs) {
      await closeWrongNumber({
        messageId: job.entityId,
        source: "classifier",
        acknowledgement: null,
        optOut: closeAs.optOut,
        reasoning: result.reasoning,
        sendAllowed: sending.sendAllowed,
        provider: result.provider,
        model: result.model,
      }, { send: sending.send });
    }
  } catch (error) {
    // The organization's Claude Code login is held by a usage limit: sort the reply again later. It is looked at
    // again every 15 minutes at most (the engine may have been switched to an API provider meanwhile) and given
    // up as a visible failure once the message has waited longer than any usage window.
    const heldUntil = claudeHoldUntil(error);
    if (heldUntil && Date.now() - job.createdAt.getTime() < HELD_CLASSIFICATION_MAX_WAIT_MS) {
      const retryAt = new Date(Math.min(heldUntil.getTime(), Date.now() + HELD_CLASSIFICATION_RECHECK_MS));
      throw new RetryCrmJobLaterError(`${error instanceof Error ? error.message : String(error)} Reply sorting is tried again after it resets.`, retryAt);
    }
    // Put back to wait for another worker's claim is not a failed classification: the record stays as it is.
    if (!(error instanceof PermanentCrmJobError) && !(error instanceof RetryCrmJobLaterError)) await recordClassificationFailure(job.entityId, error);
    throw error;
  }
}

export async function handleInitialDraftJob(job: CrmJob): Promise<void> {
  const budget = await replyBudgetForJob(job);
  const stepRunId = typeof job.payload.stepRunId === "string" ? job.payload.stepRunId : null;
  if (stepRunId) {
    await generateDraftForStep(stepRunId, { budget });
    return;
  }
  const [scope] = await db.select({ stepRunId: crmSequenceStepRuns.id })
    .from(crmClassifications)
    .innerJoin(crmSequenceRuns, eq(crmSequenceRuns.crmRecordId, crmClassifications.crmRecordId))
    .innerJoin(crmSequenceStepRuns, eq(crmSequenceStepRuns.sequenceRunId, crmSequenceRuns.id))
    .innerJoin(crmSequenceSteps, eq(crmSequenceSteps.id, crmSequenceStepRuns.sequenceStepId))
    .where(and(inOrg(crmSequenceRuns), eq(crmClassifications.id, job.entityId), eq(crmSequenceRuns.status, "active")))
    .orderBy(asc(crmSequenceSteps.position)).limit(1);
  if (scope) {
    await generateDraftForStep(scope.stepRunId, { budget });
    return;
  }
  // No sequence covers this classification — draft from the thread instead.
  const payloadRecordId = typeof job.payload.recordId === "string" ? job.payload.recordId : null;
  const recordId = payloadRecordId ?? (await db
    .select({ id: crmClassifications.crmRecordId })
    .from(crmClassifications)
    .innerJoin(crmRecords, eq(crmRecords.id, crmClassifications.crmRecordId))
    .where(and(inOrg(crmRecords), eq(crmClassifications.id, job.entityId)))
    .limit(1))[0]?.id ?? null;
  if (!recordId) throw new PermanentCrmJobError("Initial draft record was not found");
  // Answered by hand after the classification applied (manualOutbound.ts
  // interrupted the run, which is why no step was found): nothing to draft.
  const [record] = await db.select({ latestInboundMessageId: crmRecords.latestInboundMessageId })
    .from(crmRecords).where(and(inOrg(crmRecords), eq(crmRecords.id, recordId))).limit(1);
  if (record?.latestInboundMessageId && await inboundAnsweredSince(db, recordId, record.latestInboundMessageId)) return;
  await generateFallbackDraft(recordId, { budget });
}

export async function handleDueFollowupDraftJob(job: CrmJob): Promise<void> {
  const [scope] = await db.select({ dueAt: crmSequenceStepRuns.dueAt, status: crmSequenceStepRuns.status })
    .from(crmSequenceStepRuns)
    .innerJoin(crmSequenceRuns, eq(crmSequenceRuns.id, crmSequenceStepRuns.sequenceRunId))
    .where(and(inOrg(crmSequenceRuns), eq(crmSequenceStepRuns.id, job.entityId))).limit(1);
  if (!scope) throw new PermanentCrmJobError("Due CRM sequence step was not found");
  if (scope.status !== "scheduled") return;
  if (scope.dueAt > new Date()) throw new CrmConflictError("Follow-up sequence step is not due yet");
  const budget = await replyBudgetForJob(job);
  await generateDraftForStep(job.entityId, { budget });
}

let registered = false;

export function registerDefaultCrmJobHandlers(): void {
  if (registered) return;
  registered = true;
  registerCrmJobHandlers({
    classification: handleClassificationJob,
    initialDraft: handleInitialDraftJob,
    dueFollowupDraft: handleDueFollowupDraftJob,
    autoSend: handleAutoSendJob,
  });
}
