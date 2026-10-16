import { and, asc, eq } from "drizzle-orm";
import { handleAutoSendJob, runMembershipFor } from "./autopilot.server";
import { messageParticipants } from "./participants";
import { formatAiInstructions } from "./ai/instructions";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { classifyCrmReply } from "./ai/classify";
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
  type CrmCategoryKey,
} from "./schema";
import { startSequenceRunInTransaction } from "./sequences";
import { PermanentCrmJobError, registerCrmJobHandlers } from "./worker";
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
  dncIntent: boolean;
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
    dncIntent: detectsExplicitDncIntent(scope.message.bodyText),
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

export async function handleClassificationJob(
  job: CrmJob,
  dependencies: { complete?: ClassificationCompletion } = {},
): Promise<void> {
  let context: Awaited<ReturnType<typeof classificationContext>>;
  try {
    context = await classificationContext(job.entityId);
    const expected = Number(job.payload.expectedContextVersion ?? context.expectedContextVersion);
    if (expected !== context.expectedContextVersion) {
      throw new PermanentCrmJobError("Classification job context is stale");
    }
    const result = await classifyCrmReply(context.input, dependencies);
    await withCrmTransaction(async (tx) => {
      const appliedResult = await recordAiClassificationInTransaction(tx, {
        recordId: context.recordId,
        messageId: job.entityId,
        expectedContextVersion: context.expectedContextVersion,
        categoryKey: context.dncIntent ? "not_interested" : result.categoryKey,
        subcategoryId: context.dncIntent ? null : result.subcategoryId,
        confidence: context.dncIntent ? 1 : result.confidence,
        reasoning: context.dncIntent
          ? `Explicit do-not-contact request detected. ${result.reasoning}`
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
        return;
      }
      if (appliedResult.stale || context.dncIntent) return;
      // A classification left for a person to confirm (unsure, "other", a
      // customer) waits in Action required. A lead of the owner's assistant
      // outreach still gets a draft: the reply autopilot reads the message
      // itself and answers it, holds it, or hands it to the owner
      // (src/lib/assistant/autopilotRun.server.ts), so a reply such as "Hey"
      // is never left without an answer and without anyone being told.
      const assistantLead = !appliedResult.applied
        && (await runMembershipFor(tx, context.personId, context.channel, context.conversationId))?.leadStatus === "active";
      if (!appliedResult.applied && !assistantLead) return;
      const current = await lockCrmRecord(tx, context.recordId);
      // The rep answered while this ran — e.g. straight from their phone on
      // WhatsApp (manualOutbound.ts): keep the classification, skip the draft.
      if (await inboundAnsweredSince(tx, current.id, job.entityId)) {
        await settleAnsweredRecordInTransaction(tx, current, {
          reason: "answered_outside_crm",
          actorType: "system",
        });
        return;
      }
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
    });
  } catch (error) {
    if (!(error instanceof PermanentCrmJobError)) await recordClassificationFailure(job.entityId, error);
    throw error;
  }
}

export async function handleInitialDraftJob(job: CrmJob): Promise<void> {
  const stepRunId = typeof job.payload.stepRunId === "string" ? job.payload.stepRunId : null;
  if (stepRunId) {
    await generateDraftForStep(stepRunId);
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
    await generateDraftForStep(scope.stepRunId);
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
  await generateFallbackDraft(recordId);
}

export async function handleDueFollowupDraftJob(job: CrmJob): Promise<void> {
  const [scope] = await db.select({ dueAt: crmSequenceStepRuns.dueAt, status: crmSequenceStepRuns.status })
    .from(crmSequenceStepRuns)
    .innerJoin(crmSequenceRuns, eq(crmSequenceRuns.id, crmSequenceStepRuns.sequenceRunId))
    .where(and(inOrg(crmSequenceRuns), eq(crmSequenceStepRuns.id, job.entityId))).limit(1);
  if (!scope) throw new PermanentCrmJobError("Due CRM sequence step was not found");
  if (scope.status !== "scheduled") return;
  if (scope.dueAt > new Date()) throw new CrmConflictError("Follow-up sequence step is not due yet");
  await generateDraftForStep(job.entityId);
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
