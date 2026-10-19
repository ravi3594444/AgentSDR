import "server-only";

import { formatAiInstructions } from "@/lib/crm/ai/instructions";
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { classifyCrmReply } from "@/lib/crm/ai/classify";
import type { CrmClassificationResult } from "@/lib/crm/ai/types";
import type { CrmEventActor } from "@/lib/crm/events";
import { setPersonDoNotContactInTransaction } from "@/lib/crm/policies";
import {
  getCrmRecord,
  getOrCreateCrmRecordForCall,
  lockCrmRecord,
  resolvePipelineId,
  setRecordClassificationInTransaction,
  transitionWorkflowInTransaction,
  type CrmRecord,
} from "@/lib/crm/records";
import {
  CrmConflictError,
  CrmNotFoundError,
  type CrmExecutor,
  type CrmTransaction,
  withCrmTransaction,
} from "@/lib/crm/repository";
import { moveRecordStageInTransaction } from "@/lib/crm/operations";
import {
  crmCategories,
  crmClassifications,
  crmDrafts,
  crmEvents,
  crmKnowledgeDocumentVersions,
  crmKnowledgeDocuments,
  crmPipelines,
  crmRecords,
  crmSettings,
  crmSubcategories,
  type CrmCategoryKey,
} from "@/lib/crm/schema";
import { interruptActiveSequenceRunInTransaction } from "@/lib/crm/sequences";
import { setAsideAcknowledgementsInTransaction } from "@/lib/crm/wrongRoutes";
import { StaleCrmContextError, classificationApplicationDecision } from "@/lib/crm/stateMachine";
import type { CampaignContactCrm, SetLeadStageRequest } from "./contract";
import {
  DO_NOT_CONTACT_SUBCATEGORY_KEY,
  buildCallClassificationInput,
  followUpFromSuggestion,
  humanStageSetSinceCall,
  isLeadStageCategory,
  leadStageTargetError,
  pickRepresentativeRecord,
} from "./leadStageRules";
import { callCampaignContacts, callCampaigns, callSessions } from "./schema";
import { contactInOrg } from "./campaigns";
import { inOrg } from "@/lib/tenancy/scope";
import { syncCallFollowUpSafely } from "./crmFollowUp";
import { CallApiError } from "./sessions";

/**
 * A Calling lead's *status*: their CRM stage (crm_records category +
 * subcategory), the same one email and LinkedIn leads carry. It is set two
 * ways — by a rep (setLeadStage), or from a recorded call's transcript
 * (classifyCallTranscript, after transcription.ts saves one).
 *
 * Calls never start or enroll sequences: sequences need a conversation, and
 * conversations are email/LinkedIn only. A stage change does interrupt a
 * running sequence, since that sequence belonged to the old stage.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HUMAN_ACTORS: CrmEventActor[] = ["human", "authenticated_operator"];
/** Events by which a person sets a stage (records.ts, operations.ts). */
const STAGE_EVENTS = ["classification.changed", "stage.moved", "classification.undone"];

// --- reading -------------------------------------------------------------

/**
 * Each person's CRM stage, keyed by person id, in one query. A person with
 * records in several pipelines is shown by one (pickRepresentativeRecord).
 */
export async function crmStageForPeople(personIds: string[]): Promise<Map<string, CampaignContactCrm>> {
  const ids = [...new Set(personIds)];
  if (!ids.length) return new Map();
  const rows = await db
    .select({
      recordId: crmRecords.id,
      personId: crmRecords.personId,
      categoryKey: crmRecords.categoryKey,
      subcategoryId: crmRecords.subcategoryId,
      subcategoryName: crmSubcategories.name,
      categorySource: crmRecords.categorySource,
      updatedAt: crmRecords.updatedAt,
      isDefaultPipeline: crmPipelines.isDefault,
    })
    .from(crmRecords)
    .innerJoin(crmPipelines, eq(crmPipelines.id, crmRecords.pipelineId))
    .leftJoin(crmSubcategories, eq(crmSubcategories.id, crmRecords.subcategoryId))
    .where(and(inOrg(crmRecords), inArray(crmRecords.personId, ids)));

  const byPerson = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) byPerson.set(row.personId, [...(byPerson.get(row.personId) ?? []), row]);

  const result = new Map<string, CampaignContactCrm>();
  for (const [personId, records] of byPerson) {
    const row = pickRepresentativeRecord(records);
    if (!row) continue;
    result.set(personId, {
      recordId: row.recordId,
      categoryKey: isLeadStageCategory(row.categoryKey) ? row.categoryKey : null,
      subcategoryId: row.subcategoryId,
      subcategoryName: row.subcategoryName ?? null,
      categorySource: row.categorySource ?? null,
    });
  }
  return result;
}

