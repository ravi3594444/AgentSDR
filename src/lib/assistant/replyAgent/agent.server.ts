import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gt, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { completeStructured } from "@/lib/ai/server/structuredCompletion";
import { AUTOPILOT_ACTOR, AUTOPILOT_LIMITS } from "@/lib/crm/autopilot";
import { runMembershipFor } from "@/lib/crm/autopilot.server";
import { appendCrmEvent } from "@/lib/crm/events";
import { isPersonDoNotContact, setPersonDoNotContact } from "@/lib/crm/policies";
import { inboundAnsweredSince, settleAnsweredRecordInTransaction } from "@/lib/crm/manualOutbound";
import { lockCrmRecord, recordAiClassificationInTransaction } from "@/lib/crm/records";
import { withCrmTransaction, type CrmExecutor } from "@/lib/crm/repository";
import { crmConversationMessages, crmConversations, crmDrafts, crmRecords, crmSubcategories } from "@/lib/crm/schema";
import { sendDraft, type CrmSendAdapter } from "@/lib/crm/send";
import type { ReplyConversationMessage } from "@/lib/crm/ai/replyConversation";
import { closingAcknowledgement, detectsOptOutWording, detectsWrongNumber } from "@/lib/crm/wrongNumber";
import { closeWrongNumber, type CloseWrongNumberOutcome } from "@/lib/crm/wrongNumberAck.server";
import { wrongRouteForConversation } from "@/lib/crm/wrongRoutes";
import { companies, people } from "@/lib/leads/schema";
import { isSuppressed } from "@/lib/outreach/suppression";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { effectiveBusinessProfile } from "../businessContext.server";
import { openDecision } from "../decisions.server";
import { writeBrief } from "../handoff.server";
import { checkKnowledge } from "../replyCheck.server";
import { autopilotReplies, autopilotTakeovers, ownerDecisions, replyAgentRuns, type ReplyAgentStatus, type ReplyAgentTurn } from "../schema";
import { recordUsage } from "../usage.server";
import {
  agentSystemPrompt,
  agentUserPrompt,
  DECISION_SCHEMA,
  fallbackReply,
  hardStop,
  MAX_TURNS,
  ownerNoteToDecision,
  parseAgentDecision,
  replyProblems,
  wrongNumberClosing,
  type AgentChannel,
  type AgentDecision,
  type HardFacts,
} from "./agent";

/**
 * The reply agent's loop, run once for each message a lead of an assistant
 * outreach run sends (hooked into the CRM's classification job, so it starts
 * the moment the message is stored):
 *
 *   claim the message → hard rules → model turn → harness check → (feedback,
 *   next turn)… → act: send / draft / tell the owner / stop / nothing
 *
 * One model call answers a normal message. Only a reply with something that
 * must never go out (an invented price, day, time or link, a placeholder, a
 * claim that something was done) costs another turn, and the agent is told
 * exactly what to fix. After MAX_TURNS the lead gets an honest holding line
 * and the owner a card, so a lead is never left without an answer.
 *
 * Sends use the same path as a person's Approve & send (sendDraft: Do Not
 * Contact, duplicate protection) with a reservation under the organization's
 * lock that counts toward the same limits as the older autopilot. Every turn,
 * its time and the outcome are kept in reply_agent_runs.
 */

export type AgentModelResult = { text: string; provider?: string; model?: string; request?: unknown; response?: unknown; usage?: { inputTokens?: number; outputTokens?: number } };
export type AgentModel = (input: { systemPrompt: string; userPrompt: string }) => Promise<AgentModelResult>;

export type ReplyAgentDependencies = {
  /** A stand-in for the model (tests). */
  model?: AgentModel;
  send?: CrmSendAdapter;
  allowNonProduction?: boolean;
  /** Write the owner's brief with the model after a card opens (default: with the real model). */
  brief?: boolean;
};

export type ReplyAgentOutcome = {
  status: ReplyAgentStatus;
  reason: string | null;
  reply: string | null;
  ms: number;
  /** Someone answered the message before the agent got to it (the owner from their phone, say): nothing was sent, and the job settles the record. */
  answered?: boolean;
};

