import "server-only";

import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { AUTOPILOT_ACTOR, AUTOPILOT_LIMITS, autopilotGate, autopilotIdempotencyKey, limitProblem, type AutopilotFacts } from "@/lib/crm/autopilot";
import { runMembershipFor } from "@/lib/crm/autopilot.server";
import { appendCrmEvent } from "@/lib/crm/events";
import { isPersonDoNotContact, setPersonDoNotContact } from "@/lib/crm/policies";
import { enqueueCrmJobInTransaction } from "@/lib/crm/queue";
import { regenerateDraft } from "@/lib/crm/drafts";
import { draftInOrg } from "@/lib/crm/records";
import { withCrmTransaction, type CrmExecutor } from "@/lib/crm/repository";
import {
  crmClassifications,
  crmConversationMessages,
  crmConversations,
  crmDrafts,
  crmRecords,
  crmSubcategories,
} from "@/lib/crm/schema";
import { sendDraft, type CrmSendAdapter } from "@/lib/crm/send";
import { people } from "@/lib/leads/schema";
import { isSuppressed } from "@/lib/outreach/suppression";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { openDecision } from "./decisions.server";
import { handoverMessage, HANDOVER_INTERVAL_MS, NO_ANSWER_NEEDED, tellsTheLead } from "./handoff";
import { settlePersonReplies, waitsForOwner, writeBrief } from "./handoff.server";
import { getBusinessProfile } from "./profile.server";
import { judgeReply, selfFixableTimes, type ModelCheck } from "./replyCheck";
import { checkKnowledge, modelReplyCheck, type ReplyCheckInput } from "./replyCheck.server";
import { autopilotReplies, autopilotTakeovers, outreachRunLeads, ownerDecisions, type AudienceChannel, type OwnerDecisionKind, type ReplyCheck } from "./schema";

/**
 * Runs the reply autopilot on one draft (the CRM's auto_send job):
 *
 * 1. the gate (src/lib/crm/autopilot.ts): the person's run, its mode and
 *    state, opt-outs, takeover, edits, newer messages, the classification;
 * 2. the support check (replyCheck.ts): every answer and claim backed by
 *    the owner's information, no invented prices, times or promises;
 *    opt-outs stop all outreach; anything else becomes an owner decision;
 * 3. a reservation under the organization's advisory lock, after reading
 *    everything again (state can change during the check) and counting
 *    every reservation toward the limits, so concurrent jobs cannot
 *    exceed them; unique per (draft, revision), so never two sends;
 * 4. sendDraft with the autopilot's idempotency key — the same path, DNC
 *    checks and duplicate protection as a person's Approve & send.
 *
 * When a person is needed (the lead is ready, asks for a person, asks what
 * the owner's information does not answer, complains, or the conversation
 * reached its limit) it is a handoff (handoff.ts): the decision lands in
 * Needs you with a brief, the lead is told once that a personal reply
 * follows, and the autopilot stays quiet in that chat until it is settled.
 *
 * Each decision is recorded in autopilot_replies with its reason.
 */

export type AutopilotOutcome = { sent: boolean; reason: string | null; /** The lead was told a personal reply follows. */ handover?: boolean };

export type AutopilotDependencies = {
  /** Rewrite a reply once when its only fault is a proposed time (default: when the real model checks; it needs the model). */
  rewrite?: boolean;
  /** The revision the job was queued for. */
  revision?: number | null;
  /** When the draft became ready; an outbound message after it means someone answered. */
  readyAt?: Date | null;
  send?: CrmSendAdapter;
  /** Replaces the model half of the support check (tests). */
  check?: (input: ReplyCheckInput & { knowledge: string }) => Promise<ModelCheck>;
  /** Write the owner's brief with the model (default: when the real model checks). */
  brief?: boolean;
  allowNonProduction?: boolean;
};

type State = {
  facts: AutopilotFacts;
  draft: typeof crmDrafts.$inferSelect;
  recordId: string;
  personId: string;
  pipelineId: string;
  contextVersion: number;
  conversationId: string;
  channel: string;
  membership: Awaited<ReturnType<typeof runMembershipFor>>;
  leadMessage: string;
  leadName: string;
  leadFirstName: string | null;
  email: string | null;
};

