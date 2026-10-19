import "server-only";

import { db } from "@/lib/db";
import { completeStructured } from "@/lib/ai/server/structuredCompletion";
import { retrieveKnowledge } from "@/lib/crm/knowledge";
import { recordUsage } from "./usage.server";
import { parseWriterReply, writerReplyInstructions, WRITER_REPLY_SCHEMAS } from "./writerReply";
import { CHANNEL_RULES, ensureSignOff, leadClaimProblem, personalLineProblem, personalMessageProblem, sequenceProblem, type LeadApproach } from "./messages";
import { lineClash, PERSONAL_LINE_LIMITS, pitchProblems } from "./pitch";
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
/**
 * Answers rejected for a pitch problem (pitch.ts) before the writer's best
 * attempt is kept anyway: a message that reads a little long must never
 * stop a plan. Hard problems (sequenceProblem) are always refused.
 */
const PITCH_RETRIES = 2;

/** The AI spend of one plan or start, accumulated; each call is also recorded in assistant_usage. */
export type WriterCost = { calls: number; usd: number | null; runId?: string | null };

async function addCost(cost: WriterCost, kind: "outreach_writing" | "personal_lines" | "lead_sorting", result: { model?: string; response?: unknown; usage?: { inputTokens?: number; outputTokens?: number } }) {
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

function sequencePrompt(input: { channels: AudienceChannel[]; personalizationKey: string; tokens: readonly string[]; signatureAppended: boolean; profile: BusinessProfile; instructions: string | null }) {
  const tokens = [...input.tokens, input.personalizationKey];
  const fields = input.tokens.filter((token) => token !== "company");
  return [
    "You write cold outreach for a business owner, as that owner, to businesses or people who have never heard of them.",
    "Write only from the BUSINESS INFORMATION below. Never invent facts, results, clients, prices, offers, links or credentials it does not state. If something is unknown, leave it out.",
    "Be brief, specific and human: no hype, no exclamation marks, no 'I hope this finds you well', no fake familiarity. One clear, low-effort call to action (a reply, a short call).",
    "Write to one busy person at the lead's business who gets many sales messages and owes the owner nothing. They read the first two lines on a phone and reply only when those lines are about them and the question is easy to answer.",
    "The first message, after the greeting and the lead's own line: (1) one problem that businesses like these leads commonly have and the owner's offer solves, in their everyday words, as a question or a plain observation; (2) one sentence on what the owner does about exactly that, naming only the one or two services that matter most to this kind of lead, never a list of everything the owner offers; (3) one question they can answer in a few words. Follow-ups are shorter and give one new reason to reply; never 'just following up' or 'bumping this'.",
    "The owner's style instructions set the tone, not a script: follow their spirit, use a word or phrase they quote at most once in the whole message, and never start two sentences the same way.",
    `Merge fields you may use, written exactly as shown, and no others: ${tokens.map((token) => `{{${token}}}`).join(", ")}.${input.tokens.includes("company") ? " {{company}} is the lead's business name." : ""}${fields.length ? ` ${fields.map((token) => `{{${token}}}`).join(" and ")} ${fields.length === 1 ? "is" : "are"} the lead's ${fields.join(" and ")}.` : ""} Every lead has a value for these.`,
    `{{${input.personalizationKey}}} is ONE sentence written separately for each lead from their public details (it may be empty). Put it alone on its own line right after the greeting in the first message, so the message reads well with or without it.`,
    input.tokens.includes("company")
      ? "Greet the business without a person's name (for example 'Hi {{company}} team,'), because most leads are businesses, not named people. {{company}} is the name as people say it, without 'Inc.' or 'LLC'."
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
  /** What a reader found wrong with the previous version (reviewFirstMessages), to fix in this one. */
  feedback?: string | null;
  /** Have the first messages read by a reviewer and rewritten once when they would likely be ignored (default on). */
  review?: boolean;
}): Promise<Partial<Record<AudienceChannel, PlannedStep[]>>> {
  const allowed = [...input.tokens, input.personalizationKey];
  let parsed: Partial<Record<AudienceChannel, PlannedStep[]>> = {};
  let answers = 0;
  /** The last answer refused only for pitch problems: kept if the retries then fail for another reason. */
  let fallback: Partial<Record<AudienceChannel, PlannedStep[]>> | null = null;
  const result = await completeStructured({
    timeoutMs: TIMEOUT_MS,
    maxOutputTokens: 3_000,
    maxAttempts: PITCH_RETRIES + 2,
    schemaName: "outreach_sequences",
    schemaDescription: "Submit the outreach messages for each channel.",
    jsonSchema: WRITER_REPLY_SCHEMAS.outreach_sequences,
    systemPrompt: sequencePrompt(input),
    userPrompt: [
      writerReplyInstructions("outreach_sequences"),
      `BUSINESS INFORMATION:\n${input.context || "(none given)"}`,
      `WHO WILL RECEIVE IT: ${input.audienceDescription}`,
      `Write the messages for: ${input.channels.join(", ")}.`,
      input.feedback ? `A READER WHO IS LIKE THESE LEADS READ YOUR PREVIOUS FIRST MESSAGES AND WOULD LIKELY IGNORE THEM:\n${input.feedback}\nWrite them again so this reader would answer. Keep to the business information; do not invent facts to make it stronger.` : null,
    ].filter(Boolean).join("\n\n"),
    accept: (text) => {
      answers += 1;
      const body = parseWriterReply(text, "outreach_sequences");
      const out: Partial<Record<AudienceChannel, PlannedStep[]>> = {};
      const pitch: string[] = [];
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
        // Checked on what the writer wrote, before the sign-off the code adds (a role and business name are not a list).
        pitch.push(...steps.flatMap((step, index) => pitchProblems(channel, step.body, { first: index === 0 }).map((found) => `${channel} message ${index + 1}: ${found}`)));
        out[channel] = signedSteps;
      }
      if (pitch.length && answers <= PITCH_RETRIES) {
        fallback = out;
        throw new Error(pitch.join("; "));
      }
      parsed = out;
    },
  }).catch((error: unknown) => {
    // A usable answer refused only for its pitch is better than no plan.
    if (fallback) {
      parsed = fallback;
      return null;
    }
    throw error;
  });
  if (result) await addCost(input.cost, "outreach_writing", result);
  if (input.review === false || input.feedback) return parsed;
  // A reader like the leads reads each first message; a likely-ignored one is rewritten once.
  const verdict = await reviewFirstMessages({ audienceDescription: input.audienceDescription, context: input.context, sequences: parsed, cost: input.cost })
    .catch((error) => {
      console.error("[assistant/writer] reviewing the first messages failed:", error);
      return null;
    });
  if (!verdict?.length) return parsed;
  try {
    const rewritten = await writeSequences({ ...input, feedback: verdict.join("\n"), review: false });
    return { ...parsed, ...rewritten };
  } catch (error) {
    console.error("[assistant/writer] rewriting after the review failed; keeping the first version:", error);
    return parsed;
  }
}

