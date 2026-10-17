import { draftLeaks, draftPlaceholders, unverifiedActionClaims } from "@/lib/crm/ai/grounding";
import type { AudienceChannel, BusinessProfile, PlannedStep } from "./schema";

/**
 * Rules for the outreach the assistant writes: which merge tokens a
 * template may use, what each channel allows, and the checks every message
 * passes before anyone sees it (the same placeholder, leak and false-claim
 * checks CRM reply drafts pass). Pure, so the rules are unit-tested.
 */

/** Merge fields a lead found on Maps has; a typed or imported contact may lack any of them. */
export const BASE_TOKENS = ["company", "city", "category"] as const;

/**
 * The merge fields every lead of a run has a value for: only these may be
 * written into its messages, so no lead gets "Hi  team" or "in  ," with a
 * blank where a field was.
 */
export function availableTokens(leadValues: readonly Record<string, string | undefined>[]): string[] {
  if (!leadValues.length) return [];
  return BASE_TOKENS.filter((token) => leadValues.every((values) => Boolean(values[token]?.trim())));
}

export const CHANNEL_RULES: Record<AudienceChannel, { steps: number; maxBody: number; subject: boolean; waitUnit: "days"; defaultWaits: number[]; describe: string }> = {
  email: {
    steps: 3,
    maxBody: 1_200,
    subject: true,
    waitUnit: "days",
    defaultWaits: [0, 3, 5],
    describe: "Email: a first message and two follow-ups. Each has a short subject (follow-ups may leave the subject empty to reply in the same thread) and a plain-text body of 60–140 words. No links unless the owner's information has them; an unsubscribe line is added automatically.",
  },
  whatsapp: {
    steps: 2,
    maxBody: 600,
    subject: false,
    waitUnit: "days",
    defaultWaits: [0, 3],
    describe: "WhatsApp: a first message and one follow-up, each under 400 characters, conversational, no subject, no formatting, one clear question.",
  },
  linkedin: {
    steps: 3,
    maxBody: 600,
    subject: false,
    waitUnit: "days",
    defaultWaits: [0, 0, 4],
    describe: "LinkedIn: a connection invitation note under 280 characters, a message sent when they accept, and one follow-up, each under 500 characters, no subject.",
  },
  instagram: {
    steps: 1,
    maxBody: 600,
    subject: false,
    waitUnit: "days",
    defaultWaits: [0],
    describe: "Instagram: one initial direct message under 400 characters, conversational, no subject or formatting, one clear question. Do not write unsolicited follow-ups; replies use the run's Automatic or Review mode.",
  },
};

/** Tokens written as {{name}} in a template. */
export function templateTokens(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^{}\r\n]+?)\s*\}\}/g)].map((match) => match[1]!.trim());
}

/** Why a generated template cannot be used, or null. */
export function templateProblem(text: string, allowedTokens: readonly string[]): string | null {
  const allowed = new Set(allowedTokens.map((token) => token.toLowerCase()));
  const unknown = templateTokens(text).filter((token) => !allowed.has(token.toLowerCase()));
  if (unknown.length) return `It uses merge fields that do not exist (${[...new Set(unknown)].map((token) => `{{${token}}}`).join(", ")}). Use only ${allowedTokens.map((token) => `{{${token}}}`).join(", ")}, or write the text out.`;
  const withoutTokens = text.replace(/\{\{\s*[^{}\r\n]+?\s*\}\}/g, "");
  const placeholders = draftPlaceholders(withoutTokens);
  if (placeholders.length) return `It contains placeholders (${placeholders.slice(0, 3).map((p) => `"${p}"`).join(", ")}). Write the final words; leave out anything unknown.`;
  const leaks = draftLeaks(withoutTokens);
  if (leaks.length) return `It talks about the writing instructions (${leaks.slice(0, 2).map((l) => `"${l}"`).join(", ")}) instead of to the recipient.`;
  const claims = unverifiedActionClaims(withoutTokens, []);
  if (claims.length) return `It claims something was already done (${claims.slice(0, 2).map((c) => `"${c}"`).join("; ")}); nothing has been sent, booked or attached yet.`;
  return null;
}

/** Why a sequence for a channel cannot be used, or null. Steps keep their order. */
export function sequenceProblem(channel: AudienceChannel, steps: readonly PlannedStep[], allowedTokens: readonly string[]): string | null {
  const rules = CHANNEL_RULES[channel];
  if (steps.length < 1 || steps.length > rules.steps) return `${channel} needs 1 to ${rules.steps} messages.`;
  for (const [index, step] of steps.entries()) {
    const label = `${channel} message ${index + 1}`;
    if (!step.body.trim()) return `${label} is empty.`;
    if (step.body.length > rules.maxBody) return `${label} is ${step.body.length} characters; keep it under ${rules.maxBody}.`;
    if (channel === "linkedin" && index === 0 && step.body.length > 280) return "The LinkedIn invitation note must be under 280 characters (LinkedIn's limit is 300).";
    if (rules.subject && index === 0 && !step.subject?.trim()) return "The first email needs a subject.";
    if (!rules.subject && step.subject) return `${label} must not have a subject.`;
    const problem = templateProblem(`${step.subject ?? ""}\n${step.body}`, allowedTokens);
    if (problem) return `${label}: ${problem}`;
  }
  return null;
}