async function loadState(executor: CrmExecutor, draftId: string, deps: AutopilotDependencies): Promise<State | null> {
  const [draft] = await executor.select().from(crmDrafts).where(and(draftInOrg(), eq(crmDrafts.id, draftId))).limit(1);
  if (!draft) return null;
  const [record] = await executor.select().from(crmRecords).where(and(inOrg(crmRecords), eq(crmRecords.id, draft.crmRecordId))).limit(1);
  if (!record) return null;
  const [conversation] = await executor.select({ id: crmConversations.id, channel: crmConversations.channel }).from(crmConversations)
    .where(and(inOrg(crmConversations), eq(crmConversations.id, draft.conversationId))).limit(1);
  if (!conversation) return null;
  const [person] = await executor.select({ email: people.email, fullName: people.fullName, firstName: people.firstName, raw: people.raw })
    .from(people).where(and(inOrg(people), eq(people.id, record.personId))).limit(1);
  // An unconfirmed classification counts by what it proposes (the gate decides what that allows).
  const [classification] = await executor.select({
    status: crmClassifications.status,
    categoryKey: sql<string | null>`coalesce(${crmClassifications.appliedCategoryKey}, ${crmClassifications.proposedCategoryKey})`,
    subcategoryKey: crmSubcategories.key,
  }).from(crmClassifications)
    .leftJoin(crmSubcategories, sql`${crmSubcategories.id} = coalesce(${crmClassifications.appliedSubcategoryId}, ${crmClassifications.proposedSubcategoryId})`)
    .where(eq(crmClassifications.crmRecordId, record.id))
    .orderBy(desc(crmClassifications.createdAt))
    .limit(1);
  const membership = await runMembershipFor(executor, record.personId, conversation.channel);
  const [takeover] = await executor.select({ id: autopilotTakeovers.id }).from(autopilotTakeovers)
    .where(and(inOrg(autopilotTakeovers), eq(autopilotTakeovers.conversationId, conversation.id))).limit(1);
  const readyAt = deps.readyAt ?? draft.updatedAt;
  const [answered] = await executor.select({ n: count() }).from(crmConversationMessages)
    .where(and(eq(crmConversationMessages.conversationId, conversation.id), eq(crmConversationMessages.direction, "outbound"), gt(crmConversationMessages.sentAt, readyAt)));
  const answersMessageId = draft.replyForMessageId ?? record.latestInboundMessageId;
  const [leadMessage] = answersMessageId
    ? await executor.select({ bodyText: crmConversationMessages.bodyText, subject: crmConversationMessages.subject }).from(crmConversationMessages).where(eq(crmConversationMessages.id, answersMessageId)).limit(1)
    : [];
  const newerInbound = Boolean(draft.replyForMessageId && record.latestInboundMessageId && record.latestInboundMessageId !== draft.replyForMessageId);
  const businessName = typeof (person?.raw as Record<string, unknown> | null)?.businessName === "string" ? String((person!.raw as Record<string, unknown>).businessName) : "";
  return {
    facts: {
      draftStatus: draft.status,
      draftRevision: draft.revision,
      queuedRevision: deps.revision ?? null,
      editedByPerson: Boolean(draft.editedBodyText?.trim()),
      membership: membership ? { runStatus: membership.runStatus, automatic: membership.automatic, leadStatus: membership.leadStatus } : null,
      takeover: Boolean(takeover),
      waitingForOwner: await waitsForOwner(executor, conversation.id),
      answeredSinceDraft: Number(answered?.n ?? 0) > 0,
      newerInbound,
      doNotContact: await isPersonDoNotContact(executor, record.personId),
      suppressed: conversation.channel === "email" && person?.email ? await isSuppressed(person.email) : false,
      // A record a person keeps as a customer stays one, whatever a new reply proposes.
      classification: classification ? { status: classification.status, categoryKey: record.categoryKey === "customer" ? "customer" : classification.categoryKey ?? null, subcategoryKey: classification.subcategoryKey ?? null } : null,
    },
    draft,
    recordId: record.id,
    personId: record.personId,
    pipelineId: record.pipelineId,
    contextVersion: record.contextVersion,
    conversationId: conversation.id,
    channel: conversation.channel,
    membership,
    leadMessage: [leadMessage?.subject ? `Subject: ${leadMessage.subject}` : null, leadMessage?.bodyText ?? ""].filter(Boolean).join("\n").slice(0, 6_000),
    leadName: person?.fullName || person?.firstName || businessName || person?.email || "the lead",
    leadFirstName: person?.firstName?.trim() || null,
    email: person?.email ?? null,
  };
}

