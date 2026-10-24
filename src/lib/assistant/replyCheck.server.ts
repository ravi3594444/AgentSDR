import "server-only";

import { db } from "@/lib/db";
import { completeStructured, type CompletionBudget } from "@/lib/ai/server/structuredCompletion";
import { retrieveKnowledge } from "@/lib/crm/knowledge";
import type { ReplyConversationMessage } from "@/lib/crm/ai/replyConversation";
import { buildReplyCheckPrompt, type ReplyCheckInput } from "./replyCheckPrompt";
import { profileKnowledgeText } from "./profile";
import { getBusinessProfile } from "./profile.server";
import { REPLY_CHECK_INTENTS, type ModelCheck } from "./replyCheck";
import { recordUsage } from "./usage.server";

/**
 * The model half of the reply check (rules: replyCheck.ts). It reads the
 * owner's information, the lead's message and the AI's reply, and lists the
 * lead's questions, the reply's claims and promises, each with an exact
 * quote from the information. It judges nothing itself: judgeReply checks
 * every quote against the same information text.
 */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "questions", "claims", "commitments", "missing", "escalate"],
  properties: {
    intent: { type: "string", enum: [...REPLY_CHECK_INTENTS], description: "What the lead's message is mainly doing." },
    questions: {
      type: "array",
      description: "Every question or request in the LEAD'S MESSAGE (explicit or implied).",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "answered", "evidence", "clarification"],
        properties: {
          question: { type: "string" },
          answered: { type: "boolean", description: "Whether the PROPOSED REPLY answers it." },
          evidence: { type: "string", description: "The exact words from BUSINESS INFORMATION that support the reply's answer, copied character for character; empty if none." },
          clarification: { type: "string", description: "Copy the exact question in PROPOSED REPLY that asks the lead to specify their own needs or an ambiguous reference. Empty when none, or when the missing information is a business fact the owner must supply." },
        },
      },
    },
    claims: {
      type: "array",
      description: "Every statement in the PROPOSED REPLY about the business: what it offers, prices, areas served, timings, results, policies, or something done.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "evidence"],
        properties: { claim: { type: "string" }, evidence: { type: "string", description: "Exact supporting words from BUSINESS INFORMATION, or empty." } },
      },
    },
    commitments: {
      type: "array",
      description: "Everything the PROPOSED REPLY promises or offers to do: a discount, a price, a visit, a call at a time, sending a document, a guarantee.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["commitment", "evidence"],
        properties: { commitment: { type: "string" }, evidence: { type: "string", description: "Exact words from BUSINESS INFORMATION that allow it, or empty." } },
      },
    },
    missing: { type: "string", description: "A specific BUSINESS FACT only the owner can supply to answer a factual question. Empty for greetings, ordinary chat and details the lead can clarify about their own needs." },
    escalate: { type: "string", description: "If a person must handle this (a complaint, legal or medical advice, a negotiation beyond the information), the reason. For ready or wants_person, what the lead wants. Empty for greetings, short replies and ambiguous references the lead can clarify." },
  },
};

export type { ReplyCheckInput } from "./replyCheckPrompt";

/** The owner's information the check (and its quotes) work from: profile, saved answers, relevant documents. */
export async function checkKnowledge(leadMessage: string, conversation: readonly ReplyConversationMessage[] = []): Promise<string> {
  const profile = await getBusinessProfile();
  // Short follow-ups keep the topic of the preceding exchange when searching.
  const query = [leadMessage, ...conversation.slice(-4).reverse().map((message) => message.bodyText)].join("\n").slice(0, 1_500);
  const selection = await retrieveKnowledge(db, { query: query || null, maxTokens: 2_500, limit: 40 }).catch(() => null);
  const excerpts = (selection?.entries ?? [])
    .filter((entry) => !entry.tags.includes("business-profile"))
    .map((entry) => `### ${entry.title}\n${entry.excerpt}`);
  return [profileKnowledgeText(profile), ...excerpts].filter(Boolean).join("\n\n");
}

export async function modelReplyCheck(input: ReplyCheckInput & { knowledge: string; runId: string | null; budget?: CompletionBudget; signal?: AbortSignal }): Promise<ModelCheck> {
  let parsed: ModelCheck | null = null;
  const result = await completeStructured({
    timeoutMs: 60_000,
    maxOutputTokens: 1_500,
    budget: input.budget,
    signal: input.signal,
    schemaName: "reply_check",
    schemaDescription: "Report what the lead asked and what the proposed reply claims and promises, with exact quotes.",
    jsonSchema: SCHEMA,
    ...buildReplyCheckPrompt(input),
    accept: (text) => {
      const body = JSON.parse(text) as ModelCheck;
      if (!Array.isArray(body.questions) || !Array.isArray(body.claims) || !Array.isArray(body.commitments)) throw new Error("questions, claims and commitments must be arrays.");
      parsed = {
        intent: String(body.intent ?? "other"),
        questions: body.questions.map((item) => ({ question: String(item.question ?? ""), answered: Boolean(item.answered), evidence: String(item.evidence ?? ""), clarification: String(item.clarification ?? "") })),
        claims: body.claims.map((item) => ({ claim: String(item.claim ?? ""), evidence: String(item.evidence ?? "") })),
        commitments: body.commitments.map((item) => ({ commitment: String(item.commitment ?? ""), evidence: String(item.evidence ?? "") })),
        missing: String(body.missing ?? ""),
        escalate: String(body.escalate ?? ""),
      };
    },
  });
  await recordUsage("reply_check", result, input.runId);
  return parsed as unknown as ModelCheck;
}