/** At or below this the reader would likely not answer, and the messages are rewritten once with the reasons. */
const REVIEW_REWRITE_AT = 3;

/**
 * A second model reads each first message as one of the leads would: a busy
 * owner of that kind of business who gets many sales messages. It returns
 * the reasons a likely-ignored message would be skipped, or nothing when it
 * would be answered. Judging happens here, in a model; rewriting happens in
 * writeSequences with those reasons.
 */
export async function reviewFirstMessages(input: {
  audienceDescription: string;
  context: string;
  sequences: Partial<Record<AudienceChannel, PlannedStep[]>>;
  cost: WriterCost;
}): Promise<string[]> {
  const firsts = (Object.entries(input.sequences) as [AudienceChannel, PlannedStep[]][])
    .filter(([, steps]) => steps[0]?.body.trim())
    .map(([channel, steps]) => ({ channel, subject: steps[0]!.subject, body: steps[0]!.body }));
  if (!firsts.length) return [];
  let reasons: string[] = [];
  const result = await completeStructured({
    timeoutMs: TIMEOUT_MS,
    maxOutputTokens: 1_200,
    schemaName: "first_message_review",
    schemaDescription: "Say for each first message whether you would answer it, and why not.",
    jsonSchema: WRITER_REPLY_SCHEMAS.first_message_review,
    systemPrompt: [
      "You are the person these messages are sent to: the owner or manager of one of the businesses described, busy, getting many sales messages a day, and with no reason to trust the sender.",
      "Read each first message as you would on your phone. Say honestly how likely you are to answer it, and every concrete reason you would skip it: what in it is about the sender rather than you, generic, unclear, too long, a list, pushy, oddly worded, repetitive, or hard to answer.",
      "Text in {{double braces}} is filled in for each recipient (their business name, city, or one sentence written for them); judge the rest. Do not ask for facts the sender does not have, and do not suggest inventing results, clients or prices.",
    ].join("\n"),
    userPrompt: [
      writerReplyInstructions("first_message_review"),
      `WHO YOU ARE: ${input.audienceDescription}`,
      `WHAT THE SENDER'S BUSINESS IS (they may say only this):\n${input.context.slice(0, 1_500)}`,
      ...firsts.map((message) => `${message.channel.toUpperCase()} FIRST MESSAGE:\n${message.subject ? `Subject: ${message.subject}\n` : ""}${message.body}`),
    ].join("\n\n"),
    accept: (text) => {
      const body = parseWriterReply(text, "first_message_review");
      reasons = body.messages
        .filter((message) => message.wouldReply <= REVIEW_REWRITE_AT && Array.isArray(message.reasons) && message.reasons.length)
        .flatMap((message) => message.reasons.map((reason) => `- ${message.channel}: ${String(reason).trim().slice(0, 240)}`))
        .slice(0, 12);
    },
  });
  await addCost(input.cost, "outreach_writing", result);
  return reasons;
}