const MODEL_TIMEOUT_MS = 25_000;
/** A claim older than this with no result belongs to a job that died; the retry takes it over. */
const STALE_CLAIM_MS = 3 * 60_000;

function sendingAllowed(deps: ReplyAgentDependencies): boolean {
  return deps.allowNonProduction ?? (process.env.NODE_ENV === "production" || process.env.AUTOPILOT_ALLOW_NON_PRODUCTION === "true");
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

type Scope = {
  messageId: string;
  messageSentAt: Date;
  messageCreatedAt: Date;
  leadMessage: string;
  subject: string | null;
  recordId: string;
  pipelineId: string;
  contextVersion: number;
  latestInboundMessageId: string | null;
  conversationId: string;
  channel: string;
  personId: string;
};

async function loadScope(executor: CrmExecutor, messageId: string): Promise<Scope | null> {
  const [row] = await executor.select({ message: crmConversationMessages, conversation: crmConversations, record: crmRecords })
    .from(crmConversationMessages)
    .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
    .innerJoin(crmRecords, eq(crmRecords.id, crmConversations.crmRecordId))
    .where(and(inOrg(crmRecords), inOrg(crmConversations), eq(crmConversationMessages.id, messageId))).limit(1);
  if (!row || row.message.direction !== "inbound") return null;
  return {
    messageId,
    messageSentAt: row.message.sentAt,
    messageCreatedAt: row.message.createdAt,
    leadMessage: [row.message.subject ? `Subject: ${row.message.subject}` : null, row.message.bodyText ?? ""].filter(Boolean).join("\n").slice(0, 6_000),
    subject: row.message.subject,
    recordId: row.record.id,
    pipelineId: row.record.pipelineId,
    contextVersion: row.record.contextVersion,
    latestInboundMessageId: row.record.latestInboundMessageId,
    conversationId: row.conversation.id,
    channel: row.conversation.channel,
    personId: row.record.personId,
  };
}

type Facts = HardFacts & { membership: Awaited<ReturnType<typeof runMembershipFor>> };

/** Everything the hard rules read, from the given executor (the reservation reads it again under the lock). */
async function readFacts(executor: CrmExecutor, scope: Scope, email: string | null): Promise<Facts> {
  const organizationId = currentOrganizationId();
  const [record] = await executor.select({ latestInboundMessageId: crmRecords.latestInboundMessageId })
    .from(crmRecords).where(and(inOrg(crmRecords), eq(crmRecords.id, scope.recordId))).limit(1);
  const membership = await runMembershipFor(executor, scope.personId, scope.channel, scope.conversationId);
  const [takeover] = await executor.select({ id: autopilotTakeovers.id }).from(autopilotTakeovers)
    .where(and(inOrg(autopilotTakeovers), eq(autopilotTakeovers.conversationId, scope.conversationId))).limit(1);
  const [answered] = await executor.select({ n: count() }).from(crmConversationMessages)
    .where(and(eq(crmConversationMessages.conversationId, scope.conversationId), eq(crmConversationMessages.direction, "outbound"), gt(crmConversationMessages.sentAt, scope.messageSentAt)));
  const counted = inArray(autopilotReplies.status, ["reserved", "sent", "failed"]);
  const [inConversation] = await executor.select({ n: count() }).from(autopilotReplies)
    .where(and(eq(autopilotReplies.organizationId, organizationId), eq(autopilotReplies.conversationId, scope.conversationId), counted));
  const [inDay] = await executor.select({ n: count() }).from(autopilotReplies)
    .where(and(eq(autopilotReplies.organizationId, organizationId), gte(autopilotReplies.createdAt, new Date(Date.now() - 24 * 60 * 60_000)), counted));
  return {
    membership,
    doNotContact: await isPersonDoNotContact(executor, scope.personId),
    suppressed: scope.channel === "email" && email ? await isSuppressed(email) : false,
    newerInbound: Boolean(record?.latestInboundMessageId && record.latestInboundMessageId !== scope.messageId),
    answeredAlready: Number(answered?.n ?? 0) > 0,
    runInactive: !membership || membership.runStatus !== "running" || membership.leadStatus !== "active",
    takeover: Boolean(takeover),
    sentInConversation: Number(inConversation?.n ?? 0),
    sentInLast24h: Number(inDay?.n ?? 0),
    perConversation: AUTOPILOT_LIMITS.perConversation,
    perDay: AUTOPILOT_LIMITS.perDay,
  };
}

/** What the agent knows about the lead: who they are and the facts their list or search gave. */
function leadFacts(person: typeof people.$inferSelect | undefined, company: typeof companies.$inferSelect | null | undefined): Record<string, string> {
  const facts: Record<string, string> = {};
  if (!person) return facts;
  const name = person.fullName || [person.firstName, person.lastName].filter(Boolean).join(" ");
  if (name) facts.name = name;
  if (person.title) facts.title = person.title;
  if (company?.name) facts.company = company.name;
  if (company?.domain) facts.website = company.domain;
  for (const [key, value] of Object.entries(person.raw ?? {})) {
    if (Object.keys(facts).length >= 14) break;
    if (key in facts || /(^id$|Id$|_id$|token|secret|password)/i.test(key)) continue;
    if ((typeof value === "string" && value.trim() && value.length <= 200) || typeof value === "number" || typeof value === "boolean") facts[key] = String(value);
  }
  return facts;
}

async function finish(runRowId: string, scope: Scope, startedAt: number, values: { status: ReplyAgentStatus; reason?: string | null; action?: string | null; category?: string | null; reply?: string | null; turns?: ReplyAgentTurn[]; model?: string | null; draftId?: string | null; decisionId?: string | null }): Promise<ReplyAgentOutcome> {
  // From the message arriving here (stored), not from the provider's clock.
  const ms = Math.max(0, Date.now() - Math.min(startedAt, scope.messageCreatedAt.getTime()));
  await db.update(replyAgentRuns).set({
    status: values.status,
    reason: values.reason?.slice(0, 1_000) ?? null,
    action: values.action ?? null,
    category: values.category ?? null,
    reply: values.reply ?? null,
    ...(values.turns ? { turns: values.turns } : {}),
    model: values.model ?? null,
    draftId: values.draftId ?? null,
    decisionId: values.decisionId ?? null,
    totalMs: ms,
    updatedAt: new Date(),
  }).where(eq(replyAgentRuns.id, runRowId));
  return { status: values.status, reason: values.reason ?? null, reply: values.reply ?? null, ms };
}

/**
 * Someone answered the message while the agent was writing (the owner from
 * their phone, say): the agent's draft is set aside and the reply settles the
 * way a manual reply settles it, so nothing obsolete waits in Action
 * required. False when it was not answered (or a newer message took over).
 */
async function setAsideIfAnswered(scope: Scope, draftId: string): Promise<boolean> {
  return withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, scope.recordId);
    if (record.latestInboundMessageId !== scope.messageId || !(await inboundAnsweredSince(tx, record.id, scope.messageId))) return false;
    await tx.update(crmDrafts).set({ status: "stale", updatedAt: new Date() })
      .where(and(eq(crmDrafts.id, draftId), inArray(crmDrafts.status, ["generating", "awaiting_review", "failed"])));
    await settleAnsweredRecordInTransaction(tx, record, { reason: "answered_outside_crm", actorType: "system" });
    return true;
  });
}