const SELF_REWRITE_REASON = "rewritten once without the proposed time:";

/** Whether this reply was already rewritten once to drop a proposed time (then the owner decides). */
async function alreadyRewritten(draftId: string): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(autopilotReplies)
    .where(and(eq(autopilotReplies.organizationId, currentOrganizationId()), eq(autopilotReplies.draftId, draftId), sql`${autopilotReplies.reason} like ${`${SELF_REWRITE_REASON}%`}`));
  return Number(row?.n ?? 0) > 0;
}

async function recordHold(state: State, reason: string, check: ReplyCheck | null = null): Promise<AutopilotOutcome> {
  const organizationId = currentOrganizationId();
  await db.insert(autopilotReplies).values({
    organizationId,
    draftId: state.draft.id,
    revision: state.draft.revision,
    conversationId: state.conversationId,
    runId: state.membership?.runId ?? null,
    personId: state.personId,
    status: "held",
    reason: reason.slice(0, 1_000),
    check,
  }).onConflictDoUpdate({
    target: [autopilotReplies.draftId, autopilotReplies.revision],
    set: { status: "held", reason: reason.slice(0, 1_000), check, updatedAt: new Date() },
    setWhere: eq(autopilotReplies.status, "held"),
  });
  await withCrmTransaction(async (tx) => appendCrmEvent(tx, {
    personId: state.personId,
    crmRecordId: state.recordId,
    pipelineId: state.pipelineId,
    eventType: "autopilot.held",
    actorType: "ai",
    actorRef: AUTOPILOT_ACTOR,
    toData: { draftId: state.draft.id, revision: state.draft.revision },
    meta: { reason },
    contextVersion: state.contextVersion,
  })).catch((error) => console.error("[autopilot] could not record the hold:", error));
  return { sent: false, reason };
}

/** An interested lead is reported to the owner once per draft, whatever the mode. */
async function reportInterest(state: State): Promise<void> {
  const classification = state.facts.classification;
  if (!state.membership || classification?.categoryKey !== "interested") return;
  const [existing] = await db.select({ id: ownerDecisions.id }).from(ownerDecisions)
    .where(and(inOrg(ownerDecisions), eq(ownerDecisions.kind, "interested"), eq(ownerDecisions.draftId, state.draft.id))).limit(1);
  if (existing) return;
  const what = classification.subcategoryKey ? classification.subcategoryKey.replace(/_/g, " ") : "interested";
  await openDecision({
    kind: "interested",
    reason: `${state.leadName} is interested (${what}).`,
    decision: state.membership.automatic
      ? "The assistant answers if your information covers their question; otherwise it asks you here."
      : "This run is in Review mode: their reply waits for you in Action required.",
    leadMessage: state.leadMessage,
    personId: state.personId,
    crmRecordId: state.recordId,
    conversationId: state.conversationId,
    draftId: state.draft.id,
    runId: state.membership.runId,
    threadId: state.membership.threadId,
  });
}

function utc24hAgo(): Date {
  return new Date(Date.now() - 24 * 60 * 60_000);
}

function sendingAllowed(deps: AutopilotDependencies): boolean {
  return deps.allowNonProduction ?? (process.env.NODE_ENV === "production" || process.env.AUTOPILOT_ALLOW_NON_PRODUCTION === "true");
}

/**
 * Tells the lead, once, that a personal reply follows: the held draft
 * becomes that message as a new revision and goes through the same send
 * path as every automatic reply (Do Not Contact, duplicates, the daily
 * limit). At most one per conversation a day; never in Review mode, outside
 * production, or on a CRM sequence's step.
 */