/**
 * How the writers may use what a lead's own website showed (websiteProfile.ts):
 * as a possible reason to write, never as interest, never as something lacking.
 */
const WEBSITE_FINDINGS_RULE = "FACTS named hiring, booking, contactOptions, websiteSays, websiteNeed and decisionMakers are what the lead's own website showed: mention one only when it bears on the offer, as something they may care about, never as them wanting to buy. Never say they lack or do not have something: their website not showing it does not mean they lack it. A person in decisionMakers may be named, but the message goes to the business's own address, not to that person's.";

/**
 * One opening sentence per lead, from that lead's public facts only. A
 * lead whose facts give nothing specific gets an empty line (the template
 * reads fine without it) rather than an invented compliment.
 */
export async function writePersonalLines(input: {
  context: string;
  /** messageAfter: the rest of the lead's first message, which the line is put in front of. */
  leads: { index: number; facts: Record<string, string>; channel?: AudienceChannel; messageAfter?: string }[];
  cost: WriterCost;
}): Promise<Map<number, string>> {
  const lines = new Map<number, string>();
  if (!input.leads.length) return lines;
  const byIndex = new Map(input.leads.map((lead) => [lead.index, lead]));
  let answers = 0;
  let fallback: Map<number, string> | null = null;
  const result = await completeStructured({
    timeoutMs: TIMEOUT_MS,
    maxOutputTokens: 2_000,
    maxAttempts: PITCH_RETRIES + 2,
    schemaName: "opening_lines",
    schemaDescription: "Submit one opening line per lead.",
    jsonSchema: WRITER_REPLY_SCHEMAS.opening_lines,
    systemPrompt: [
      "For each lead, write ONE short opening sentence that shows the message was written for them, as the sender of cold outreach. Keep it within the length given for the lead (about 120 characters for a chat message, 200 for an email).",
      "Use only that lead's FACTS below (their kind of business, city, website, rating). Never invent anything about them: no made-up news, achievements, people or numbers.",
      WEBSITE_FINDINGS_RULE,
      "Do not praise generically and do not pitch; the rest of the message does that. If the facts give nothing specific, return an empty string for that lead.",
      "The line goes right before the MESSAGE AFTER it shown for the lead: it must read naturally in front of it, must not start the way that message's sentences start, and must not repeat its words. The owner's style applies to the message as a whole, so do not copy its opening words into the line.",
      "No placeholders, brackets or merge fields. Do not claim anything was sent or booked.",
    ].join("\n"),
    userPrompt: [
      writerReplyInstructions("opening_lines"),
      `THE SENDER'S BUSINESS (context only):\n${input.context.slice(0, 2_000)}`,
      "LEADS:",
      ...input.leads.map((lead) => [
        `${lead.index}${lead.channel ? ` (${lead.channel}, at most ${PERSONAL_LINE_LIMITS[lead.channel]} characters)` : ""}: ${JSON.stringify(lead.facts)}`,
        lead.messageAfter?.trim() ? `   MESSAGE AFTER IT: ${lead.messageAfter.replace(/\s+/g, " ").trim().slice(0, 600)}` : null,
      ].filter(Boolean).join("\n")),
    ].join("\n"),
    accept: (text) => {
      answers += 1;
      const body = parseWriterReply(text, "opening_lines");
      lines.clear();
      const clashes: string[] = [];
      for (const item of body.lines) {
        const line = item.line.trim();
        const problem = personalLineProblem(line);
        if (problem) throw new Error(`Lead ${item.index}: ${problem}.`);
        const lead = byIndex.get(item.index);
        const limit = lead?.channel ? PERSONAL_LINE_LIMITS[lead.channel] : null;
        const clash = line && lead?.messageAfter ? lineClash(line, lead.messageAfter) : null;
        const tooLong = line && limit && line.length > limit ? `keep it within ${limit} characters (it has ${line.length})` : null;
        // Something about the lead its facts do not back: rewritten, and past the retries left out.
        const unbacked = line && lead ? leadClaimProblem(line, lead.facts, input.context) : null;
        if (clash || tooLong || unbacked) {
          clashes.push(`Lead ${item.index}: ${[clash, tooLong, unbacked].filter(Boolean).join("; ")}.`);
          // Past the retries, a clashing line is left out: the message reads fine without it.
          lines.set(item.index, "");
          continue;
        }
        lines.set(item.index, line);
      }
      if (clashes.length && answers <= PITCH_RETRIES) {
        fallback = new Map(lines);
        throw new Error(clashes.join(" "));
      }
    },
  }).catch((error: unknown) => {
    // Clashing lines are already blank in the fallback: the messages read fine without them.
    if (fallback) {
      lines.clear();
      for (const [index, line] of fallback) lines.set(index, line);
      return null;
    }
    throw error;
  });
  if (result) await addCost(input.cost, "personal_lines", result);
  return lines;
}