/** The id of the record Calling reads and writes for a person; null when they have none. */
async function representativeRecordId(executor: CrmExecutor, personId: string): Promise<string | null> {
  const records = await executor
    .select({ id: crmRecords.id, updatedAt: crmRecords.updatedAt, isDefaultPipeline: crmPipelines.isDefault })
    .from(crmRecords)
    .innerJoin(crmPipelines, eq(crmPipelines.id, crmRecords.pipelineId))
    .where(and(inOrg(crmRecords), eq(crmRecords.personId, personId)));
  return pickRepresentativeRecord(records)?.id ?? null;
}

export async function lockRepresentativeRecord(tx: CrmTransaction, personId: string): Promise<CrmRecord | null> {
  const id = await representativeRecordId(tx, personId);
  return id ? lockCrmRecord(tx, id) : null;
}

export async function lockOrCreateRecord(
  tx: CrmTransaction,
  personId: string,
  actor: { actorType: CrmEventActor; actorRef?: string | null },
): Promise<CrmRecord> {
  const existing = await lockRepresentativeRecord(tx, personId);
  if (existing) return existing;
  const { record } = await getOrCreateCrmRecordForCall(tx, { personId, cause: "first_call", ...actor });
  return lockCrmRecord(tx, record.id);
}

/** moveRecordStage needs the AI's reading of the latest reply to hang the move off. */
async function latestReplyIsClassified(tx: CrmTransaction, record: CrmRecord): Promise<boolean> {
  if (!record.latestInboundMessageId) return false;
  const [classification] = await tx
    .select({ id: crmClassifications.id })
    .from(crmClassifications)
    .where(and(eq(crmClassifications.crmRecordId, record.id), eq(crmClassifications.messageId, record.latestInboundMessageId)))
    .limit(1);
  return Boolean(classification);
}

async function lastHumanStageAt(executor: CrmExecutor, recordId: string): Promise<Date | null> {
  const [event] = await executor
    .select({ createdAt: crmEvents.createdAt })
    .from(crmEvents)
    .where(and(
      inOrg(crmEvents),
      eq(crmEvents.crmRecordId, recordId),
      inArray(crmEvents.eventType, STAGE_EVENTS),
      inArray(crmEvents.actorType, HUMAN_ACTORS),
    ))
    .orderBy(desc(crmEvents.createdAt))
    .limit(1);
  return event?.createdAt ?? null;
}

// --- writing ---------------------------------------------------------------

/**
 * Sets the record's stage and leaves it idle. setRecordClassification is the
 * one CRM write that needs no inbound message (moveRecordStage and
 * applyHumanClassification both require one), and it always leaves the record
 * action_required; nothing in a call puts work on anyone's desk, so it goes
 * back to idle. A "Do Not Contact" stage also sets the person's global policy.
 */
async function applyStageInTransaction(
  tx: CrmTransaction,
  record: CrmRecord,
  input: {
    categoryKey: CrmCategoryKey;
    subcategoryId: string | null;
    doNotContact: boolean;
    source: "human" | "integration";
    actorType: "integration" | "authenticated_operator";
    actorRef?: string | null;
    reason: string;
    doNotContactReason: string;
    eventMeta: Record<string, unknown>;
  },
): Promise<void> {
  const changed = record.categoryKey !== input.categoryKey || record.subcategoryId !== input.subcategoryId;
  const updated = await setRecordClassificationInTransaction(tx, {
    recordId: record.id,
    categoryKey: input.categoryKey,
    subcategoryId: input.subcategoryId,
    source: input.source,
    actorType: input.actorType,
    actorRef: input.actorRef,
    expectedContextVersion: record.contextVersion,
    reason: input.reason,
    eventMeta: input.eventMeta,
  });

  // The context moved on, so open drafts were written for a brief that no
  // longer applies (as operations.ts restartRecordWork does); a changed stage
  // also ends the old stage's sequence. Nothing new is started.
  const staled = await tx.update(crmDrafts).set({ status: "stale", updatedAt: new Date() }).where(and(
    eq(crmDrafts.crmRecordId, updated.id),
    inArray(crmDrafts.status, ["generating", "awaiting_review", "failed"]),
    ne(crmDrafts.expectedContextVersion, updated.contextVersion),
  )).returning({ id: crmDrafts.id });
  await setAsideAcknowledgementsInTransaction(tx, { draftIds: staled.map((draft) => draft.id), reason: "the lead's stage was set from a call" });
  if (changed) {
    await interruptActiveSequenceRunInTransaction(tx, {
      recordId: updated.id,
      reason: "stage_set_from_call",
      contextVersion: updated.contextVersion,
    });
  }

  if (input.doNotContact) {
    await setPersonDoNotContactInTransaction(tx, {
      personId: updated.personId,
      reason: input.doNotContactReason,
      source: input.source,
      actorType: input.actorType,
      actorRef: input.actorRef,
    });
  }

  await transitionWorkflowInTransaction(tx, {
    recordId: updated.id,
    to: "idle",
    actorType: input.actorType,
    actorRef: input.actorRef,
    reason: "Stage set from Calling",
  });
}