/** Why a per-lead opening line cannot be used, or null. */
export function personalLineProblem(line: string): string | null {
  const text = line.trim();
  if (!text) return null; // an empty line is allowed: the template reads fine without it
  if (text.length > 280) return "keep it under 280 characters";
  if (/\{\{|\}\}|\[|\]/.test(text)) return "no merge fields or brackets";
  if (draftPlaceholders(text).length) return "no placeholders";
  if (draftLeaks(text).length) return "write to the recipient, not about the instructions";
  if (unverifiedActionClaims(text, []).length) return "do not claim anything was sent, booked or attached";
  return null;
}

/** A short, safe merge key for a run's per-lead line: "p_1a2b3c4d". */
export function personalizationKey(runId: string): string {
  return `p_${runId.replace(/-/g, "").slice(0, 8)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every email ends with the sender's name, and the first WhatsApp message
 * says who is writing (the recipient sees only a number), whatever the model
 * wrote: a sign-off is added where the name is missing near the end. Skipped
 * for email when the mailbox appends its own signature, and when no sender
 * name is known. LinkedIn shows the sender's profile, so it is left alone.
 */
export function ensureSignOff(
  channel: AudienceChannel,
  steps: readonly PlannedStep[],
  profile: Pick<BusinessProfile, "senderName" | "senderRole" | "businessName">,
  signatureAppended: boolean,
): PlannedStep[] {
  const name = profile.senderName?.trim();
  if (!name || channel === "linkedin" || (channel === "email" && signatureAppended)) return [...steps];
  const firstName = name.split(/\s+/)[0]!;
  const signed = new RegExp(`\\b${escapeRegExp(firstName)}\\b`, "i");
  const business = profile.businessName?.trim();
  return steps.map((step, index) => {
    if (channel === "whatsapp" && index > 0) return step;
    const tail = step.body.slice(-200);
    if (signed.test(channel === "whatsapp" ? step.body : tail)) return step;
    const signOff = channel === "email"
      ? [name, [profile.senderRole?.trim(), business].filter(Boolean).join(", ")].filter(Boolean).join("\n")
      : `– ${name}${business ? `, ${business}` : ""}`;
    return { ...step, body: `${step.body.trimEnd()}\n\n${signOff}` };
  });
}

/** At most this many kinds of lead get their own messages in one plan; smaller kinds share "Other". */
export const MAX_GROUPS = 4;
/** At most this many leads get a first message written for them alone, so the owner can read every one. */
export const MAX_PERSONAL = 10;

export type LeadApproach = "standard" | "personal" | "skip";

/**
 * The kinds of lead in a plan from the label the sorting model gave each
 * one: labels merged ignoring case and spacing, the largest kept, and past
 * MAX_GROUPS the smallest merged into "Other". Members are indexes into
 * `labels`, in order.
 */
export function settleGroups(labels: readonly string[]): { label: string; members: number[] }[] {
  const byKey = new Map<string, { label: string; members: number[] }>();
  labels.forEach((raw, index) => {
    const label = raw.replace(/\s+/g, " ").trim().slice(0, 60) || "Other";
    const key = label.toLowerCase();
    const group = byKey.get(key) ?? { label, members: [] };
    group.members.push(index);
    byKey.set(key, group);
  });
  const groups = [...byKey.values()].sort((a, b) => b.members.length - a.members.length || a.members[0]! - b.members[0]!);
  if (groups.length <= MAX_GROUPS) return groups;
  const kept = groups.slice(0, MAX_GROUPS - 1);
  const rest = groups.slice(MAX_GROUPS - 1);
  const other = kept.find((group) => group.label.toLowerCase() === "other");
  const merged = rest.flatMap((group) => group.members);
  if (other) other.members.push(...merged);
  else kept.push({ label: "Other", members: merged });
  for (const group of kept) group.members.sort((a, b) => a - b);
  return kept;
}

/** The lead's own field holding the text of step `step` (1-based) of its messages: body or subject. */
export function leadTextKey(personalization: string, step: number, part: "body" | "subject"): string {
  return `${personalization}_${part === "body" ? "b" : "s"}${step}`;
}

/**
 * The campaign's steps when every lead gets its own text (its group's
 * messages, or ones written for it alone): each step is that lead's field.
 * As many steps as the shortest group has; waits from the first group.
 */
export function perLeadSteps(personalization: string, channel: AudienceChannel, groupSequences: readonly (readonly PlannedStep[])[]): PlannedStep[] {
  const sequences = groupSequences.filter((steps) => steps.length);
  if (!sequences.length) return [];
  const count = Math.min(...sequences.map((steps) => steps.length));
  return Array.from({ length: count }, (_, index) => {
    const withSubject = CHANNEL_RULES[channel].subject && (index === 0 || sequences.some((steps) => steps[index]?.subject?.trim()));
    return {
      subject: withSubject ? `{{${leadTextKey(personalization, index + 1, "subject")}}}` : null,
      body: `{{${leadTextKey(personalization, index + 1, "body")}}}`,
      waitDays: sequences[0]![index]!.waitDays,
    };
  });
}

/** Why a first message written for one lead cannot be sent, or null. */
export function personalMessageProblem(channel: AudienceChannel, message: { subject: string | null; body: string }): string | null {
  const body = message.body.trim();
  if (!body) return "the message is empty";
  const limit = channel === "linkedin" ? 280 : CHANNEL_RULES[channel].maxBody;
  if (body.length > limit) return `keep it under ${limit} characters (it has ${body.length})`;
  if (CHANNEL_RULES[channel].subject && !message.subject?.trim()) return "an email needs a subject";
  if (!CHANNEL_RULES[channel].subject && message.subject?.trim()) return "only email has a subject";
  return templateProblem(`${message.subject ?? ""}\n${body}`, []);
}
