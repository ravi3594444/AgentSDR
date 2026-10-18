import { and, eq, inArray, or, sql } from "drizzle-orm";
import { outreachRunLeads } from "@/lib/assistant/schema";
import { people } from "@/lib/leads/schema";
import { leads as linkedinLeads } from "@/lib/linkedin/schema";
import { outreachCampaigns, outreachLeads, outreachMailboxQueue } from "@/lib/outreach/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { whatsappCampaignLeads, whatsappCampaigns } from "@/lib/whatsapp/schema";
import { appendCrmEvent, type CrmEventActor } from "./events";
import { CrmConflictError, type CrmExecutor, type CrmTransaction } from "./repository";
import { crmConversations, crmDrafts, crmRecords, crmSequenceRuns, crmSequenceStepRuns, crmWrongRoutes } from "./schema";
import { ACK_CLAIMABLE, candidateRoutes, isWrongRouteChannel, type WrongRouteAckStatus, type WrongRouteChannel } from "./wrongNumber";

/**
 * Wrong-number routes in the database (the rules are in wrongNumber.ts):
 * recording one and stopping outreach on it, the check every send makes,
 * and the single-use exemption for the one closing acknowledgement.
 */

export type CrmWrongRoute = typeof crmWrongRoutes.$inferSelect;

export const WRONG_ROUTE_REFUSAL = "This number or address was recorded as a wrong number for this lead; nothing more is sent to it";

/**
 * Wrong routes of the organization in scope that a send on this channel to
 * these routes would reach. Phone numbers and email addresses match by
 * route, so a corrected number works again; a profile (LinkedIn,
 * Instagram) also by the Person, whose profile id the route may not spell.
 */
export async function findWrongRoutes(
  executor: CrmExecutor,
  input: { channel: string; routes: readonly string[]; personId?: string | null; forUpdate?: boolean },
): Promise<CrmWrongRoute[]> {
  if (!isWrongRouteChannel(input.channel)) return [];
  const byPerson = input.personId && (input.channel === "linkedin" || input.channel === "instagram");
  if (!input.routes.length && !byPerson) return [];
  const query = executor.select().from(crmWrongRoutes).where(and(
    inOrg(crmWrongRoutes),
    eq(crmWrongRoutes.channel, input.channel),
    or(
      input.routes.length ? inArray(crmWrongRoutes.route, [...input.routes]) : undefined,
      byPerson ? eq(crmWrongRoutes.personId, input.personId!) : undefined,
    ),
  ));
  return input.forUpdate ? query.for("update") : query;
}

/** The wrong route a CRM conversation (its contact, or its Person's address on the channel) runs into, if any. */
export async function wrongRouteForConversation(executor: CrmExecutor, conversationId: string): Promise<CrmWrongRoute | null> {
  const [row] = await executor.select({ conversation: crmConversations, person: people })
    .from(crmConversations)
    .innerJoin(crmRecords, eq(crmRecords.id, crmConversations.crmRecordId))
    .innerJoin(people, eq(people.id, crmRecords.personId))
    .where(and(inOrg(crmConversations), eq(crmConversations.id, conversationId))).limit(1);
  if (!row) return null;
  const routes = candidateRoutes(row.conversation.channel, {
    providerContactId: row.conversation.providerContactId,
    email: row.person.email,
    phone: row.person.phone,
    linkedinUrl: row.person.linkedinUrl,
  });
  return (await findWrongRoutes(executor, { channel: row.conversation.channel, routes, personId: row.person.id }))[0] ?? null;
}

/** The LinkedIn campaign senders' check, beside Do Not Contact: this lead's profile was recorded as the wrong person. */
export async function linkedinRouteIsWrong(executor: CrmExecutor, personId: string, linkedinUrl: string | null | undefined): Promise<boolean> {
  return Boolean(await wrongRouteSendRefusal(executor, { channel: "linkedin", personId, routes: candidateRoutes("linkedin", { linkedinUrl }) }));
}

export type RecordWrongRoute = Pick<CrmWrongRoute, "id" | "channel" | "route" | "ackStatus" | "ackReason" | "ackDraftId" | "createdAt"> & {
  /** The record's conversations that run into this route (sending in them is blocked). */
  conversationIds: string[];
};

