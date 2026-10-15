import "server-only";

import { db } from "@/lib/db";
import { completeStructured } from "@/lib/ai/server/structuredCompletion";
import { retrieveKnowledge } from "@/lib/crm/knowledge";
import { recordUsage } from "./usage.server";
import { CHANNEL_RULES, ensureSignOff, personalLineProblem, sequenceProblem } from "./messages";
import { profileKnowledgeText } from "./profile";
import type { AudienceChannel, BusinessProfile, PlannedStep } from "./schema";

/**
 * The AI that writes outreach: one sequence per channel from the owner's
 * business profile and knowledge, and one opening line per lead from that
 * lead's public facts. Both go through completeStructured on the
 * organization's AI provider; every result is checked (messages.ts) and a
 * rejected one is retried with the reason. Nothing here sends.
 */

const TIMEOUT_MS = 90_000;

/** The AI spend of one plan or start, accumulated; each call is also recorded in assistant_usage. */
export type WriterCost = { calls: number; usd: number | null; runId?: string | null };

async function addCost(cost: WriterCost, kind: "outreach_writing" | "personal_lines", result: { model?: string; response?: unknown; usage?: { inputTokens?: number; outputTokens?: number } }) {
  cost.calls += 1;
  const usd = await recordUsage(kind, result, cost.runId ?? null);
  if (usd !== null) cost.usd = (cost.usd ?? 0) + usd;
}

/** The owner's knowledge for prompts: the profile, then the most relevant document excerpts. */
export async function businessContext(profile: BusinessProfile): Promise<string> {
  const query = [profile.offer, profile.targetCustomers].filter(Boolean).join(" ").slice(0, 500) || null;
  const selection = await retrieveKnowledge(db, { query, maxTokens: 1_500, limit: 30 }).catch(() => null);
  const excerpts = (selection?.entries ?? [])
    .filter((entry) => !entry.tags.includes("business-profile"))
    .map((entry) => `### ${entry.title}\n${entry.excerpt}`);
  return [profileKnowledgeText(profile), ...excerpts].filter(Boolean).join("\n\n");
}

const SEQUENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["channels"],
  properties: {
    channels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["channel", "messages"],
        properties: {
          channel: { type: "string", enum: ["email", "whatsapp", "linkedin"] },
          messages: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["subject", "body", "waitDays"],
              properties: {
                subject: { type: "string", description: "Email only; an empty string elsewhere and for a follow-up that replies in the same thread." },
                body: { type: "string" },
                waitDays: { type: "integer", description: "Days after the previous message; 0 for the first." },
              },
            },
          },
        },
      },
    },
  },
};

function sequencePrompt(input: { channels: AudienceChannel[]; personalizationKey: string; tokens: readonly string[]; signatureAppended: boolean; profile: BusinessProfile; instructions: string | null }) {
  const tokens = [...input.tokens, input.personalizationKey];
  const fields = input.tokens.filter((token) => token !== "company");
  return [
    "You write cold outreach for a business owner, as that owner, to businesses or people who have never heard of them.",
    "Write only from the BUSINESS INFORMATION below. Never invent facts, results, clients, prices, offers, links or credentials it does not state. If something is unknown, leave it out.",
    "Be brief, specific and human: no hype, no exclamation marks, no 'I hope this finds you well', no fake familiarity. One clear, low-effort call to action (a reply, a short call).",
    `Merge fields you may use, written exactly as shown, and no others: ${tokens.map((token) => `{{${token}}}`).join(", ")}.${input.tokens.includes("company") ? " {{company}} is the lead's business name." : ""}${fields.length ? ` ${fields.map((token) => `{{${token}}}`).join(" and ")} ${fields.length === 1 ? "is" : "are"} the lead's ${fields.join(" and ")}.` : ""} Every lead has a value for these.`,
    `{{${input.personalizationKey}}} is ONE sentence written separately for each lead from their public details (it may be empty). Put it alone on its own line right after the greeting in the first message, so the message reads well with or without it.`,
    input.tokens.includes("company")
      ? "Greet the business without a person's name (for example 'Hi {{company}} team,'), because most leads are businesses, not named people."
      : "Greet simply ('Hi,' or 'Hello,'): these leads have no business name on record, and you do not know their names.",
    input.signatureAppended
      ? "Do not add a sign-off name: the sender's email signature is added automatically. End with a short closing such as 'Best regards,'."
      : `Sign off with the sender's name${input.profile.senderName ? ` (${input.profile.senderName}${input.profile.senderRole ? `, ${input.profile.senderRole}` : ""})` : ""}${input.profile.businessName ? ` and the business name (${input.profile.businessName})` : ""}.`,
    "Never claim anything was sent, booked, attached or agreed. Never use brackets or placeholders.",
    input.instructions ? `The owner's instructions for this outreach: ${input.instructions}` : null,
    input.profile.outreachInstructions ? `The owner's standing outreach instructions: ${input.profile.outreachInstructions}` : null,
    "Channels to write for:",
    ...input.channels.map((channel) => `- ${CHANNEL_RULES[channel].describe}`),
  ].filter(Boolean).join("\n");
}