/** A card in Needs you, once per conversation and kind while one is open. */
async function tellOwner(input: {
  scope: Scope; facts: Facts; leadName: string; kind: ReturnType<typeof ownerNoteToDecision>["kind"] | "limit"; note: string; decision: string; draftId: string | null; told: boolean; brief: boolean;
}): Promise<string | null> {
  const [open] = await db.select({ id: ownerDecisions.id }).from(ownerDecisions)
    .where(and(inOrg(ownerDecisions), eq(ownerDecisions.conversationId, input.scope.conversationId), eq(ownerDecisions.kind, input.kind), eq(ownerDecisions.status, "open"))).limit(1);
  if (open) return open.id;
  const id = await openDecision({
    kind: input.kind,
    reason: `${input.leadName}: ${input.note}`,
    decision: input.decision,
    leadMessage: input.scope.leadMessage,
    personId: input.scope.personId,
    crmRecordId: input.scope.recordId,
    conversationId: input.scope.conversationId,
    draftId: input.draftId,
    runId: input.facts.membership?.runId ?? null,
    threadId: input.facts.membership?.threadId ?? null,
  });
  if (!id) return null;
  if (input.told) await db.update(ownerDecisions).set({ handoverSentAt: new Date(), updatedAt: new Date() }).where(eq(ownerDecisions.id, id));
  // The brief is written after the lead has their answer; it never delays it.
  if (input.brief) void writeBrief(id).catch((error) => console.error("[reply-agent] brief failed:", error));
  return id;
}