/**
 * PATCH /api/calling/contacts/:id/stage. A rep sets the lead's CRM stage by
 * hand, creating their CRM record if they have none.
 */
export async function setLeadStage(contactId: string, input: SetLeadStageRequest): Promise<void> {
  if (!UUID_PATTERN.test(contactId)) throw new CallApiError(404, "Contact not found");
  if (!isLeadStageCategory(input.categoryKey)) {
    throw new CallApiError(400, "categoryKey must be one of: interested, customer, not_interested, other");
  }
  if (input.subcategoryId !== null && !UUID_PATTERN.test(input.subcategoryId)) {
    throw new CallApiError(400, "That stage does not exist");
  }
  const [contact] = await db
    .select({ personId: callCampaignContacts.personId })
    .from(callCampaignContacts)
    .where(and(contactInOrg(), eq(callCampaignContacts.id, contactId)))
    .limit(1);
  if (!contact) throw new CallApiError(404, "Contact not found");

  try {
    await withCrmTransaction(async (tx) => {
      const actor = { actorType: "authenticated_operator" as const };
      const record = await lockOrCreateRecord(tx, contact.personId, actor);
      const [subcategory] = input.subcategoryId
        ? await tx.select().from(crmSubcategories).where(eq(crmSubcategories.id, input.subcategoryId)).limit(1)
        : [];
      const error = leadStageTargetError({
        categoryKey: input.categoryKey,
        subcategoryId: input.subcategoryId,
        subcategory: subcategory ?? null,
        pipelineId: record.pipelineId,
      });
      if (error) throw new CallApiError(400, error);
      if (record.categoryKey === input.categoryKey && record.subcategoryId === input.subcategoryId) return;
      const doNotContact = subcategory?.key === DO_NOT_CONTACT_SUBCATEGORY_KEY;

      // A lead who has also replied by email or LinkedIn moves the way the
      // CRM moves them itself: the new stage's sequence starts on that
      // thread. Do Not Contact is set first so none does.
      if (record.latestInboundMessageId && (await latestReplyIsClassified(tx, record))) {
        if (doNotContact) {
          await setPersonDoNotContactInTransaction(tx, {
            personId: record.personId,
            reason: "Marked do not contact from Calling",
            source: "human",
            actorType: "authenticated_operator",
          });
        }
        await moveRecordStageInTransaction(tx, {
          recordId: record.id,
          categoryKey: input.categoryKey,
          subcategoryId: input.subcategoryId,
          expectedContextVersion: record.contextVersion,
          note: "Set from Calling",
          next: "follow_up",
        });
        return;
      }

      await applyStageInTransaction(tx, record, {
        categoryKey: input.categoryKey,
        subcategoryId: input.subcategoryId,
        doNotContact,
        source: "human",
        ...actor,
        reason: "Stage set from Calling",
        doNotContactReason: "Marked do not contact from Calling",
        eventMeta: { via: "calling", campaignContactId: contactId },
      });
    });
  } catch (error) {
    if (error instanceof CallApiError) throw error;
    if (error instanceof CrmNotFoundError) throw new CallApiError(404, error.message);
    if (error instanceof CrmConflictError || error instanceof StaleCrmContextError) {
      throw new CallApiError(409, error.message);
    }
    throw error;
  }
  await syncCallFollowUpSafely(contact.personId);
}

// --- from a call's transcript ---------------------------------------------

/**
 * Reads a recorded, transcribed campaign call with the CRM's reply
 * classifier — the transcript standing in for the lead's reply — and, only
 * when the CRM's own policy would auto-apply that reading, sets the lead's
 * stage (source "integration"). A stage a person set since the call began is
 * left alone. A callback the call agreed on becomes the contact's follow-up
 * date when they have none. The call is linked to the lead's CRM record.
 *
 * Never throws: it runs after transcription, fire-and-forget, and a missing
 * model or any other failure must not touch the call. Failures are logged.
 */