export async function writeSequences(input: {
  profile: BusinessProfile;
  context: string;
  channels: AudienceChannel[];
  personalizationKey: string;
  signatureAppended: boolean;
  instructions: string | null;
  audienceDescription: string;
  /** The merge fields every lead of the run has (messages.ts availableTokens). */
  tokens: readonly string[];
  cost: WriterCost;
}): Promise<Partial<Record<AudienceChannel, PlannedStep[]>>> {
  const allowed = [...input.tokens, input.personalizationKey];
  let parsed: Partial<Record<AudienceChannel, PlannedStep[]>> = {};
  const result = await completeStructured({
    timeoutMs: TIMEOUT_MS,
    maxOutputTokens: 3_000,
    schemaName: "outreach_sequences",
    schemaDescription: "Submit the outreach messages for each channel.",
    jsonSchema: SEQUENCE_SCHEMA,
    systemPrompt: sequencePrompt(input),
    userPrompt: [
      `BUSINESS INFORMATION:\n${input.context || "(none given)"}`,
      `WHO WILL RECEIVE IT: ${input.audienceDescription}`,
      `Write the messages for: ${input.channels.join(", ")}.`,
    ].join("\n\n"),
    accept: (text) => {
      const body = JSON.parse(text) as { channels: { channel: AudienceChannel; messages: { subject: string; body: string; waitDays: number }[] }[] };
      const out: Partial<Record<AudienceChannel, PlannedStep[]>> = {};
      for (const channel of input.channels) {
        const entry = body.channels.find((item) => item.channel === channel);
        if (!entry) throw new Error(`Write the ${channel} messages too.`);
        const steps: PlannedStep[] = entry.messages.map((message, index) => ({
          subject: CHANNEL_RULES[channel].subject ? (message.subject.trim() || null) : null,
          body: message.body.trim(),
          waitDays: index === 0 ? 0 : Math.max(1, Math.min(30, Math.round(message.waitDays || CHANNEL_RULES[channel].defaultWaits[index] || 3))),
        }));
        if (channel === "linkedin" && steps[1]) steps[1].waitDays = 0;
        const signedSteps = ensureSignOff(channel, steps, input.profile, input.signatureAppended);
        const problem = sequenceProblem(channel, signedSteps, allowed);
        if (problem) throw new Error(problem);
        out[channel] = signedSteps;
      }
      parsed = out;
    },
  });
  await addCost(input.cost, "outreach_writing", result);
  return parsed;
}

const LINES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lines"],
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "line"],
        properties: { index: { type: "integer" }, line: { type: "string" } },
      },
    },
  },
};

/**
 * One opening sentence per lead, from that lead's public facts only. A
 * lead whose facts give nothing specific gets an empty line (the template
 * reads fine without it) rather than an invented compliment.
 */
export async function writePersonalLines(input: {
  context: string;
  leads: { index: number; facts: Record<string, string> }[];
  cost: WriterCost;
}): Promise<Map<number, string>> {
  const lines = new Map<number, string>();
  if (!input.leads.length) return lines;
  const result = await completeStructured({
    timeoutMs: TIMEOUT_MS,
    maxOutputTokens: 2_000,
    schemaName: "opening_lines",
    schemaDescription: "Submit one opening line per lead.",
    jsonSchema: LINES_SCHEMA,
    systemPrompt: [
      "For each lead, write ONE short opening sentence (under 200 characters) that shows the message was written for them, as the sender of cold outreach.",
      "Use only that lead's FACTS below (their kind of business, city, website, rating). Never invent anything about them: no made-up news, achievements, people or numbers.",
      "Do not praise generically and do not pitch; the rest of the message does that. If the facts give nothing specific, return an empty string for that lead.",
      "No placeholders, brackets or merge fields. Do not claim anything was sent or booked.",
    ].join("\n"),
    userPrompt: [
      `THE SENDER'S BUSINESS (context only):\n${input.context.slice(0, 2_000)}`,
      "LEADS:",
      ...input.leads.map((lead) => `${lead.index}: ${JSON.stringify(lead.facts)}`),
    ].join("\n"),
    accept: (text) => {
      const body = JSON.parse(text) as { lines: { index: number; line: string }[] };
      lines.clear();
      for (const item of body.lines) {
        const line = item.line.trim();
        const problem = personalLineProblem(line);
        if (problem) throw new Error(`Lead ${item.index}: ${problem}.`);
        lines.set(item.index, line);
      }
    },
  });
  await addCost(input.cost, "personal_lines", result);
  return lines;
}
