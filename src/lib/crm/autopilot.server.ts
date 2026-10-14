import "server-only";

import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { people } from "@/lib/leads/schema";
import { isSuppressed } from "@/lib/outreach/suppression";
import { inOrg } from "@/lib/tenancy/scope";
import { AUTOPILOT_ACTOR, AUTOPILOT_LIMITS, autopilotDecision, autopilotIdempotencyKey } from "./autopilot";
import { ensureCrmDefaults } from "./defaults";
import { appendCrmEvent } from "./events";
import { isPersonDoNotContact } from "./policies";
import { enqueueCrmJobInTransaction, type CrmJob } from "./queue";
import { draftInOrg } from "./records";
import { withCrmTransaction, type CrmExecutor, type CrmTransaction } from "./repository";
import {
  crmClassifications,
  crmConversations,
  crmDrafts,
  crmPipelines,
  crmRecords,
  crmSendAttempts,
  crmSettings,
  crmSubcategories,
} from "./schema";
import { sendDraft, type CrmSendAdapter } from "./send";
import { PermanentCrmJobError } from "./worker";

/**
 * Applies the reply autopilot (rules in autopilot.ts). The switch is
 * crm_settings.human_send_only, per pipeline; the owner turns it on for the
 * organization (all its pipelines) from the assistant. When a draft is
 * ready and the switch is on, an auto_send job is queued; the job re-checks
 * every rule at send time and sends through sendDraft, the same path a
 * person's Approve & send takes (idempotent, DNC checked twice, failures
 * recorded). A draft it holds back stays in Action required, with the
 * reason recorded as an event.
 */

export async function setAutopilot(enabled: boolean): Promise<void> {
  await ensureCrmDefaults();
  await db.update(crmSettings)
    .set({ humanSendOnly: !enabled, updatedAt: new Date() })
    .where(inArray(crmSettings.pipelineId, db.select({ id: crmPipelines.id }).from(crmPipelines).where(inOrg(crmPipelines))));
}

export async function isAutopilotOn(): Promise<boolean> {
  const [row] = await db.select({ humanSendOnly: crmSettings.humanSendOnly })
    .from(crmSettings)
    .innerJoin(crmPipelines, eq(crmPipelines.id, crmSettings.pipelineId))
    .where(and(inOrg(crmPipelines), eq(crmPipelines.isDefault, true)))
    .limit(1);
  return row ? !row.humanSendOnly : false;
}

async function enabledForPipeline(executor: CrmExecutor, pipelineId: string): Promise<boolean> {
  const [row] = await executor.select({ humanSendOnly: crmSettings.humanSendOnly }).from(crmSettings)
    .where(eq(crmSettings.pipelineId, pipelineId)).limit(1);
  return row ? !row.humanSendOnly : false;
}

/** Queues the autopilot's look at a draft that just became ready, when the switch is on. */
export async function enqueueAutopilotInTransaction(tx: CrmTransaction, input: { draftId: string; pipelineId: string; revision: number }): Promise<void> {
  if (!(await enabledForPipeline(tx, input.pipelineId))) return;
  await enqueueCrmJobInTransaction(tx, {
    kind: "auto_send",
    entityId: input.draftId,
    payload: { revision: input.revision },
    // A regenerated draft keeps its id: run the job again for the new revision.
    requeueCompleted: true,
    maxAttempts: 3,
    runAfter: new Date(Date.now() + AUTOPILOT_LIMITS.delayMinutes * 60_000),
  });
}

function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function autopilotSends(where: { conversationId?: string; since?: Date }): Promise<number> {
  const [row] = await db.select({ n: count() })
    .from(crmSendAttempts)
    .innerJoin(crmDrafts, eq(crmDrafts.id, crmSendAttempts.draftId))
    .where(and(
      draftInOrg(),
      like(crmSendAttempts.idempotencyKey, `${AUTOPILOT_ACTOR}:%`),
      inArray(crmSendAttempts.status, ["sending", "sent", "reconciled", "delivery_uncertain"]),
      ...(where.conversationId ? [eq(crmDrafts.conversationId, where.conversationId)] : []),
      ...(where.since ? [gte(crmSendAttempts.createdAt, where.since)] : []),
    ));
  return Number(row?.n ?? 0);
}