async function sendHandover(state: State, decisionId: string, kind: OwnerDecisionKind, deps: AutopilotDependencies): Promise<boolean> {
  if (!state.membership?.automatic || state.draft.sequenceStepRunId || !tellsTheLead(kind) || !sendingAllowed(deps)) return false;
  const organizationId = currentOrganizationId();
  const profile = await getBusinessProfile();
  const message = handoverMessage(state.channel as AudienceChannel, {
    kind,
    leadMessage: state.leadMessage,
    senderName: profile.senderName,
    leadFirstName: state.leadFirstName,
    subject: state.draft.subject,
  });
  const reserved = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`autopilot:${organizationId}`}, 0))`);
    const [recent] = await tx.select({ id: ownerDecisions.id }).from(ownerDecisions)
      .where(and(inOrg(ownerDecisions), eq(ownerDecisions.conversationId, state.conversationId), gte(ownerDecisions.handoverSentAt, new Date(Date.now() - HANDOVER_INTERVAL_MS))))
      .limit(1);
    if (recent) return null;
    const [inDay] = await tx.select({ n: count() }).from(autopilotReplies)
      .where(and(eq(autopilotReplies.organizationId, organizationId), gte(autopilotReplies.createdAt, utc24hAgo()), inArray(autopilotReplies.status, ["reserved", "sent", "failed"])));
    if (Number(inDay?.n ?? 0) >= AUTOPILOT_LIMITS.perDay) return null;
    const [draft] = await tx.update(crmDrafts).set({
      aiBodyText: message.body,
      aiBodyHtml: null,
      subject: state.channel === "email" ? (state.draft.subject?.trim() || message.subject) : null,
      revision: sql`${crmDrafts.revision} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(crmDrafts.id, state.draft.id), eq(crmDrafts.revision, state.draft.revision), eq(crmDrafts.status, "awaiting_review")))
      .returning({ revision: crmDrafts.revision });
    if (!draft) return null;
    const rows = await tx.insert(autopilotReplies).values({
      organizationId,
      draftId: state.draft.id,
      revision: draft.revision,
      conversationId: state.conversationId,
      runId: state.membership!.runId,
      personId: state.personId,
      status: "reserved",
      reason: `handover (${kind}): the lead was told a personal reply follows`,
    }).onConflictDoNothing().returning({ id: autopilotReplies.id });
    if (!rows.length) return null;
    await tx.update(ownerDecisions).set({ handoverSentAt: new Date(), updatedAt: new Date() }).where(eq(ownerDecisions.id, decisionId));
    return { id: rows[0]!.id, revision: draft.revision };
  });
  if (!reserved) return false;
  try {
    await sendDraft({
      draftId: state.draft.id,
      revision: reserved.revision,
      idempotencyKey: autopilotIdempotencyKey(state.draft.id, reserved.revision),
      requestId: randomUUID(),
      actorRef: AUTOPILOT_ACTOR,
    }, { send: deps.send });
    await db.update(autopilotReplies).set({ status: "sent", updatedAt: new Date() }).where(eq(autopilotReplies.id, reserved.id));
    return true;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    console.error("[assistant/autopilot] the handover message failed:", text);
    await db.update(autopilotReplies).set({ status: "failed", reason: `handover failed: ${text}`.slice(0, 1_000), updatedAt: new Date() }).where(eq(autopilotReplies.id, reserved.id));
    await db.update(ownerDecisions).set({ handoverSentAt: null, updatedAt: new Date() }).where(eq(ownerDecisions.id, decisionId));
    return false;
  }
}

/**
 * Hands the conversation to the owner: the decision (with the reason and
 * what is needed) goes to Needs you and the run's chat, its brief is
 * written, the lead is told once that a personal reply follows, and the
 * reply is held.
 */
async function handOff(
  state: State,
  input: { kind: OwnerDecisionKind; reason: string; decision: string; holdReason?: string; check?: ReplyCheck | null },
  deps: AutopilotDependencies,
): Promise<AutopilotOutcome> {
  const decisionId = await openDecision({
    kind: input.kind,
    reason: input.reason,
    decision: input.decision,
    leadMessage: state.leadMessage,
    personId: state.personId,
    crmRecordId: state.recordId,
    conversationId: state.conversationId,
    draftId: state.draft.id,
    runId: state.membership?.runId ?? null,
    threadId: state.membership?.threadId ?? null,
  });
  let handover = false;
  if (decisionId) {
    if (deps.brief ?? deps.check === undefined) {
      await writeBrief(decisionId).catch((error) => console.error("[assistant/autopilot] brief failed:", error));
    }
    handover = await sendHandover(state, decisionId, input.kind, deps).catch((error) => {
      console.error("[assistant/autopilot] handover failed:", error);
      return false;
    });
  }
  const outcome = await recordHold(state, input.holdReason ?? input.reason, input.check ?? null);
  return { ...outcome, handover };
}

