import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { REPORT_KINDS } from "@/lib/assistant/handoff";
import { autopilotTakeovers, outreachRunLeads, outreachRuns, ownerDecisions, type OutreachPlan } from "@/lib/assistant/schema";
import { instagramAccounts } from "@/lib/instagram/schema";
import { people } from "@/lib/leads/schema";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { whatsappAccounts } from "@/lib/whatsapp/schema";
import { describeConversation, type ConversationSummary, type ReplyMode, type SummaryDecision } from "./conversationSummary";
import {
  crmClassifications,
  crmConversationMessages,
  crmConversations,
  crmDrafts,
  crmPersonContactPolicies,
  crmRecords,
  crmSequenceStepRuns,
  crmSequenceSteps,
  crmWrongRoutes,
} from "./schema";
import { candidateRoutes } from "./wrongNumber";

/**
 * The facts describeConversation reads, for a page of CRM records at once:
 * one batch of organization-scoped reads, then a second for what depends on
 * the conversation found (its run membership, wrong routes and account).
 * Shared by the Action required list and the record workspace, so a row and
 * the record it opens say the same thing. Reads only.
 */
export async function loadConversationSummaries(recordIds: readonly string[], now = new Date()): Promise<Map<string, ConversationSummary>> {
  const ids = [...new Set(recordIds)];
  if (!ids.length) return new Map();
  const scopedRecordIds = db.select({ id: crmRecords.id }).from(crmRecords).where(and(inOrg(crmRecords), inArray(crmRecords.id, ids)));
  const conversationIds = db.select({ id: crmConversations.id }).from(crmConversations)
    .where(and(inOrg(crmConversations), inArray(crmConversations.crmRecordId, ids)));
  const [records, latest, drafts, awaiting, classifications, decisions, takeovers] = await Promise.all([
    db.select({
      id: crmRecords.id, personId: crmRecords.personId, workflowState: crmRecords.workflowState, nextActionAt: crmRecords.nextActionAt,
      email: people.email, phone: people.phone, linkedinUrl: people.linkedinUrl, doNotContact: crmPersonContactPolicies.doNotContact,
    }).from(crmRecords)
      .innerJoin(people, and(eq(people.id, crmRecords.personId), inOrg(people)))
      .leftJoin(crmPersonContactPolicies, eq(crmPersonContactPolicies.personId, crmRecords.personId))
      .where(and(inOrg(crmRecords), inArray(crmRecords.id, ids))),
    // The newest message each way per record; a tie on sentAt goes to the later write.
    db.selectDistinctOn([crmConversations.crmRecordId, crmConversationMessages.direction], {
      recordId: crmConversations.crmRecordId,
      direction: crmConversationMessages.direction,
      id: crmConversationMessages.id,
      conversationId: crmConversations.id,
      channel: crmConversations.channel,
      accountRef: crmConversations.accountRef,
      providerContactId: crmConversations.providerContactId,
      sentAt: crmConversationMessages.sentAt,
      idempotencyKey: crmConversationMessages.idempotencyKey,
      origin: sql<string | null>`${crmConversationMessages.raw}->>'origin'`,
      excerpt: sql<string>`left(${crmConversationMessages.bodyText}, 240)`,
    }).from(crmConversationMessages)
      .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
      .where(and(inOrg(crmConversations), inArray(crmConversations.crmRecordId, ids)))
      .orderBy(crmConversations.crmRecordId, crmConversationMessages.direction, desc(crmConversationMessages.sentAt), desc(crmConversationMessages.createdAt)),
    db.selectDistinctOn([crmDrafts.crmRecordId], {
      recordId: crmDrafts.crmRecordId, id: crmDrafts.id, status: crmDrafts.status,
      stepType: crmSequenceSteps.stepType, apologyRouteId: crmWrongRoutes.id,
    }).from(crmDrafts)
      .leftJoin(crmSequenceStepRuns, eq(crmSequenceStepRuns.id, crmDrafts.sequenceStepRunId))
      .leftJoin(crmSequenceSteps, eq(crmSequenceSteps.id, crmSequenceStepRuns.sequenceStepId))
      .leftJoin(crmWrongRoutes, and(inOrg(crmWrongRoutes), eq(crmWrongRoutes.ackDraftId, crmDrafts.id), inArray(crmWrongRoutes.ackStatus, ["drafted", "reserved"])))
      .where(and(inArray(crmDrafts.crmRecordId, scopedRecordIds), inArray(crmDrafts.status, ["awaiting_review", "failed", "delivery_uncertain"])))
      .orderBy(crmDrafts.crmRecordId, desc(crmDrafts.updatedAt)),
    db.selectDistinct({ recordId: crmDrafts.crmRecordId }).from(crmDrafts)
      .where(and(inArray(crmDrafts.crmRecordId, scopedRecordIds), eq(crmDrafts.status, "awaiting_review"))),
    db.selectDistinctOn([crmClassifications.crmRecordId], { recordId: crmClassifications.crmRecordId, status: crmClassifications.status })
      .from(crmClassifications).where(inArray(crmClassifications.crmRecordId, scopedRecordIds))
      .orderBy(crmClassifications.crmRecordId, desc(crmClassifications.createdAt)),
    db.select({ id: ownerDecisions.id, recordId: ownerDecisions.crmRecordId, kind: ownerDecisions.kind, status: ownerDecisions.status, createdAt: ownerDecisions.createdAt })
      .from(ownerDecisions)
      .where(and(inOrg(ownerDecisions), inArray(ownerDecisions.crmRecordId, ids), or(eq(ownerDecisions.status, "open"), inArray(ownerDecisions.kind, [...REPORT_KINDS]))))
      .orderBy(desc(ownerDecisions.createdAt)),
    db.select({ conversationId: autopilotTakeovers.conversationId }).from(autopilotTakeovers)
      .where(and(inOrg(autopilotTakeovers), inArray(autopilotTakeovers.conversationId, conversationIds))),
  ]);

  const inboundOf = new Map(latest.filter((row) => row.direction === "inbound").map((row) => [row.recordId, row]));
  const outboundOf = new Map(latest.filter((row) => row.direction === "outbound").map((row) => [row.recordId, row]));
  /** The conversation a reply would go to: the one the lead last wrote in, else the last one written to. */
  const conversationOf = (recordId: string) => inboundOf.get(recordId) ?? outboundOf.get(recordId) ?? null;
  const routesOf = new Map(records.map((record) => {
    const conversation = conversationOf(record.id);
    return [record.id, conversation ? candidateRoutes(conversation.channel, { providerContactId: conversation.providerContactId, email: record.email, phone: record.phone, linkedinUrl: record.linkedinUrl }) : []];
  }));
  const personIds = [...new Set(records.map((record) => record.personId))];
  const allRoutes = [...new Set([...routesOf.values()].flat())];
  const refsOf = (channel: string) => [...new Set(records.flatMap((record) => {
    const conversation = conversationOf(record.id);
    return conversation?.channel === channel ? [conversation.accountRef] : [];
  }))];
  const [whatsappRefs, instagramRefs, linkedinRefs] = [refsOf("whatsapp"), refsOf("instagram"), refsOf("linkedin")];

  const [memberships, wrongRoutes, whatsappRows, instagramRows, linkedinRows] = await Promise.all([
    personIds.length
      ? db.select({
        personId: outreachRunLeads.personId, channel: outreachRunLeads.channel, leadStatus: outreachRunLeads.status,
        runStatus: outreachRuns.status, automatic: outreachRuns.autopilot, plan: outreachRuns.plan,
      }).from(outreachRunLeads)
        .innerJoin(outreachRuns, and(eq(outreachRuns.id, outreachRunLeads.runId), inOrg(outreachRuns)))
        .where(and(inOrg(outreachRunLeads), inArray(outreachRunLeads.personId, personIds), inArray(outreachRuns.status, ["starting", "running", "paused", "stopped", "completed"])))
        .orderBy(desc(outreachRuns.createdAt))
      : Promise.resolve([]),
    personIds.length
      ? db.select({ channel: crmWrongRoutes.channel, route: crmWrongRoutes.route, personId: crmWrongRoutes.personId, ackStatus: crmWrongRoutes.ackStatus })
        .from(crmWrongRoutes)
        .where(and(inOrg(crmWrongRoutes), or(inArray(crmWrongRoutes.personId, personIds), allRoutes.length ? inArray(crmWrongRoutes.route, allRoutes) : undefined)))
      : Promise.resolve([]),
    whatsappRefs.length
      ? db.select({ ref: whatsappAccounts.unipileAccountId, name: whatsappAccounts.name, phone: whatsappAccounts.phone })
        .from(whatsappAccounts).where(and(inOrg(whatsappAccounts), inArray(whatsappAccounts.unipileAccountId, whatsappRefs)))
      : Promise.resolve([]),
    instagramRefs.length
      ? db.select({ ref: instagramAccounts.unipileAccountId, name: instagramAccounts.name, username: instagramAccounts.username })
        .from(instagramAccounts).where(and(inOrg(instagramAccounts), inArray(instagramAccounts.unipileAccountId, instagramRefs)))
      : Promise.resolve([]),
    linkedinRefs.length
      ? db.select({ ref: linkedInAccounts.linkedinId, name: linkedInAccounts.name, username: linkedInAccounts.username })
        .from(linkedInAccounts).where(and(inOrg(linkedInAccounts), inArray(linkedInAccounts.linkedinId, linkedinRefs)))
      : Promise.resolve([]),
  ]);

  const draftOf = new Map(drafts.map((row) => [row.recordId, row]));
  const awaitingOf = new Set(awaiting.map((row) => row.recordId));
  const classificationOf = new Map(classifications.map((row) => [row.recordId, row.status]));
  const takenOver = new Set(takeovers.map((row) => row.conversationId));
  const decisionsOf = new Map<string, SummaryDecision[]>();
  for (const decision of decisions) {
    if (!decision.recordId) continue;
    const list = decisionsOf.get(decision.recordId) ?? [];
    const report = (REPORT_KINDS as readonly string[]).includes(decision.kind);
    // Every open handoff, and the latest report only.
    if (report && list.some((item) => (REPORT_KINDS as readonly string[]).includes(item.kind))) continue;
    list.push({ id: decision.id, kind: decision.kind, status: decision.status, createdAt: decision.createdAt.toISOString() });
    decisionsOf.set(decision.recordId, list);
  }
  const accountLabel = (channel: string, ref: string): string => {
    switch (channel) {
      case "whatsapp": {
        const account = whatsappRows.find((row) => row.ref === ref);
        return account ? [account.name, account.phone].filter(Boolean).join(" · ") || "WhatsApp number" : "Unknown WhatsApp number";
      }
      case "instagram": {
        const account = instagramRows.find((row) => row.ref === ref);
        return account ? [account.name, account.username && `@${account.username}`].filter(Boolean).join(" · ") || "Instagram account" : "Unknown Instagram account";
      }
      case "linkedin": {
        const account = linkedinRows.find((row) => row.ref === ref);
        return account ? [account.name, account.username && `@${account.username}`].filter(Boolean).join(" · ") : "Unknown LinkedIn account";
      }
      default:
        return ref;
    }
  };
  const replyModeOf = (record: (typeof records)[number]): ReplyMode => {
    const conversation = conversationOf(record.id);
    if (!conversation) return "review";
    if (takenOver.has(conversation.conversationId)) return "takeover";
    // As runMembershipFor reads it: the person's newest run on this channel.
    const membership = memberships.find((row) => row.personId === record.personId && row.channel === conversation.channel);
    if (!membership || !runCoversConversation(membership.plan, conversation)) return "review";
    return membership.automatic && membership.runStatus === "running" && membership.leadStatus === "active" ? "automatic" : "review";
  };

  const summaries = new Map<string, ConversationSummary>();
  for (const record of records) {
    const inbound = inboundOf.get(record.id) ?? null;
    const outbound = outboundOf.get(record.id) ?? null;
    const conversation = conversationOf(record.id);
    const routes = routesOf.get(record.id) ?? [];
    const wrongRoute = conversation
      ? wrongRoutes.find((row) => row.channel === conversation.channel
        && (routes.includes(row.route) || ((row.channel === "linkedin" || row.channel === "instagram") && row.personId === record.personId))) ?? null
      : null;
    const draft = draftOf.get(record.id);
    const message = (row: NonNullable<typeof inbound>) => ({
      id: row.id, conversationId: row.conversationId, channel: row.channel, accountRef: row.accountRef,
      sentAt: row.sentAt.toISOString(), excerpt: row.excerpt.replace(/\s+/g, " ").trim(),
    });
    summaries.set(record.id, describeConversation({
      workflowState: record.workflowState,
      nextActionAt: record.nextActionAt,
      latestInbound: inbound ? message(inbound) : null,
      latestOutbound: outbound ? { ...message(outbound), idempotencyKey: outbound.idempotencyKey, origin: outbound.origin } : null,
      draft: draft ? { id: draft.id, status: draft.status, kind: draft.apologyRouteId ? "apology" : draft.stepType === "follow_up" ? "follow_up" : "reply" } : null,
      draftAwaitingReview: awaitingOf.has(record.id),
      classificationStatus: classificationOf.get(record.id) ?? null,
      decisions: decisionsOf.get(record.id) ?? [],
      replyMode: replyModeOf(record),
      account: conversation ? { channel: conversation.channel, ref: conversation.accountRef, label: accountLabel(conversation.channel, conversation.accountRef) } : null,
      doNotContact: record.doNotContact ?? false,
      wrongRoute: wrongRoute ? { channel: wrongRoute.channel, route: wrongRoute.route, ackStatus: wrongRoute.ackStatus } : null,
      now,
    }));
  }
  return summaries;
}

/** An inquiry run answers only the accounts and channels it names (autopilot.server.ts inquiryRunCoversConversation). */
function runCoversConversation(plan: OutreachPlan, conversation: { channel: string; accountRef: string }): boolean {
  if (plan.kind !== "inquiries") return true;
  const accounts = plan.inquiry?.accounts ?? [];
  return (plan.inquiry?.channels ?? []).includes(conversation.channel as "instagram")
    && accounts.some((account) => account.unipileAccountId === conversation.accountRef);
}