function emailSubject(scope: Scope): string | null {
  if (scope.channel !== "email") return null;
  const subject = scope.subject?.trim() || "your message";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

async function wrongNumberSubcategoryId(pipelineId: string): Promise<string | null> {
  const [subcategory] = await db.select({ id: crmSubcategories.id }).from(crmSubcategories)
    .where(and(eq(crmSubcategories.pipelineId, pipelineId), eq(crmSubcategories.key, "wrong_number"), eq(crmSubcategories.active, true))).limit(1);
  return subcategory?.id ?? null;
}

/** How a closed wrong number reads in the agent's log: what happened to the one apology. */
function wrongNumberResult(closed: CloseWrongNumberOutcome | null) {
  return {
    action: "wrong_number",
    category: "other",
    status: (closed?.ackStatus === "sent" ? "replied" : closed?.ackStatus === "drafted" ? "drafted" : "stopped") as ReplyAgentStatus,
    reason: closed?.summary ?? "wrong number: nothing to record",
    reply: closed && ["sent", "drafted", "reserved", "sending", "failed", "uncertain"].includes(closed.ackStatus) ? closed.acknowledgement : null,
    draftId: closed?.draftId ?? null,
  };
}

/**
 * Answers one incoming message, or returns null when it is not the agent's
 * (not a lead of a running assistant run, the owner took the chat over, or
 * the lead may not be contacted): the CRM's classifier then handles it as
 * before.
 */
export async function runReplyAgent(messageId: string, deps: ReplyAgentDependencies = {}): Promise<ReplyAgentOutcome | null> {
  const startedAt = Date.now();
  const scope = await loadScope(db, messageId);
  if (!scope) return null;
  const [profileRow] = await db.select({ person: people, company: companies }).from(people)
    .leftJoin(companies, eq(companies.id, people.companyId))
    .where(and(inOrg(people), eq(people.id, scope.personId))).limit(1);
  const person = profileRow?.person;
  const facts = await readFacts(db, scope, person?.email ?? null);
  if (facts.runInactive || facts.takeover || facts.doNotContact || facts.suppressed) return null;
  // A route already recorded as a wrong number: nothing more goes to it,
  // and the classifier path files the message without a model.
  if (await wrongRouteForConversation(db, scope.conversationId)) return null;
  const membership = facts.membership!;

  // Claim the message: a retried job never answers twice.
  const organizationId = currentOrganizationId();
  const [claimed] = await db.insert(replyAgentRuns).values({
    organizationId,
    messageId,
    conversationId: scope.conversationId,
    personId: scope.personId,
    runId: membership.runId,
    status: "running",
  }).onConflictDoUpdate({
    target: replyAgentRuns.messageId,
    set: { status: "running", attempts: sql`${replyAgentRuns.attempts} + 1`, updatedAt: new Date() },
    setWhere: sql`${replyAgentRuns.organizationId} = ${organizationId} and (${replyAgentRuns.status} = 'failed' or (${replyAgentRuns.status} = 'running' and ${replyAgentRuns.updatedAt} < ${new Date(Date.now() - STALE_CLAIM_MS).toISOString()}::timestamptz))`,
  }).returning({ id: replyAgentRuns.id });
  if (!claimed) return { status: "stopped", reason: "this message is already being answered", reply: null, ms: 0 };
  const runRowId = claimed.id;
  const leadName = leadFacts(person, profileRow?.company).name || person?.email || person?.phone || "the lead";
  const brief = deps.brief ?? !deps.model;

  try {
    const stop = hardStop(facts);
    if (stop) {
      const answered = stop.answered ? { answered: true } : {};
      // "Wrong number" is still recorded, and outreach to the route stopped,
      // when a limit or an earlier answer keeps the agent from replying:
      // closeWrongNumber's own checks hold the apology for review (a limit)
      // or withhold it (already answered).
      if ((stop.tellOwner || stop.answered) && detectsWrongNumber(scope.leadMessage)) {
        const reasoning = `The message says it is a wrong number; the assistant did not answer it (${stop.reason}).`;
        const subcategoryId = await wrongNumberSubcategoryId(scope.pipelineId);
        const classified = await withCrmTransaction((tx) => recordAiClassificationInTransaction(tx, {
          recordId: scope.recordId,
          messageId,
          expectedContextVersion: scope.contextVersion,
          categoryKey: "other",
          subcategoryId,
          confidence: 0.6,
          reasoning,
          provider: "reply-agent",
          model: "reply-agent",
          request: { replyAgent: true, turns: 0 },
          response: { hardStop: stop.reason },
        }));
        if (classified.stale) return { ...(await finish(runRowId, scope, startedAt, { status: "stopped", reason: stop.reason, action: "wrong_number", category: "other" })), ...answered };
        const closed = await closeWrongNumber({
          messageId,
          source: "reply_agent",
          acknowledgement: null,
          optOut: detectsOptOutWording(scope.leadMessage),
          reasoning,
          sendAllowed: sendingAllowed(deps),
        }, { send: deps.send });
        return { ...(await finish(runRowId, scope, startedAt, wrongNumberResult(closed))), ...answered };
      }
      const decisionId = stop.tellOwner
        ? await tellOwner({ scope, facts, leadName, kind: "limit", note: stop.reason, decision: "Read the conversation and answer yourself.", draftId: null, told: false, brief })
        : null;
      return { ...(await finish(runRowId, scope, startedAt, { status: stop.tellOwner ? "told_owner" : "stopped", reason: stop.reason, decisionId })), ...answered };
    }

    // Context: the conversation before this message, the business, the lead.
    const history = await db.select({ direction: crmConversationMessages.direction, bodyText: crmConversationMessages.bodyText, channel: crmConversationMessages.channel })
      .from(crmConversationMessages)
      .where(and(eq(crmConversationMessages.conversationId, scope.conversationId), ne(crmConversationMessages.id, messageId), lte(crmConversationMessages.sentAt, scope.messageSentAt)))
      .orderBy(asc(crmConversationMessages.sentAt), asc(crmConversationMessages.id));
    const conversation: ReplyConversationMessage[] = history
      .filter((message) => message.bodyText?.trim())
      .slice(-20)
      .map((message) => ({ direction: message.direction as ReplyConversationMessage["direction"], bodyText: message.bodyText!.trim().slice(0, 2_000) }));
    const [profile, knowledge] = await Promise.all([effectiveBusinessProfile(), checkKnowledge(scope.leadMessage, conversation)]);
    const channel = scope.channel as AgentChannel;
    const systemPrompt = agentSystemPrompt({ channel, profile });
    const lead = leadFacts(person, profileRow?.company);

    const model: AgentModel = deps.model ?? (async (input) => {
      const result = await completeStructured({
        timeoutMs: MODEL_TIMEOUT_MS,
        maxOutputTokens: 1_500,
        maxAttempts: 2,
        schemaName: "reply_decision",
        schemaDescription: "Your decision for the lead's latest message.",
        jsonSchema: DECISION_SCHEMA,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        accept: (text) => void parseAgentDecision(text),
      });
      await recordUsage("reply_agent", result, membership.runId);
      return result;
    });

    // The loop: the agent decides, the harness checks, problems go back to the agent.
    const turns: ReplyAgentTurn[] = [];
    let decision: AgentDecision | null = null;
    let lastResult: AgentModelResult | null = null;
    let problems: string[] = [];
    let previousReply: string | null = null;
    for (let turn = 1; turn <= MAX_TURNS && !decision; turn += 1) {
      const began = Date.now();
      try {
        const result = await model({
          systemPrompt,
          userPrompt: agentUserPrompt({ channel, profile, knowledge, lead, conversation, leadMessage: scope.leadMessage, problems, previousReply, turn }),
        });
        lastResult = result;
        const parsed = parseAgentDecision(result.text);
        const found = parsed.action === "reply" ? replyProblems(parsed.reply, channel, knowledge) : [];
        // A wrong-number apology is not handed back: one that fails its check
        // is replaced by the fixed line in their language (closeWrongNumber).
        const replaced = parsed.action === "wrong_number" ? closingAcknowledgement(parsed.reply, scope.leadMessage, channel).problems : [];
        turns.push({ turn, ms: Date.now() - began, action: parsed.action, reply: parsed.reply || null, problems: [...found, ...replaced], error: null });
        if (found.length) {
          problems = found;
          previousReply = parsed.reply;
        } else {
          decision = parsed;
        }
      } catch (error) {
        turns.push({ turn, ms: Date.now() - began, action: null, reply: null, problems: [], error: errorText(error) });
      }
    }
    await db.update(replyAgentRuns).set({ turns, updatedAt: new Date() }).where(eq(replyAgentRuns.id, runRowId));

    // No usable answer for a message that plainly says "wrong number": close
    // it with the fixed apology, never a holding line that promises more.
    if (!decision && detectsWrongNumber(scope.leadMessage)) {
      decision = { action: "wrong_number", reply: "", ownerNote: null, category: "other", confidence: 0.6, reasoning: "The model gave no usable answer; the message says it is a wrong number." };
    }
    // No usable answer: an honest holding line for the lead (once a day per
    // chat, so a broken AI connection never repeats it), a card for the owner.
    if (!decision) {
      const modelFailed = !previousReply;
      const holding = fallbackReply(scope.leadMessage, profile.senderName ?? null);
      const [heldRecently] = await db.select({ id: replyAgentRuns.id }).from(replyAgentRuns)
        .where(and(eq(replyAgentRuns.organizationId, organizationId), eq(replyAgentRuns.conversationId, scope.conversationId), eq(replyAgentRuns.reply, holding), gte(replyAgentRuns.createdAt, new Date(Date.now() - 24 * 60 * 60_000)))).limit(1);
      decision = {
        action: heldRecently ? "tell_owner" : "reply",
        reply: heldRecently ? "" : holding,
        ownerNote: modelFailed
          ? { kind: "other", note: `the AI model gave no answer (${turns.at(-1)?.error ?? "no answer"}); the assistant sent a holding line` }
          : { kind: "question", note: `the assistant could not answer without guessing (${problems.join("; ")}); it sent a holding line` },
        category: "other",
        confidence: 0.3,
        reasoning: modelFailed ? "The model did not answer." : `Still unbacked after ${MAX_TURNS} tries: ${problems.join("; ")}`,
      };
    }
    const modelName = lastResult?.model ?? null;
    const closing = wrongNumberClosing(decision, scope.leadMessage);
    // A wrong number is filed as "Wrong Number" (other), never as a buyer's answer.
    const wrongNumberSubcategory = closing ? await wrongNumberSubcategoryId(scope.pipelineId) : null;

    // The CRM's view of the reply: the agent's reading of it.
    const classified = await withCrmTransaction((tx) => recordAiClassificationInTransaction(tx, {
      recordId: scope.recordId,
      messageId,
      expectedContextVersion: scope.contextVersion,
      categoryKey: closing ? "other" : decision!.action === "stop_contact" ? "not_interested" : decision!.category,
      subcategoryId: wrongNumberSubcategory,
      confidence: decision!.confidence,
      reasoning: decision!.reasoning || null,
      provider: lastResult?.provider ?? "reply-agent",
      model: modelName ?? "reply-agent",
      request: { replyAgent: true, turns: turns.length },
      response: lastResult?.response && typeof lastResult.response === "object" ? lastResult.response as Record<string, unknown> : { text: lastResult?.text ?? null },
    }));
    if (classified.stale) {
      const late = hardStop(await readFacts(db, scope, person?.email ?? null));
      return finish(runRowId, scope, startedAt, { status: "stopped", reason: late?.reason ?? "the conversation changed while the assistant was answering", action: decision.action, category: decision.category, turns, model: modelName });
    }
    const base = { action: decision.action, category: decision.category, turns, model: modelName };

    if (closing) {
      // Wrong number: the route is recorded and outreach to it stops first;
      // then the one closing apology is sent (Automatic) or drafted (Review),
      // unless an explicit opt-out, Do Not Contact or a takeover forbids it.
      const closed = await closeWrongNumber({
        messageId,
        source: "reply_agent",
        acknowledgement: decision.action === "wrong_number" ? decision.reply || null : null,
        optOut: closing.optOut,
        reasoning: decision.reasoning || null,
        sendAllowed: sendingAllowed(deps),
        provider: lastResult?.provider ?? "reply-agent",
        model: modelName ?? "reply-agent",
      }, { send: deps.send });
      return finish(runRowId, scope, startedAt, { ...base, ...wrongNumberResult(closed) });
    }

    if (decision.action === "stop_contact") {
      await setPersonDoNotContact({ personId: scope.personId, reason: `${decision.reasoning || "They asked not to be contacted"} (read in their reply)`.slice(0, 500), source: "inbound_request", actorType: "ai", actorRef: AUTOPILOT_ACTOR });
      return finish(runRowId, scope, startedAt, { ...base, status: "stopped", reason: "they asked not to be contacted: all outreach to them stopped" });
    }
    if (decision.action === "no_reply") {
      // Nothing to do for anyone: the record leaves Action required.
      await db.update(crmRecords).set({ workflowState: "idle", nextActionAt: null, updatedAt: new Date() })
        .where(and(eq(crmRecords.id, scope.recordId), eq(crmRecords.contextVersion, classified.record.contextVersion)));
      return finish(runRowId, scope, startedAt, { ...base, status: "no_reply", reason: decision.reasoning || "no answer needed" });
    }
    if (decision.action === "tell_owner") {
      const note = decision.ownerNote ?? { kind: "other" as const, note: decision.reasoning || "the assistant could not answer this" };
      const mapped = ownerNoteToDecision(note.kind);
      const decisionId = await tellOwner({ scope, facts, leadName, kind: mapped.kind, note: note.note, decision: mapped.decision, draftId: null, told: false, brief });
      return finish(runRowId, scope, startedAt, { ...base, status: "told_owner", reason: note.note, decisionId });
    }

    // reply: a draft (the record of what was written), then the send.
    const reply = decision.reply;
    const draft = await withCrmTransaction(async (tx) => {
      const record = await lockCrmRecord(tx, scope.recordId);
      const now = new Date();
      const [row] = await tx.insert(crmDrafts).values({
        crmRecordId: scope.recordId,
        conversationId: scope.conversationId,
        replyForMessageId: messageId,
        sequenceStepRunId: null,
        expectedContextVersion: record.contextVersion,
        channel: scope.channel as typeof crmDrafts.$inferInsert.channel,
        subject: emailSubject(scope),
        aiBodyText: reply,
        status: "awaiting_review",
        provider: lastResult?.provider ?? "reply-agent",
        model: modelName ?? "reply-agent",
        request: { replyAgent: true, replyContext: { messages: [...conversation, { direction: "inbound", bodyText: scope.leadMessage }] } },
        response: { decision: { action: decision!.action, reasoning: decision!.reasoning, ownerNote: decision!.ownerNote }, turns: turns.length },
      }).returning();
      await tx.update(crmRecords).set({ workflowState: "action_required", nextActionAt: now, updatedAt: now }).where(eq(crmRecords.id, record.id));
      await appendCrmEvent(tx, {
        personId: record.personId,
        crmRecordId: record.id,
        pipelineId: record.pipelineId,
        eventType: "draft.generated",
        actorType: "ai",
        actorRef: AUTOPILOT_ACTOR,
        toData: { draftId: row!.id, revision: row!.revision, sequenceStepRunId: null },
        meta: { provider: lastResult?.provider ?? null, model: modelName, replyAgent: true, turns: turns.length },
        contextVersion: record.contextVersion,
      });
      return row!;
    });

    const note = decision.ownerNote;
    const sendNow = membership.automatic && sendingAllowed(deps);
    const answeredMeanwhile = async () => ({
      ...(await finish(runRowId, scope, startedAt, { ...base, status: "stopped", reason: "it was already answered", reply, draftId: draft.id })),
      answered: true,
    });
    if (!sendNow) {
      if (await setAsideIfAnswered(scope, draft.id)) return answeredMeanwhile();
      const reason = membership.automatic ? "the assistant only sends from a production server" : "the run is in Review mode: the reply waits for you in Action required";
      const decisionId = note ? await tellOwner({ scope, facts, leadName, ...ownerNoteToDecision(note.kind), note: note.note, draftId: draft.id, told: false, brief }) : null;
      return finish(runRowId, scope, startedAt, { ...base, status: "drafted", reason, reply, draftId: draft.id, decisionId });
    }

    // Reserve under the organization's lock, after reading every rule again.
    const reservation = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`autopilot:${organizationId}`}, 0))`);
      const again = await readFacts(tx, scope, person?.email ?? null);
      const late = hardStop(again);
      if (late) return { held: late.reason, tellOwner: late.tellOwner } as const;
      const rows = await tx.insert(autopilotReplies).values({
        organizationId,
        draftId: draft.id,
        revision: draft.revision,
        conversationId: scope.conversationId,
        runId: membership.runId,
        personId: scope.personId,
        status: "reserved",
        reason: `reply agent (${turns.length} ${turns.length === 1 ? "turn" : "turns"})`,
      }).onConflictDoNothing().returning({ id: autopilotReplies.id });
      return rows[0] ? { id: rows[0].id } as const : { held: "this reply was already sent or is being sent", tellOwner: false } as const;
    });
    if ("held" in reservation) {
      if (await setAsideIfAnswered(scope, draft.id)) return answeredMeanwhile();
      const decisionId = reservation.tellOwner
        ? await tellOwner({ scope, facts, leadName, kind: "limit", note: reservation.held, decision: "Read the conversation and answer yourself.", draftId: draft.id, told: false, brief })
        : null;
      return finish(runRowId, scope, startedAt, { ...base, status: reservation.tellOwner ? "told_owner" : "stopped", reason: reservation.held, reply, draftId: draft.id, decisionId });
    }

    try {
      await sendDraft({
        draftId: draft.id,
        revision: draft.revision,
        idempotencyKey: `autopilot:agent:${messageId}`,
        requestId: randomUUID(),
        actorRef: AUTOPILOT_ACTOR,
      }, { send: deps.send });
      await db.update(autopilotReplies).set({ status: "sent", updatedAt: new Date() }).where(eq(autopilotReplies.id, reservation.id));
    } catch (error) {
      const text = errorText(error);
      await db.update(autopilotReplies).set({ status: "failed", reason: `the send failed: ${text}`.slice(0, 1_000), updatedAt: new Date() }).where(eq(autopilotReplies.id, reservation.id));
      const decisionId = await tellOwner({ scope, facts, leadName, kind: "uncertain", note: `the reply could not be sent (${text})`, decision: "Open the chat and send it yourself.", draftId: draft.id, told: false, brief });
      return finish(runRowId, scope, startedAt, { ...base, status: "failed", reason: `the send failed: ${text}`, reply, draftId: draft.id, decisionId });
    }
    // The reply went out; the owner hears about what needs them.
    const decisionId = note
      ? await tellOwner({ scope, facts, leadName, ...ownerNoteToDecision(note.kind), note: note.note, draftId: draft.id, told: note.kind === "ready" || note.kind === "person", brief })
      : null;
    return finish(runRowId, scope, startedAt, { ...base, status: "replied", reason: note ? `sent; the owner was told: ${note.note}` : null, reply, draftId: draft.id, decisionId });
  } catch (error) {
    await db.update(replyAgentRuns).set({ status: "failed", reason: errorText(error), updatedAt: new Date() }).where(eq(replyAgentRuns.id, runRowId))
      .catch(() => undefined);
    throw error;
  }
}