export async function runAutopilotForDraft(draftId: string, deps: AutopilotDependencies = {}): Promise<AutopilotOutcome> {
  let state = await loadState(db, draftId, deps);
  if (!state || !state.membership) return { sent: false, reason: "not part of an outreach run" };
  // A person who replied in this chat after a handoff settles it (the chat is theirs now).
  if (await settlePersonReplies(state.conversationId)) {
    state = await loadState(db, draftId, deps);
    if (!state || !state.membership) return { sent: false, reason: "not part of an outreach run" };
  }
  await reportInterest(state).catch((error) => console.error("[autopilot] could not report interest:", error));

  // 1. The gate.
  const gate = autopilotGate(state.facts);
  if (!gate.pass) {
    if (gate.decision) return handOff(state, { kind: gate.decision.kind, reason: `${state.leadName}: ${gate.reason}`, decision: gate.decision.decision, holdReason: gate.reason }, deps);
    return recordHold(state, gate.reason);
  }

  // 2. The support check.
  const reply = [state.draft.subject ? `Subject: ${state.draft.subject}` : null, (state.draft.editedBodyText?.trim() || state.draft.aiBodyText || "").trim()].filter(Boolean).join("\n");
  const knowledge = await checkKnowledge(state.leadMessage);
  let model: ModelCheck;
  try {
    model = deps.check
      ? await deps.check({ leadMessage: state.leadMessage, reply, leadName: state.leadName, knowledge })
      : await modelReplyCheck({ leadMessage: state.leadMessage, reply, leadName: state.leadName, knowledge, runId: state.membership.runId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return handOff(state, { kind: "uncertain", reason: `The reply to ${state.leadName} could not be checked (${message.slice(0, 200)}).`, decision: "Read it in Action required and send it yourself if it is right.", holdReason: "the reply could not be checked" }, deps);
  }
  const [answered] = await db.select({ n: count() }).from(autopilotReplies)
    .where(and(eq(autopilotReplies.organizationId, currentOrganizationId()), eq(autopilotReplies.conversationId, state.conversationId), eq(autopilotReplies.status, "sent")));
  const verdict = judgeReply(model, { reply, knowledge, leadName: state.leadName, answeredBefore: Number(answered?.n ?? 0) > 0 });
  if (verdict.action === "no_reply") return recordHold(state, `${NO_ANSWER_NEEDED} ${verdict.reason}`, verdict.check);
  if (verdict.action === "opt_out") {
    await setPersonDoNotContact({ personId: state.personId, reason: `${verdict.reason} (read in their reply)`, source: "inbound_request", actorType: "ai", actorRef: AUTOPILOT_ACTOR });
    return recordHold(state, "they asked not to be contacted: all outreach to them stopped", verdict.check);
  }
  if (verdict.action === "hold") {
    // A reply whose only fault is a proposed day or time is rewritten once without it, not handed to the owner.
    const times = selfFixableTimes(verdict.check);
    if (times && (deps.rewrite ?? deps.check === undefined) && !(await alreadyRewritten(state.draft.id))) {
      try {
        const outcome = await recordHold(state, `${SELF_REWRITE_REASON} ${times.join(", ")}`, verdict.check);
        await regenerateDraft(state.draft.id, {}, `Rewrite this reply without proposing any day, date or time window (remove: ${times.join(", ")}). Keep the answer itself; give the booking link if the business information has one, or ask when suits them.`);
        return outcome;
      } catch (error) {
        console.error("[assistant/autopilot] rewriting without the proposed time failed:", error);
      }
    }
    return handOff(state, { kind: verdict.kind, reason: verdict.reason, decision: verdict.decision, check: verdict.check }, deps);
  }

  if (!sendingAllowed(deps)) return recordHold(state, "the autopilot only sends from a production server", verdict.check);

  // 3. Reserve under the organization's lock, after reading everything again.
  const organizationId = currentOrganizationId();
  const reservation = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`autopilot:${organizationId}`}, 0))`);
    const fresh = await loadState(tx, draftId, deps);
    if (!fresh || !fresh.membership) return { held: "the draft or its run disappeared" } as const;
    const again = autopilotGate(fresh.facts);
    if (!again.pass) return { held: again.reason } as const;
    if (fresh.draft.revision !== state.draft.revision) return { held: "the draft changed while it was checked" } as const;
    const counted = inArray(autopilotReplies.status, ["reserved", "sent", "failed"]);
    const [inConversation] = await tx.select({ n: count() }).from(autopilotReplies)
      .where(and(eq(autopilotReplies.organizationId, organizationId), eq(autopilotReplies.conversationId, fresh.conversationId), counted));
    const [inDay] = await tx.select({ n: count() }).from(autopilotReplies)
      .where(and(eq(autopilotReplies.organizationId, organizationId), gte(autopilotReplies.createdAt, utc24hAgo()), counted));
    const limit = limitProblem({ sentInConversation: Number(inConversation?.n ?? 0), sentInLast24h: Number(inDay?.n ?? 0) });
    if (limit) return { held: limit, perConversation: Number(inConversation?.n ?? 0) >= AUTOPILOT_LIMITS.perConversation } as const;
    const rows = await tx.insert(autopilotReplies).values({
      organizationId,
      draftId: fresh.draft.id,
      revision: fresh.draft.revision,
      conversationId: fresh.conversationId,
      runId: fresh.membership.runId,
      personId: fresh.personId,
      status: "reserved",
      check: verdict.check,
    }).onConflictDoUpdate({
      target: [autopilotReplies.draftId, autopilotReplies.revision],
      set: { status: "reserved", reason: null, check: verdict.check, createdAt: new Date(), updatedAt: new Date() },
      setWhere: eq(autopilotReplies.status, "held"),
    }).returning({ id: autopilotReplies.id });
    if (!rows.length) return { duplicate: true } as const;
    return { id: rows[0]!.id } as const;
  });
  if ("duplicate" in reservation) return { sent: false, reason: "this reply was already sent or is being sent" };
  if ("held" in reservation) {
    if ("perConversation" in reservation && reservation.perConversation) {
      return handOff(state, { kind: "limit", reason: `The assistant answered ${state.leadName} ${AUTOPILOT_LIMITS.perConversation} times; this conversation is yours now.`, decision: "Read the conversation and answer yourself.", holdReason: reservation.held ?? "held", check: verdict.check }, deps);
    }
    return recordHold(state, reservation.held ?? "held", verdict.check);
  }

  // 4. Send, through the same path as a person's Approve & send.
  try {
    await sendDraft({
      draftId: state.draft.id,
      revision: state.draft.revision,
      idempotencyKey: autopilotIdempotencyKey(state.draft.id, state.draft.revision),
      requestId: randomUUID(),
      actorRef: AUTOPILOT_ACTOR,
    }, { send: deps.send });
    await db.update(autopilotReplies).set({ status: "sent", updatedAt: new Date() }).where(eq(autopilotReplies.id, reservation.id));
    return { sent: true, reason: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(autopilotReplies).set({ status: "failed", reason: message.slice(0, 1_000), updatedAt: new Date() }).where(eq(autopilotReplies.id, reservation.id));
    return { sent: false, reason: `the send failed: ${message}` };
  }
}

/**
 * After a run resumes: replies of its members still waiting are queued for
 * the autopilot again (each re-checked in full, against the current
 * accounts and limits).
 */
export async function requeueRunAutopilot(runId: string): Promise<number> {
  const members = await db.select({ personId: outreachRunLeads.personId, channel: outreachRunLeads.channel }).from(outreachRunLeads)
    .where(and(inOrg(outreachRunLeads), eq(outreachRunLeads.runId, runId), eq(outreachRunLeads.status, "active")));
  if (!members.length) return 0;
  const drafts = await db.select({ id: crmDrafts.id, revision: crmDrafts.revision, channel: crmDrafts.channel, personId: crmRecords.personId })
    .from(crmDrafts)
    .innerJoin(crmRecords, eq(crmRecords.id, crmDrafts.crmRecordId))
    .where(and(draftInOrg(), inOrg(crmRecords), eq(crmDrafts.status, "awaiting_review"), inArray(crmRecords.personId, members.map((m) => m.personId))));
  const wanted = drafts.filter((draft) => members.some((m) => m.personId === draft.personId && m.channel === draft.channel));
  for (const draft of wanted) {
    await withCrmTransaction((tx) => enqueueCrmJobInTransaction(tx, {
      kind: "auto_send",
      entityId: draft.id,
      payload: { revision: draft.revision, readyAt: new Date().toISOString() },
      requeueCompleted: true,
      maxAttempts: 3,
      runAfter: new Date(Date.now() + 60_000),
    }));
  }
  return wanted.length;
}
