import "server-only";

import { and, arrayContains, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { regenerateDraft } from "@/lib/crm/drafts";
import { createKnowledgeDocument, getKnowledgeDocument, updateKnowledgeDocument } from "@/lib/crm/knowledge-service";
import { crmDrafts, crmKnowledgeDocuments } from "@/lib/crm/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { autopilotTakeovers, ownerDecisions, type OwnerDecisionKind } from "./schema";
import { addMessage } from "./threads.server";

/**
 * Decisions only the owner can make, raised by the reply autopilot with the
 * reason and the decision needed, and what happens when they answer:
 * the answer is saved to the knowledge document "Answers you gave the
 * assistant" (always included in every later draft and check, so nobody
 * asks again), and the waiting reply is rewritten with it and checked
 * again — sent automatically if it now passes.
 */

const ANSWERS_TITLE = "Answers you gave the assistant";
const ANSWERS_TAGS = ["assistant", "owner-answers"];

export type NewDecision = {
  kind: OwnerDecisionKind;
  reason: string;
  decision: string;
  leadMessage?: string | null;
  personId?: string | null;
  crmRecordId?: string | null;
  conversationId?: string | null;
  draftId?: string | null;
  runId?: string | null;
  /** The run's chat, where the owner is told. */
  threadId?: string | null;
};

/** Opens a decision (once per draft and kind) and shows it in the run's chat; returns its id when new. */
export async function openDecision(input: NewDecision): Promise<string | null> {
  const [row] = await db.insert(ownerDecisions).values({
    organizationId: currentOrganizationId(),
    kind: input.kind,
    status: input.kind === "interested" || input.kind === "opt_out" ? "resolved" : "open",
    reason: input.reason.slice(0, 1_000),
    decision: input.decision.slice(0, 1_000),
    leadMessage: input.leadMessage?.slice(0, 4_000) ?? null,
    personId: input.personId ?? null,
    crmRecordId: input.crmRecordId ?? null,
    conversationId: input.conversationId ?? null,
    draftId: input.draftId ?? null,
    runId: input.runId ?? null,
  }).onConflictDoNothing().returning({ id: ownerDecisions.id });
  if (!row) return null;
  if (input.threadId) {
    await addMessage({
      threadId: input.threadId,
      role: "tool",
      tool: "owner_decision",
      toolInput: { decisionId: row.id },
      status: "ok",
      content: `${input.reason} ${input.decision}`,
      toolResult: { summary: `Decision needed (${input.kind}, id ${row.id}): ${input.reason} ${input.decision}`, data: { decisionId: row.id, kind: input.kind, reason: input.reason, decision: input.decision, leadMessage: input.leadMessage ?? null, crmRecordId: input.crmRecordId ?? null } },
    }).catch((error) => console.error("[assistant/decisions] could not post to the chat:", error));
  }
  return row.id;
}

export async function getDecision(id: string) {
  const [row] = await db.select().from(ownerDecisions).where(and(inOrg(ownerDecisions), eq(ownerDecisions.id, id))).limit(1);
  return row ?? null;
}

export async function listOpenDecisions(limit = 50) {
  return db.select().from(ownerDecisions)
    .where(and(inOrg(ownerDecisions), eq(ownerDecisions.status, "open")))
    .orderBy(desc(ownerDecisions.createdAt)).limit(limit);
}

/** Appends a question and its answer to the owner's answers document (created on first use). */
export async function saveOwnerAnswer(question: string, answer: string): Promise<string> {
  const entry = `Q: ${question.trim()}\nA: ${answer.trim()}`;
  const [existing] = await db.select({ id: crmKnowledgeDocuments.id }).from(crmKnowledgeDocuments)
    .where(and(inOrg(crmKnowledgeDocuments), arrayContains(crmKnowledgeDocuments.tags, ["owner-answers"]), eq(crmKnowledgeDocuments.active, true)))
    .limit(1);
  if (existing) {
    const document = await getKnowledgeDocument(existing.id);
    const latest = document.versions.at(-1)?.content ?? "";
    await updateKnowledgeDocument(existing.id, { content: `${latest.trim()}\n\n${entry}`.trim().slice(-200_000), alwaysInclude: true });
    return existing.id;
  }
  const created = await createKnowledgeDocument({ title: ANSWERS_TITLE, kind: "faq", tags: ANSWERS_TAGS, alwaysInclude: true, content: entry });
  return created.id;
}

export class DecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionError";
  }
}

/**
 * The owner answers a decision. The answer is saved for later
 * conversations; a reply still waiting is rewritten with it (its new
 * revision goes through the autopilot again, check and limits included).
 */
export async function answerDecision(id: string, answer: string, userId: string | null): Promise<{ saved: boolean; rewritten: boolean; problem: string | null }> {
  const decision = await getDecision(id);
  if (!decision) throw new DecisionError("That decision does not exist.");
  if (decision.status !== "open") throw new DecisionError("That decision was already settled.");
  const text = answer.trim();
  if (!text) throw new DecisionError("Write the answer.");
  await saveOwnerAnswer(decision.leadMessage ? `${decision.decision} (asked about: ${decision.leadMessage.slice(0, 300)})` : decision.decision, text);
  await db.update(ownerDecisions).set({ status: "answered", answer: text.slice(0, 4_000), answeredBy: userId, answeredAt: new Date(), updatedAt: new Date() })
    .where(and(inOrg(ownerDecisions), eq(ownerDecisions.id, id), eq(ownerDecisions.status, "open")));
  if (!decision.draftId) return { saved: true, rewritten: false, problem: null };
  const [draft] = await db.select({ status: crmDrafts.status }).from(crmDrafts).where(eq(crmDrafts.id, decision.draftId)).limit(1);
  if (!draft || !["awaiting_review", "failed"].includes(draft.status)) return { saved: true, rewritten: false, problem: null };
  try {
    await regenerateDraft(decision.draftId, {}, `The business owner answered the open question. Use this answer (it is now part of the business information): ${text}`);
    return { saved: true, rewritten: true, problem: null };
  } catch (error) {
    return { saved: true, rewritten: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The owner handles the conversation personally: the autopilot stays out of it from now on. */
export async function takeOverConversation(conversationId: string, userId: string | null, reason = "The owner is answering this conversation personally."): Promise<void> {
  await db.insert(autopilotTakeovers).values({ organizationId: currentOrganizationId(), conversationId, reason, createdBy: userId }).onConflictDoNothing();
  await db.update(ownerDecisions).set({ status: "resolved", updatedAt: new Date() })
    .where(and(inOrg(ownerDecisions), eq(ownerDecisions.conversationId, conversationId), eq(ownerDecisions.status, "open")));
}

export async function resolveDecision(id: string, options: { takeover: boolean; userId: string | null }): Promise<void> {
  const decision = await getDecision(id);
  if (!decision) throw new DecisionError("That decision does not exist.");
  if (options.takeover && decision.conversationId) await takeOverConversation(decision.conversationId, options.userId);
  await db.update(ownerDecisions).set({ status: "resolved", answeredBy: options.userId, updatedAt: new Date() })
    .where(and(inOrg(ownerDecisions), inArray(ownerDecisions.id, [id])));
}