/**
 * Sorts leads before outreach: what kind of lead each is (its group, which
 * gets its own messages), and how to approach it: the group's message
 * ("standard"), a first message written for it alone ("personal", when its
 * facts make that clearly better), or not at all ("skip", a clear misfit for
 * the owner's offer, with the reason). Unsure means standard.
 */
export async function sortLeads(input: {
  context: string;
  leads: { index: number; facts: Record<string, string> }[];
  knownGroups: readonly string[];
  cost: WriterCost;
}): Promise<Map<number, { group: string; approach: LeadApproach; reason: string }>> {
  const sorted = new Map<number, { group: string; approach: LeadApproach; reason: string }>();
  if (!input.leads.length) return sorted;
  const wanted = new Set(input.leads.map((lead) => lead.index));
  const result = await completeStructured({
    timeoutMs: TIMEOUT_MS,
    maxOutputTokens: 3_000,
    schemaName: "lead_sorting",
    schemaDescription: "Submit the group, approach and reason for every lead.",
    jsonSchema: WRITER_REPLY_SCHEMAS.lead_sorting,
    systemPrompt: [
      "You sort a business owner's leads before outreach, so each gets the right message. You do not write the messages.",
      "group: name the kind of lead in 2 to 4 words ('Real estate agents', 'Cleaning companies', 'Dental clinics'), the same words for leads of the same kind." + (input.knownGroups.length ? ` Reuse these names when they fit: ${input.knownGroups.map((group) => `'${group}'`).join(", ")}.` : ""),
      "approach 'standard': the group's message fits this lead. This is the default.",
      "approach 'personal': rare. Every standard message already opens with a line from the lead's address, rating and category, so choose 'personal' only when the facts show something particular to this lead that the group's message would miss (a specialty, a stated need, a detail from its website or title) and it fits the owner's offer well.",
      "approach 'skip': clearly not a fit for the owner's offer (a different kind of business, a competitor of the owner, closed, or obviously out of reach). Never skip only because little is known.",
      "reason: one short sentence the owner reads, based only on the facts given. Never invent facts about a lead. A finding from their own website (hiring, booking, websiteSays, websiteNeed, decisionMakers) is a reason they may fit, never a sign they want to buy: say 'may', never 'wants' or 'needs'.",
    ].join("\n"),
    userPrompt: [
      writerReplyInstructions("lead_sorting"),
      `THE OWNER'S BUSINESS:\n${input.context.slice(0, 2_500)}`,
      "LEADS:",
      ...input.leads.map((lead) => `${lead.index}: ${JSON.stringify(lead.facts)}`),
    ].join("\n"),
    accept: (text) => {
      const body = parseWriterReply(text, "lead_sorting");
      sorted.clear();
      for (const item of body.leads) {
        if (!wanted.has(item.index)) continue;
        sorted.set(item.index, { group: item.group.trim() || "Other", approach: item.approach, reason: item.reason.trim().slice(0, 240) });
      }
      const missing = [...wanted].filter((index) => !sorted.has(index));
      if (missing.length) throw new Error(`Sort every lead; missing: ${missing.slice(0, 10).join(", ")}.`);
    },
  });
  await addCost(input.cost, "lead_sorting", result);
  return sorted;
}

/**
 * First messages written for one lead each, from that lead's facts and the
 * owner's information, in the voice of the group's approved message. A
 * message that fails the checks is left out: that lead gets the group's
 * message instead.
 */