export async function classifyCallTranscript(callId: string): Promise<void> {
  try {
    await classifyCallTranscriptUnsafe(callId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An unconfigured model (AI Settings) is the expected state for many
    // deployments; say so quietly rather than as an error.
    if (/AI Settings/.test(message)) {
      console.info(`Call ${callId}: stage not classified — ${message}`);
    } else {
      console.error(`Call ${callId}: classifying the transcript failed`, error);
    }
  }
  // The reading may have set a stage (creating the record) or a follow-up
  // date; either way Action required should now reflect the call.
  const [call] = await db.select({ personId: callSessions.personId }).from(callSessions).where(and(inOrg(callSessions), eq(callSessions.id, callId))).limit(1);
  if (call) await syncCallFollowUpSafely(call.personId);
}

async function classifyCallTranscriptUnsafe(callId: string): Promise<void> {
  const [row] = await db
    .select({ call: callSessions, contact: callCampaignContacts, campaign: callCampaigns, person: people, company: companies })
    .from(callSessions)
    .innerJoin(callCampaignContacts, eq(callCampaignContacts.id, callSessions.campaignContactId))
    .innerJoin(callCampaigns, eq(callCampaigns.id, callCampaignContacts.campaignId))
    .innerJoin(people, eq(people.id, callSessions.personId))
    .leftJoin(companies, eq(companies.id, people.companyId))
    .where(and(inOrg(callSessions), inOrg(callCampaigns), inOrg(people), eq(callSessions.id, callId)))
    .limit(1);
  if (!row) return; // Not a campaign call.
  const { call, contact, campaign, person, company } = row;
  if (call.status !== "recorded" || call.transcriptStatus !== "done" || !call.transcript) return;
  if (!call.transcript.utterances.length) return;
  const callStartedAt = call.startedAt ?? call.createdAt;

  // An unlocked snapshot for the prompt; applyTranscriptStage re-checks under lock.
  const snapshotId = await representativeRecordId(db, person.id);
  const snapshot = snapshotId ? await getCrmRecord(db, snapshotId) : null;
  const current = { record: snapshot, lastHumanAt: snapshot ? await lastHumanStageAt(db, snapshot.id) : null };
  if (current.record && humanStageSetSinceCall({
    categorySource: current.record.categorySource,
    lastHumanStageAt: current.lastHumanAt,
    callStartedAt,
  })) {
    await linkCallToRecord(callId, current.record.id);
    return;
  }

  const pipelineId = current.record?.pipelineId ?? await resolvePipelineId(db, undefined);
  const [categories, subcategories, settings, knowledge] = await Promise.all([
    db.select().from(crmCategories).orderBy(asc(crmCategories.sortOrder)),
    db.select().from(crmSubcategories)
      .where(and(eq(crmSubcategories.pipelineId, pipelineId), eq(crmSubcategories.active, true)))
      .orderBy(asc(crmSubcategories.sortOrder)),
    db.select().from(crmSettings).where(eq(crmSettings.pipelineId, pipelineId)).limit(1),
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
  ]);
  const currentSubcategory = current.record?.subcategoryId
    ? subcategories.find((item) => item.id === current.record?.subcategoryId) ?? null
    : null;
  const policy = {
    autoApplyConfidence: Number(settings[0]?.autoApplyConfidence ?? "0.85"),
    reviewOther: settings[0]?.reviewOther ?? true,
    customerRequiresReview: settings[0]?.customerRequiresReview ?? true,
  };

  const result = await classifyCrmReply(buildCallClassificationInput({
    callId,
    occurredAt: call.endedAt ?? callStartedAt,
    transcript: call.transcript,
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
    },
    company: company ? { id: company.id, name: company.name, domain: company.domain, linkedinUrl: company.linkedinUrl } : null,
    currentClassification: {
      categoryKey: (current.record?.categoryKey ?? null) as CrmCategoryKey | null,
      subcategoryKey: currentSubcategory?.key ?? null,
      categorySource: current.record?.categorySource ?? null,
      categoryLocked: current.record?.categoryLocked ?? false,
      stageRank: currentSubcategory?.stageRank ?? null,
    },
    campaign: { id: campaign.id, name: campaign.name, description: campaign.description },
    knowledge,
    policy,
    instructions: formatAiInstructions(settings[0]?.classificationInstructions),
  }));

  const followUpAt = followUpFromSuggestion(result.suggestedNextActionAt, contact.followUpAt, new Date());
  if (followUpAt) {
    // Only while it is still unset: a rep may have set one meanwhile.
    await db
      .update(callCampaignContacts)
      .set({ followUpAt, updatedAt: new Date() })
      .where(and(contactInOrg(), eq(callCampaignContacts.id, contact.id), isNull(callCampaignContacts.followUpAt)));
  }

  if (result.decision !== "auto_apply" || !result.applicationTarget) {
    if (current.record) await linkCallToRecord(callId, current.record.id);
    return;
  }

  const recordId = await applyTranscriptStage({ personId: person.id, callId, callStartedAt, result, policy });
  if (recordId) await linkCallToRecord(callId, recordId);
}