/** For the record page: the wrong routes recorded for this lead or reached by its conversations, and which conversations they block. */
export async function wrongRoutesForRecord(
  executor: CrmExecutor,
  input: { person: { id: string; email: string | null; phone: string | null; linkedinUrl: string | null }; conversations: readonly { id: string; channel: string; providerContactId: string | null }[] },
): Promise<RecordWrongRoute[]> {
  const byConversation = input.conversations.map((conversation) => ({
    id: conversation.id,
    channel: conversation.channel,
    routes: candidateRoutes(conversation.channel, { providerContactId: conversation.providerContactId, email: input.person.email, phone: input.person.phone, linkedinUrl: input.person.linkedinUrl }),
  }));
  const routes = [...new Set([
    ...byConversation.flatMap((conversation) => conversation.routes),
    ...(["email", "whatsapp"] as const).flatMap((channel) => candidateRoutes(channel, input.person)),
  ])];
  const rows = await executor.select().from(crmWrongRoutes)
    .where(and(inOrg(crmWrongRoutes), or(eq(crmWrongRoutes.personId, input.person.id), routes.length ? inArray(crmWrongRoutes.route, routes) : undefined)));
  return rows.map((row) => ({
    id: row.id,
    channel: row.channel,
    route: row.route,
    ackStatus: row.ackStatus,
    ackReason: row.ackReason,
    ackDraftId: row.ackDraftId,
    createdAt: row.createdAt,
    conversationIds: byConversation
      .filter((conversation) => conversation.channel === row.channel
        && (conversation.routes.includes(row.route) || ((row.channel === "linkedin" || row.channel === "instagram") && row.personId === input.person.id)))
      .map((conversation) => conversation.id),
  }));
}

/** People of the organization holding this route on the channel: the intended lead, and duplicate records of it. */
async function holdersOfRoute(tx: CrmTransaction, input: { channel: WrongRouteChannel; route: string; personId: string | null }): Promise<string[]> {
  const holders = new Set(input.personId ? [input.personId] : []);
  if (input.channel === "email" || input.channel === "whatsapp") {
    const match = input.channel === "email"
      ? sql`lower(${people.email}) = ${input.route}`
      : sql`regexp_replace(coalesce(${people.phone}, ''), '\\D', '', 'g') = ${input.route}`;
    for (const row of await tx.select({ id: people.id }).from(people).where(and(inOrg(people), match))) holders.add(row.id);
  }
  return [...holders];
}

/**
 * Stops everything queued to the route, now: open campaign enrollments on
 * that channel, the assistant run memberships on it (so the reply agent
 * stays out), CRM follow-up sequences and drafts on conversations of that
 * channel. The lead's other channels go on: this is not Do Not Contact.
 */
async function stopOutreachOnRouteInTransaction(tx: CrmTransaction, input: { channel: WrongRouteChannel; route: string; personId: string | null; reason: string }): Promise<void> {
  const organizationId = currentOrganizationId();
  const now = new Date();
  const holders = await holdersOfRoute(tx, input);
  if (!holders.length) return;

  if (input.channel === "email") {
    const open = await tx.select({ id: outreachLeads.id }).from(outreachLeads)
      .where(and(
        inArray(outreachLeads.campaignId, tx.select({ id: outreachCampaigns.id }).from(outreachCampaigns).where(inOrg(outreachCampaigns))),
        inArray(outreachLeads.personId, holders),
        inArray(outreachLeads.sequenceStatus, ["pending", "initial_sent", "in_follow_up", "reply_processing"]),
      ));
    if (open.length) {
      const ids = open.map((lead) => lead.id);
      await tx.delete(outreachMailboxQueue).where(inArray(outreachMailboxQueue.leadId, ids));
      await tx.update(outreachLeads).set({ sequenceStatus: "suppressed", nextSendAt: null, updatedAt: now }).where(inArray(outreachLeads.id, ids));
    }
  }
  if (input.channel === "whatsapp") {
    await tx.update(whatsappCampaignLeads)
      .set({ status: "stopped", nextSendAt: null, updatedAt: now })
      .where(and(
        inArray(whatsappCampaignLeads.campaignId, tx.select({ id: whatsappCampaigns.id }).from(whatsappCampaigns).where(inOrg(whatsappCampaigns))),
        or(inArray(whatsappCampaignLeads.personId, holders), sql`regexp_replace(${whatsappCampaignLeads.phone}, '\\D', '', 'g') = ${input.route}`),
        inArray(whatsappCampaignLeads.status, ["queued", "in_sequence"]),
      ));
  }
  if (input.channel === "linkedin") {
    await tx.update(linkedinLeads)
      .set({ status: "CANCELLED", updatedAt: now })
      .where(and(
        eq(linkedinLeads.organizationId, organizationId),
        inArray(linkedinLeads.personId, holders),
        inArray(linkedinLeads.status, ["PENDING", "REQUEST_SENT", "CONNECTED", "ACCEPT_MESSAGE_SENT", "FOLLOW_UP_1_SENT", "FOLLOW_UP_2_SENT", "FOLLOW_UP_3_SENT"]),
      ));
  }
  await tx.update(outreachRunLeads)
    .set({ status: "stopped", stopReason: `Wrong number: ${input.reason}`.slice(0, 500), updatedAt: now })
    .where(and(
      eq(outreachRunLeads.organizationId, organizationId),
      inArray(outreachRunLeads.personId, holders),
      eq(outreachRunLeads.channel, input.channel),
      eq(outreachRunLeads.status, "active"),
    ));

  // CRM follow-ups and drafts on this channel's conversations.
  const conversationsOnChannel = tx.select({ id: crmConversations.id }).from(crmConversations)
    .innerJoin(crmRecords, eq(crmRecords.id, crmConversations.crmRecordId))
    .where(and(inOrg(crmConversations), eq(crmConversations.channel, input.channel), inArray(crmRecords.personId, holders)));
  const runs = await tx.select({ id: crmSequenceRuns.id }).from(crmSequenceRuns)
    .where(and(inOrg(crmSequenceRuns), eq(crmSequenceRuns.status, "active"), inArray(crmSequenceRuns.conversationId, conversationsOnChannel)));
  if (runs.length) {
    const runIds = runs.map((run) => run.id);
    await tx.update(crmSequenceRuns).set({ status: "interrupted", updatedAt: now }).where(inArray(crmSequenceRuns.id, runIds));
    await tx.update(crmSequenceStepRuns).set({ status: "cancelled", updatedAt: now })
      .where(and(inArray(crmSequenceStepRuns.sequenceRunId, runIds), inArray(crmSequenceStepRuns.status, ["scheduled", "drafting", "awaiting_review", "failed"])));
  }
  await tx.update(crmDrafts).set({ status: "stale", updatedAt: now })
    .where(and(
      inArray(crmDrafts.conversationId, conversationsOnChannel),
      inArray(crmDrafts.status, ["generating", "awaiting_review", "failed"]),
    ));
}