export async function writePersonalMessages(input: {
  context: string;
  profile: BusinessProfile;
  signatureAppended: boolean;
  instructions: string | null;
  leads: { index: number; channel: AudienceChannel; facts: Record<string, string>; groupMessage: string }[];
  cost: WriterCost;
}): Promise<Map<number, { subject: string | null; body: string }>> {
  const out = new Map<number, { subject: string | null; body: string }>();
  if (!input.leads.length) return out;
  let answers = 0;
  let fallback: Map<number, { subject: string | null; body: string }> | null = null;
  const result = await completeStructured({
    timeoutMs: TIMEOUT_MS,
    maxOutputTokens: 3_000,
    maxAttempts: PITCH_RETRIES + 2,
    schemaName: "personal_messages",
    schemaDescription: "Submit one first message per lead.",
    jsonSchema: WRITER_REPLY_SCHEMAS.personal_messages,
    systemPrompt: [
      "You write the FIRST cold outreach message to one lead at a time, as the business owner, for leads whose details make a tailored message worthwhile.",
      "Use only the BUSINESS INFORMATION and that lead's FACTS. Never invent facts, results, clients, prices, offers, links, news or compliments the facts do not support.",
      WEBSITE_FINDINGS_RULE,
      "Show in the first sentence or two that it was written for them (their kind of business, what they do, their area), then the offer in one or two sentences, then one low-effort question. No hype, no exclamation marks, no merge fields, brackets or placeholders.",
      "Keep the voice and offer of the GROUP MESSAGE you are given; only make it fit this lead better. Name the one or two services that matter most to this lead, never a list, start each sentence differently, and keep a chat message short enough to read on one phone screen.",
      input.signatureAppended
        ? "Email: do not add a sign-off name (the mailbox adds a signature); end with a short closing."
        : `Sign off with ${input.profile.senderName ?? "the sender's name"}${input.profile.businessName ? ` from ${input.profile.businessName}` : ""}.`,
      "Never claim anything was sent, booked, attached or agreed.",
      ...Object.entries(CHANNEL_RULES).filter(([channel]) => input.leads.some((lead) => lead.channel === channel)).map(([, rules]) => `- ${rules.describe} (this is the first message only)`),
      input.instructions ? `The owner's instructions for this outreach: ${input.instructions}` : null,
    ].filter(Boolean).join("\n"),
    userPrompt: [
      writerReplyInstructions("personal_messages"),
      `BUSINESS INFORMATION:\n${input.context || "(none given)"}`,
      "LEADS:",
      ...input.leads.map((lead) => `${lead.index} (${lead.channel}): FACTS ${JSON.stringify(lead.facts)}\nGROUP MESSAGE: ${lead.groupMessage.slice(0, 900)}`),
    ].join("\n\n"),
    accept: (text) => {
      answers += 1;
      const body = parseWriterReply(text, "personal_messages");
      out.clear();
      const pitch: string[] = [];
      for (const item of body.messages) {
        const lead = input.leads.find((candidate) => candidate.index === item.index);
        if (!lead) continue;
        const [signed] = ensureSignOff(lead.channel, [{ subject: CHANNEL_RULES[lead.channel].subject ? item.subject.trim() || null : null, body: item.body.trim(), waitDays: 0 }], input.profile, input.signatureAppended);
        if (personalMessageProblem(lead.channel, { subject: signed!.subject, body: signed!.body })) continue;
        const unbacked = leadClaimProblem(`${signed!.subject ?? ""}\n${item.body}`, lead.facts, input.context);
        // Past the retries, a message saying what the facts do not back is left out: the lead gets its group's.
        if (unbacked) {
          pitch.push(`Lead ${item.index}: ${unbacked}.`);
          continue;
        }
        const found = pitchProblems(lead.channel, item.body.trim(), { first: true });
        // A message still failing after the retries is left out: that lead gets the group's message.
        if (found.length) {
          pitch.push(`Lead ${item.index}: ${found.join("; ")}.`);
          continue;
        }
        out.set(item.index, { subject: signed!.subject, body: signed!.body });
      }
      if (pitch.length && answers <= PITCH_RETRIES) {
        fallback = new Map(out);
        throw new Error(pitch.join(" "));
      }
    },
  }).catch((error: unknown) => {
    // The messages that passed are kept; the others get their group's message.
    if (fallback) {
      out.clear();
      for (const [index, message] of fallback) out.set(index, message);
      return null;
    }
    throw error;
  });
  if (result) await addCost(input.cost, "outreach_writing", result);
  return out;
}
