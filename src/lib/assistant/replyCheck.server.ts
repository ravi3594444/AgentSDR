import "server-only";

import { db } from "@/lib/db";
import { completeStructured } from "@/lib/ai/server/structuredCompletion";
import { retrieveKnowledge } from "@/lib/crm/knowledge";
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
        required: ["question", "answered", "evidence"],
        properties: {
          question: { type: "string" },
          answered: { type: "boolean", description: "Whether the PROPOSED REPLY answers it." },
          evidence: { type: "string", description: "The exact words from BUSINESS INFORMATION that support the reply's answer, copied character for character; empty if none." },
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
    missing: { type: "string", description: "If the reply cannot fully and truthfully answer from BUSINESS INFORMATION, one short, specific question for the business owner whose answer would let it; otherwise empty." },
    escalate: { type: "string", description: "If a person should handle this (anger, a complaint, legal or medical advice, a negotiation beyond the information, anything unclear), the reason in one sentence; otherwise empty." },
  },
};

export type ReplyCheckInput = { leadMessage: string; reply: string; leadName: string };

/** The owner's information the check (and its quotes) work from: profile, saved answers, relevant documents. */
export async function checkKnowledge(leadMessage: string): Promise<string> {
  const profile = await getBusinessProfile();
  const selection = await retrieveKnowledge(db, { query: leadMessage.slice(0, 500) || null, maxTokens: 2_500, limit: 40 }).catch(() => null);
  const excerpts = (selection?.entries ?? [])
    .filter((entry) => !entry.tags.includes("business-profile"))
    .map((entry) => `### ${entry.title}\n${entry.excerpt}`);
  return [profileKnowledgeText(profile), ...excerpts].filter(Boolean).join("\n\n");
}

export async function modelReplyCheck(input: ReplyCheckInput & { knowledge: string; runId: string | null }): Promise<ModelCheck> {
  let parsed: ModelCheck | null = null;
  const result = await completeStructured({
    timeoutMs: 60_000,
    maxOutputTokens: 1_500,
    schemaName: "reply_check",
    schemaDescription: "Report what the lead asked and what the proposed reply claims and promises, with exact quotes.",
    jsonSchema: SCHEMA,
    systemPrompt: [
      "You check a reply an AI wrote for a business before it is sent automatically. You do not rewrite it.",
      "BUSINESS INFORMATION is everything the business has told us. Nothing else counts as known: not general knowledge, not what is typical for such businesses.",
      "Evidence must be copied exactly from BUSINESS INFORMATION (a phrase or sentence). Never paraphrase it. If nothing supports something, leave its evidence empty.",
      "List every question the lead asked, even implied ones (\"how much\", \"do you cover my area\", \"can you come Tuesday\").",
      "A question is answered only if BUSINESS INFORMATION states the answer itself. Something missing from a list does not answer whether it is offered: 'we service chairs and autoclaves' does not answer 'do you service X-ray machines?', in either direction. A reply that dodges the question, or says it will check, leaves it unanswered: mark answered false with empty evidence.",
      "A reply that only thanks them or asks them a question makes no claims. Greetings, the sender's name and a request to reply are not claims.",
    ].join("\n"),
    userPrompt: `BUSINESS INFORMATION:\n${input.knowledge || "(nothing saved)"}\n\nLEAD'S MESSAGE (from ${input.leadName || "the lead"}):\n${input.leadMessage}\n\nPROPOSED REPLY:\n${input.reply}`,
    accept: (text) => {
      const body = JSON.parse(text) as ModelCheck;
      if (!Array.isArray(body.questions) || !Array.isArray(body.claims) || !Array.isArray(body.commitments)) throw new Error("questions, claims and commitments must be arrays.");
      parsed = {
        intent: String(body.intent ?? "other"),
        questions: body.questions.map((item) => ({ question: String(item.question ?? ""), answered: Boolean(item.answered), evidence: String(item.evidence ?? "") })),
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