/**
 * Applies an auto-apply reading under the record lock, re-deciding against
 * the record as it is now: a person may have set the stage, or another call
 * moved it, while the model was thinking. Returns the record the call belongs
 * to, or null when there is none.
 */
async function applyTranscriptStage(input: {
  personId: string;
  callId: string;
  callStartedAt: Date;
  result: CrmClassificationResult;
  policy: { autoApplyConfidence: number; reviewOther: boolean; customerRequiresReview: boolean };
}): Promise<string | null> {
  const { result } = input;
  const target = result.applicationTarget;
  if (!target) return null;
  return withCrmTransaction(async (tx) => {
    const actor = { actorType: "integration" as const, actorRef: result.model };
    const record = await lockOrCreateRecord(tx, input.personId, actor);
    if (humanStageSetSinceCall({
      categorySource: record.categorySource,
      lastHumanStageAt: await lastHumanStageAt(tx, record.id),
      callStartedAt: input.callStartedAt,
    })) {
      return record.id;
    }
    // A lead with an email or LinkedIn thread has a sequence running on it
    // for their current stage; moving them re-plans that thread, which the
    // CRM only does as a person's move. The rep sets it from the picker.
    if (record.latestInboundMessageId) return record.id;

    const [proposed, currentSubcategory] = await Promise.all([
      target.subcategoryId
        ? tx.select().from(crmSubcategories).where(eq(crmSubcategories.id, target.subcategoryId)).limit(1)
        : Promise.resolve([]),
      record.subcategoryId
        ? tx.select().from(crmSubcategories).where(eq(crmSubcategories.id, record.subcategoryId)).limit(1)
        : Promise.resolve([]),
    ]);
    const subcategory = proposed[0] ?? null;
    if (target.subcategoryId && (!subcategory || subcategory.pipelineId !== record.pipelineId || !subcategory.active)) {
      return record.id;
    }
    const decision = classificationApplicationDecision({
      currentCategoryKey: record.categoryKey as CrmCategoryKey | null,
      currentCategoryLocked: record.categoryLocked,
      proposedCategoryKey: target.categoryKey,
      confidence: result.confidence,
      autoApplyConfidence: input.policy.autoApplyConfidence,
      reviewOther: input.policy.reviewOther,
      customerRequiresReview: input.policy.customerRequiresReview,
      subcategoryReviewRequired: subcategory?.reviewRequired ?? false,
      currentStageRank: currentSubcategory[0]?.stageRank ?? null,
      proposedStageRank: subcategory?.stageRank ?? null,
      proposedSubcategoryKey: subcategory?.key ?? null,
    });
    if (decision !== "auto_apply") return record.id;
    if (record.categoryKey === target.categoryKey && record.subcategoryId === target.subcategoryId) {
      return record.id; // Already there; nothing to record.
    }

    await applyStageInTransaction(tx, record, {
      categoryKey: target.categoryKey,
      subcategoryId: target.subcategoryId,
      doNotContact: subcategory?.key === DO_NOT_CONTACT_SUBCATEGORY_KEY,
      source: "integration",
      ...actor,
      reason: result.reasoning,
      doNotContactReason: "Classified as Do Not Contact from a call transcript",
      eventMeta: { via: "call_transcript", callId: input.callId, confidence: result.confidence },
    });
    return record.id;
  });
}

/** Stamps the call's CRM record, unless it was placed from one already. */
async function linkCallToRecord(callId: string, recordId: string): Promise<void> {
  await db
    .update(callSessions)
    .set({ crmRecordId: recordId, updatedAt: new Date() })
    .where(and(inOrg(callSessions), eq(callSessions.id, callId), isNull(callSessions.crmRecordId)));
}