export type AutopilotOutcome = { sent: boolean; reason: string | null };

/**
 * The auto_send job. Outside production it sends nothing unless
 * AUTOPILOT_ALLOW_NON_PRODUCTION=true, like the outreach engines: a
 * development server must never answer real leads.
 */
export async function runAutopilotForDraft(draftId: string, dependencies: { send?: CrmSendAdapter; allowNonProduction?: boolean } = {}): Promise<AutopilotOutcome> {
  const [draft] = await db.select().from(crmDrafts).where(and(draftInOrg(), eq(crmDrafts.id, draftId))).limit(1);
  if (!draft) throw new PermanentCrmJobError(`Draft ${draftId} not found`);
  const [record] = await db.select().from(crmRecords).where(and(inOrg(crmRecords), eq(crmRecords.id, draft.crmRecordId))).limit(1);
  if (!record) throw new PermanentCrmJobError(`CRM record ${draft.crmRecordId} not found`);
  const [classification] = await db.select({
    status: crmClassifications.status,
    categoryKey: crmClassifications.appliedCategoryKey,
    proposedCategoryKey: crmClassifications.proposedCategoryKey,
    subcategoryKey: crmSubcategories.key,
  }).from(crmClassifications)
    .leftJoin(crmSubcategories, eq(crmSubcategories.id, crmClassifications.appliedSubcategoryId))
    .where(eq(crmClassifications.crmRecordId, record.id))
    .orderBy(desc(crmClassifications.createdAt))
    .limit(1);
  const [conversation] = await db.select({ channel: crmConversations.channel }).from(crmConversations)
    .where(and(inOrg(crmConversations), eq(crmConversations.id, draft.conversationId))).limit(1);
  const [person] = await db.select({ email: people.email }).from(people).where(and(inOrg(people), eq(people.id, record.personId))).limit(1);

  const decision = autopilotDecision({
    enabled: await enabledForPipeline(db, record.pipelineId),
    draftStatus: draft.status,
    classification: classification ? { status: classification.status, categoryKey: classification.categoryKey ?? null, subcategoryKey: classification.subcategoryKey ?? null } : null,
    doNotContact: await isPersonDoNotContact(db, record.personId),
    suppressed: conversation?.channel === "email" && person?.email ? await isSuppressed(person.email) : false,
    sentInConversation: await autopilotSends({ conversationId: draft.conversationId }),
    sentToday: await autopilotSends({ since: utcDayStart() }),
  });

  const allowed = dependencies.allowNonProduction ?? (process.env.NODE_ENV === "production" || process.env.AUTOPILOT_ALLOW_NON_PRODUCTION === "true");
  const held = !decision.send ? decision.reason : allowed ? null : "the autopilot only sends from a production server";
  if (held) {
    await withCrmTransaction(async (tx) => appendCrmEvent(tx, {
      personId: record.personId,
      crmRecordId: record.id,
      pipelineId: record.pipelineId,
      eventType: "autopilot.held",
      actorType: "ai",
      actorRef: AUTOPILOT_ACTOR,
      toData: { draftId: draft.id, revision: draft.revision },
      meta: { reason: held },
      contextVersion: record.contextVersion,
    }));
    return { sent: false, reason: held };
  }

  await sendDraft({
    draftId: draft.id,
    revision: draft.revision,
    idempotencyKey: autopilotIdempotencyKey(draft.id, draft.revision),
    requestId: randomUUID(),
    actorRef: AUTOPILOT_ACTOR,
  }, { send: dependencies.send });
  return { sent: true, reason: null };
}

export async function handleAutoSendJob(job: CrmJob): Promise<void> {
  await runAutopilotForDraft(job.entityId);
}