export type RecordWrongRouteInput = {
  personId: string;
  channel: WrongRouteChannel;
  route: string;
  crmRecordId: string | null;
  pipelineId: string | null;
  conversationId: string | null;
  messageId: string | null;
  source: "reply_agent" | "classifier" | "human";
  reason: string;
  ackStatus: Extract<WrongRouteAckStatus, "none" | "blocked">;
  ackReason: string | null;
  actorType: CrmEventActor;
  actorRef?: string | null;
};

/**
 * Records the route as wrong, once per organization, channel and route, and
 * stops outreach on it in the same transaction. `created` is false when it
 * was already recorded (a repeat, a duplicate job, a concurrent worker):
 * the existing row, locked, is returned and nothing else changes.
 */
export async function recordWrongRouteInTransaction(tx: CrmTransaction, input: RecordWrongRouteInput): Promise<{ row: CrmWrongRoute; created: boolean }> {
  const organizationId = currentOrganizationId();
  const now = new Date();
  const [inserted] = await tx.insert(crmWrongRoutes).values({
    organizationId,
    personId: input.personId,
    channel: input.channel,
    route: input.route,
    crmRecordId: input.crmRecordId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    source: input.source,
    reason: input.reason.slice(0, 500),
    ackStatus: input.ackStatus,
    ackReason: input.ackReason?.slice(0, 500) ?? null,
    ackUpdatedAt: now,
  }).onConflictDoNothing({ target: [crmWrongRoutes.organizationId, crmWrongRoutes.channel, crmWrongRoutes.route] }).returning();
  if (!inserted) {
    const [existing] = await tx.select().from(crmWrongRoutes)
      .where(and(inOrg(crmWrongRoutes), eq(crmWrongRoutes.channel, input.channel), eq(crmWrongRoutes.route, input.route)))
      .limit(1).for("update");
    if (!existing) throw new Error("Wrong route insert conflicted but no row was found");
    return { row: existing, created: false };
  }
  await stopOutreachOnRouteInTransaction(tx, { channel: input.channel, route: input.route, personId: input.personId, reason: input.reason });
  await appendCrmEvent(tx, {
    personId: input.personId,
    crmRecordId: input.crmRecordId,
    pipelineId: input.crmRecordId ? input.pipelineId : null,
    eventType: "contact_policy.wrong_route_set",
    actorType: input.actorType,
    actorRef: input.actorRef,
    toData: { wrongRouteId: inserted.id, channel: input.channel, route: input.route, messageId: input.messageId },
    meta: { reason: input.reason, source: input.source },
  });
  return { row: inserted, created: true };
}

/** Moves the acknowledgement from one of `from` to `to`; false when it was not in one of them (someone else moved it first). */
export async function setAcknowledgementInTransaction(
  executor: CrmExecutor,
  input: { id: string; from: readonly WrongRouteAckStatus[]; to: WrongRouteAckStatus; reason?: string | null; draftId?: string | null },
): Promise<boolean> {
  const now = new Date();
  const rows = await executor.update(crmWrongRoutes).set({
    ackStatus: input.to,
    ackReason: input.reason?.slice(0, 500) ?? null,
    ...(input.draftId !== undefined ? { ackDraftId: input.draftId } : {}),
    ackUpdatedAt: now,
    updatedAt: now,
  }).where(and(inOrg(crmWrongRoutes), eq(crmWrongRoutes.id, input.id), inArray(crmWrongRoutes.ackStatus, [...input.from])))
    .returning({ id: crmWrongRoutes.id });
  return rows.length > 0;
}

/**
 * The send path's check, in prepareSend's transaction: a draft to a route
 * recorded as wrong is refused, except the route's own acknowledgement
 * draft while it is still claimable, which this consumes (→ sending), so it
 * passes exactly once. Never touches Do Not Contact: that is checked first,
 * separately, and always wins.
 */
export async function claimRouteForSendInTransaction(
  tx: CrmTransaction,
  input: { draftId: string; channel: string; personId: string; routes: readonly string[] },
): Promise<{ ackRouteId: string | null }> {
  const rows = await findWrongRoutes(tx, { channel: input.channel, routes: input.routes, personId: input.personId, forUpdate: true });
  if (!rows.length) return { ackRouteId: null };
  // Only when the one route it reaches is the one this draft apologises on.
  const ack = rows.length === 1 && rows[0]!.ackDraftId === input.draftId && ACK_CLAIMABLE.includes(rows[0]!.ackStatus) ? rows[0]! : null;
  if (!ack) throw new CrmConflictError(WRONG_ROUTE_REFUSAL);
  if (!(await setAcknowledgementInTransaction(tx, { id: ack.id, from: ACK_CLAIMABLE, to: "sending" }))) throw new CrmConflictError(WRONG_ROUTE_REFUSAL);
  return { ackRouteId: ack.id };
}

/** Just before the provider: the reason a send must not go out on this route, or null (clear, or this send's acknowledgement in flight). */
export async function wrongRouteSendRefusal(
  executor: CrmExecutor,
  input: { channel: string; personId?: string | null; routes: readonly string[]; ackRouteId?: string | null },
): Promise<string | null> {
  const rows = await findWrongRoutes(executor, input);
  return rows.some((row) => !(input.ackRouteId && row.id === input.ackRouteId && row.ackStatus === "sending")) ? WRONG_ROUTE_REFUSAL : null;
}

/**
 * The acknowledgement's outcome, recorded by the send path on the row whose
 * draft it is (sending → sent / failed / uncertain; uncertain → sent or
 * failed by reconciliation). False when the draft is no acknowledgement.
 */
export async function settleAcknowledgementInTransaction(tx: CrmTransaction, input: { draftId: string; status: Extract<WrongRouteAckStatus, "sent" | "failed" | "uncertain">; reason?: string | null }): Promise<boolean> {
  const now = new Date();
  const rows = await tx.update(crmWrongRoutes).set({
    ackStatus: input.status,
    ackReason: input.reason?.slice(0, 500) ?? null,
    ackUpdatedAt: now,
    updatedAt: now,
  }).where(and(inOrg(crmWrongRoutes), eq(crmWrongRoutes.ackDraftId, input.draftId), inArray(crmWrongRoutes.ackStatus, ["sending", "uncertain"])))
    .returning({ id: crmWrongRoutes.id });
  return rows.length > 0;
}

/** A person discarded the acknowledgement's draft: it never goes out, and no later message writes it again. */
export async function setAsideAcknowledgementInTransaction(tx: CrmTransaction, input: { draftId: string; reason: string }): Promise<void> {
  const now = new Date();
  await tx.update(crmWrongRoutes).set({ ackStatus: "blocked", ackReason: input.reason.slice(0, 500), ackUpdatedAt: now, updatedAt: now })
    .where(and(inOrg(crmWrongRoutes), eq(crmWrongRoutes.ackDraftId, input.draftId), inArray(crmWrongRoutes.ackStatus, [...ACK_CLAIMABLE])));
}

/** Do Not Contact was set: an acknowledgement not yet sending never goes out. */
export async function blockPendingAcknowledgementsInTransaction(tx: CrmTransaction, input: { personId: string; reason: string }): Promise<void> {
  const now = new Date();
  await tx.update(crmWrongRoutes).set({ ackStatus: "blocked", ackReason: input.reason.slice(0, 500), ackUpdatedAt: now, updatedAt: now })
    .where(and(inOrg(crmWrongRoutes), eq(crmWrongRoutes.personId, input.personId), inArray(crmWrongRoutes.ackStatus, [...ACK_CLAIMABLE])));
}
