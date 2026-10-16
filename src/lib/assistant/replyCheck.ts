import { isAcknowledgementOnly, isBareGreeting } from "@/lib/crm/greeting";
import type { OwnerDecisionKind, ReplyCheck } from "./schema";

/**
 * Whether an AI reply may be sent without a person reading it. A model
 * (replyCheck.server.ts) lists the lead's questions, the reply's claims
 * about the business and its promises, each with a quote from the
 * BUSINESS INFORMATION; this module decides, deterministically:
 *
 * - every quote must appear in that information (the model cannot make
 *   evidence up), and every question must be answered with one;
 * - every price, amount, percentage, time or day in the reply must appear
 *   in that information too (no invented prices, discounts or appointments);
 * - opt-outs stop outreach; complaints, negotiations, unbacked promises,
 *   meetings without booking details and uncertain cases go to the owner
 *   with the reason and the decision needed; a question the information
 *   cannot answer becomes a focused question for the owner, whose answer is
 *   saved for every later conversation.
 *
 * "Interested" alone is never enough: an answer is sent only when it is
 * backed. Pure, so every rule is unit-tested.
 */

export type ModelCheck = {
  intent: string;
  questions: { question: string; answered: boolean; evidence: string; /** Exact question in the draft asking the lead to clarify their own needs or an ambiguous reference. */ clarification?: string }[];
  claims: { claim: string; evidence: string }[];
  commitments: { commitment: string; evidence: string }[];
  missing: string;
  escalate: string;
};

export type ReplyVerdict =
  | { action: "send"; check: ReplyCheck }
  | { action: "opt_out"; check: ReplyCheck; reason: string }
  /** Their message needs no answer (an "ok" or "thanks" after being answered): nothing is sent. */
  | { action: "no_reply"; check: ReplyCheck; reason: string }
  | { action: "hold"; check: ReplyCheck; kind: Exclude<OwnerDecisionKind, "opt_out" | "interested">; reason: string; decision: string };

/**
 * `ready`: agrees to the next step or asks to buy, for a price quote, a call
 * or a visit — a person takes over. `wants_person`: asks for a human.
 * `acknowledgement`: only "ok", "thanks", 👍, asking nothing.
 */
export const REPLY_CHECK_INTENTS = ["greeting", "question", "interested", "ready", "wants_person", "acknowledgement", "not_interested", "opt_out", "complaint", "negotiation", "scheduling", "out_of_office", "other"] as const;

/** A literal greeting needs no owner facts. Additional words keep ordinary checks. */
export function isGreetingOnly(message: string): boolean {
  const clean = message.trim().toLowerCase().replace(/[!?.،,。\s]+$/gu, "");
  return /^(?:hi+|he+y+|hello+|hiya|howdy|namaste|namaskar|salaam|salam|नमस्ते|हाय|हेलो|good (?:morning|afternoon|evening))(?:\s+(?:there|bhai|ji|sir|madam))?$/u.test(clean);
}

/** Lowercase, one kind of quote and dash, single spaces, no edge punctuation: for quote matching. */
export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'.,;:!?()[\]-]+|[\s"'.,;:!?()[\]-]+$/g, "");
}

/** A quote is evidence only if it is long enough to mean something and appears in the information. */
export function quoteSupported(evidence: string, knowledge: string): boolean {
  const quote = normalizeForMatch(evidence);
  if (quote.length < 6) return false;
  return normalizeForMatch(knowledge).includes(quote);
}

const CURRENCY = /(?:₹|rs\.?|inr|\$|usd|€|eur|£|gbp|aed|sgd)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:₹|rs\.?|inr|usd|eur|gbp|rupees|dollars|euros|lakh|lakhs|crore|k\b)/gi;
const PERCENT = /\d+(?:\.\d+)?\s?%|\d+(?:\.\d+)?\s?percent/gi;
const TIME_OF_DAY = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)|\b\d{1,2}:\d{2}\b/gi;
const DAY_WORDS = /\b(?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week)\b/gi;

function digits(value: string): string {
  return value.replace(/[^\d.]/g, "").replace(/^\.+|\.+$/g, "");
}

/**
 * Prices, amounts and percentages in the reply that the information does
 * not contain (compared by their digits, so "₹2,499" matches "Rs 2499").
 */
export function unbackedNumbers(reply: string, knowledge: string): string[] {
  const knownDigits = new Set([...knowledge.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) => digits(match[0])));
  const found = [...reply.matchAll(CURRENCY), ...reply.matchAll(PERCENT)].map((match) => match[0].trim());
  return [...new Set(found)].filter((value) => !knownDigits.has(digits(value)));
}

/** Times and days the reply proposes that the information does not mention (no invented appointments). */
export function unbackedTimes(reply: string, knowledge: string): string[] {
  const known = normalizeForMatch(knowledge);
  const found = [...reply.matchAll(TIME_OF_DAY), ...reply.matchAll(DAY_WORDS)].map((match) => match[0].trim());
  return [...new Set(found)].filter((value) => !known.includes(normalizeForMatch(value)));
}

/** Words a reply uses to say what the business does NOT do, in English and Hinglish ("No, we only…", "sirf Pune", "service nahi hai"). */
const SAYS_NOT_OFFERED = /\b(?:no|nope),? (?:we|i)\b|\bwe (?:do not|don't|dont|cannot|can't|currently do not|currently don't)\b|\b(?:not|don't|do not) (?:offer|provide|service|cover|serve|do|work)\b|\b(?:only|currently only|just) (?:offer|provide|service|cover|serve|do|work)\b|\bunfortunately\b|\bsirf\b|\bnahi[n]?\b/i;
/** Words that state a limit in the owner's own information ("only in Pune", "we do not service X-ray units"). */
const STATES_A_LIMIT = /\b(?:only|not|no|except|exclusively|don't|do not|outside|limited to|sirf|nahi|nahin)\b/i;

/**
 * Whether the reply tells the lead something is NOT offered without the
 * owner's information saying so: a list of what the business does is not
 * a list of what it does not do. Backed only when a quote the check found in
 * the information itself states a limit.
 */
export function unbackedRefusal(reply: string, evidence: readonly string[]): boolean {
  if (!SAYS_NOT_OFFERED.test(reply)) return false;
  return !evidence.some((quote) => STATES_A_LIMIT.test(quote));
}

/** Links and email addresses the reply gives that the information does not contain (no invented links or attachments). */
export function unbackedLinks(reply: string, knowledge: string): string[] {
  const known = normalizeForMatch(knowledge);
  const found = [...reply.matchAll(/\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi)]
    .map((match) => match[0].replace(/[.,;:!?]+$/, ""));
  return [...new Set(found)].filter((value) => !known.includes(normalizeForMatch(value)));
}

function quote(value: string, max = 140): string {
  const text = value.replace(/\s+/g, " ").trim();
  return `“${text.length > max ? `${text.slice(0, max - 1)}…` : text}”`;
}

/** The lead's words without the "Subject: …" line an email reply carries. */
function messageBody(leadMessage: string): string {
  return leadMessage.replace(/^Subject:[^\n]*\n?/i, "").trim();
}

export function judgeReply(model: ModelCheck, input: { reply: string; knowledge: string; leadName: string; leadMessage?: string; /** The assistant already answered in this conversation. */ answeredBefore?: boolean }): ReplyVerdict {
  const body = input.leadMessage ? messageBody(input.leadMessage) : "";
  if (input.leadMessage && (isGreetingOnly(input.leadMessage) || (isBareGreeting(body) && !isAcknowledgementOnly(body)))) {
    // Correct an invented question or handoff for "Hey". Claims, amounts,
    // links, times and promises in the drafted answer are still checked.
    model = { ...model, intent: "greeting", questions: [], missing: "", escalate: "" };
  }
  const intent = (REPLY_CHECK_INTENTS as readonly string[]).includes(model.intent) ? model.intent : "other";
  const questions = model.questions.map((item) => ({
    question: item.question.trim(),
    answered: Boolean(item.answered),
    evidence: item.evidence.trim(),
    supported: Boolean(item.answered) && quoteSupported(item.evidence, input.knowledge),
    clarification: item.clarification?.trim() || "",
    clarifies: normalizeForMatch(item.clarification || "").length >= 12
      && /[?？]/u.test(item.clarification!)
      && normalizeForMatch(input.reply).includes(normalizeForMatch(item.clarification!)),
  })).filter((item) => item.question);
  const claims = model.claims.map((item) => ({ claim: item.claim.trim(), evidence: item.evidence.trim(), supported: quoteSupported(item.evidence, input.knowledge) })).filter((item) => item.claim);
  const commitments = model.commitments.filter((item) => item.commitment.trim());
  const unbackedCommitments = commitments.filter((item) => !quoteSupported(item.evidence, input.knowledge)).map((item) => item.commitment.trim());
  const numbers = unbackedNumbers(input.reply, input.knowledge);
  const times = unbackedTimes(input.reply, input.knowledge);
  const links = unbackedLinks(input.reply, input.knowledge);
  const problems: string[] = [];
  const check: ReplyCheck = { intent, questions, claims, commitments: commitments.map((item) => item.commitment.trim()), problems };
  const who = input.leadName || "The lead";

  if (intent === "opt_out") return { action: "opt_out", check, reason: `${who} asked not to be contacted` };
  if (intent === "complaint") {
    problems.push("complaint");
    return { action: "hold", check, kind: "complaint", reason: `${who} is complaining${model.escalate ? `: ${model.escalate}` : ""}.`, decision: "Read their message and answer it yourself; the assistant does not answer complaints." };
  }
  if (intent === "wants_person") {
    problems.push("asked for a person");
    return { action: "hold", check, kind: "person", reason: `${who} asked to talk to a person${model.escalate ? `: ${model.escalate}` : ""}.`, decision: "Reply to them yourself; they were told you will." };
  }
  if (intent === "ready") {
    problems.push("ready for the next step");
    return { action: "hold", check, kind: "ready", reason: `${who} is ready${model.escalate ? `: ${model.escalate}` : " for the next step"}.`, decision: "Contact them now: call them or reply in the chat. They were told you will." };
  }
  // Only a real acknowledgement ("ok", "thanks") right after our answer needs no reply; "Hey bro" is a greeting and gets one.
  if (intent === "acknowledgement" && input.answeredBefore && (!body || isAcknowledgementOnly(body))) {
    return { action: "no_reply", check, reason: `${who} only acknowledged the last answer; nothing to reply` };
  }
  if (intent === "out_of_office") {
    problems.push("automatic reply");
    return { action: "hold", check, kind: "uncertain", reason: `${who}'s message looks like an automatic reply (out of office), not an answer.`, decision: "Usually nothing to do; follow-ups resume only if you restart them." };
  }

  // "No, we only do chairs" from a list of services is a guess about what is not offered: the owner decides.
  const supportedEvidence = [...questions, ...claims].filter((item) => item.supported).map((item) => item.evidence);
  if (questions.length && unbackedRefusal(input.reply, supportedEvidence)) {
    const first = questions[0]!;
    problems.push("says something is not offered, which your information does not say");
    return {
      action: "hold",
      check,
      kind: "missing_info",
      reason: `${who} asked ${quote(first.question)}; the reply would say you do not offer it, but your saved information does not say that.`,
      decision: `Do you offer it? ${quote(first.question, 100)} Your answer is saved for later replies.`,
    };
  }

  const unanswered = questions.filter((item) => (!item.answered || !item.supported) && !item.clarifies);
  if (unanswered.length) {
    problems.push(...unanswered.map((item) => `not answered from your information: ${item.question}`));
    const first = unanswered[0]!;
    return {
      action: "hold",
      check,
      kind: intent === "negotiation" ? "negotiation" : intent === "scheduling" ? "meeting" : "missing_info",
      reason: `${who} asked ${quote(first.question)}, and your saved information does not answer it.`,
      decision: model.missing.trim() || `What should the assistant tell them about ${quote(first.question, 100)}?`,
    };
  }
  const unsupportedClaims = claims.filter((item) => !item.supported);
  if (numbers.length) problems.push(...numbers.map((value) => `amount not in your information: ${value}`));
  if (times.length) problems.push(...times.map((value) => `time not in your information: ${value}`));
  if (links.length) problems.push(...links.map((value) => `link or address not in your information: ${value}`));
  if (unsupportedClaims.length) problems.push(...unsupportedClaims.map((item) => `claim not in your information: ${item.claim}`));
  if (unbackedCommitments.length) problems.push(...unbackedCommitments.map((item) => `promise not in your rules: ${item}`));

  if (times.length || (intent === "scheduling" && (unsupportedClaims.length || unbackedCommitments.length))) {
    return {
      action: "hold",
      check,
      kind: "meeting",
      reason: `The reply to ${who} proposes ${times.length ? quote(times.join(", ")) : "a meeting"}, which your information does not offer.`,
      decision: "Answer with a time yourself, or add your booking link or available hours to your business information so the assistant can offer them.",
    };
  }
  if (links.length) {
    return {
      action: "hold",
      check,
      kind: "commitment",
      reason: `The reply to ${who} gives ${quote(links.join(", "))}, which is not in your saved information.`,
      decision: "Add the right link or address to your business information (it will be used in later replies), or answer yourself.",
    };
  }
  if (numbers.length) {
    return {
      action: "hold",
      check,
      kind: intent === "negotiation" ? "negotiation" : "commitment",
      reason: `The reply to ${who} mentions ${quote(numbers.join(", "))}, which is not in your saved prices or offers.`,
      decision: "Confirm the right price or discount (it will be saved for later replies), or answer yourself.",
    };
  }
  if (unbackedCommitments.length) {
    return {
      action: "hold",
      check,
      kind: intent === "negotiation" ? "negotiation" : "commitment",
      reason: `The reply to ${who} would promise ${quote(unbackedCommitments[0]!)}, which your information does not cover.`,
      decision: "Decide whether to offer this; your answer is saved so the assistant can offer it next time.",
    };
  }
  if (unsupportedClaims.length) {
    return {
      action: "hold",
      check,
      kind: "missing_info",
      reason: `The reply to ${who} says ${quote(unsupportedClaims[0]!.claim)}, which is not in your saved information.`,
      decision: `Is this right? Give the correct details: ${quote(unsupportedClaims[0]!.claim, 100)}`,
    };
  }
  if (model.escalate.trim()) {
    problems.push(`needs a person: ${model.escalate.trim()}`);
    return { action: "hold", check, kind: intent === "negotiation" ? "negotiation" : "uncertain", reason: `${model.escalate.trim()}`, decision: "Read the conversation and decide how to answer." };
  }
  if (model.missing.trim()) {
    problems.push(`missing: ${model.missing.trim()}`);
    return { action: "hold", check, kind: "missing_info", reason: `The reply to ${who} needs information you have not given yet.`, decision: model.missing.trim() };
  }
  return { action: "send", check };
}

/**
 * The times a held reply proposed, when that is all that is wrong with it:
 * such a reply is rewritten once without them instead of waiting for the
 * owner. Null when anything else is wrong.
 */
export function selfFixableTimes(check: ReplyCheck): string[] | null {
  const prefix = "time not in your information: ";
  if (!check.problems.length || !check.problems.every((problem) => problem.startsWith(prefix))) return null;
  return check.problems.map((problem) => problem.slice(prefix.length));
}

/** Fix the draft's unsupported additions once; genuine unanswered questions still need the owner. */
export function selfFixableReply(check: ReplyCheck): string | null {
  const prefixes = ["time not in your information: ", "amount not in your information: ", "claim not in your information: ", "promise not in your rules: ", "link or address not in your information: "];
  if (!check.problems.length || !check.problems.every((problem) => prefixes.some((prefix) => problem.startsWith(prefix)))) return null;
  return `Rewrite this reply to correct these unsupported additions: ${check.problems.join("; ")}. Remove them or replace them only with facts explicitly supported by Knowledge. Answer the lead's actual message first. A greeting needs only a natural greeting and, when useful, one short question about their needs; do not repeat the sales pitch. Ask the lead to clarify an ambiguous reference instead of inventing their needs. Do not propose days or times, invent prices or links, promise a later personal reply, or dodge a factual question whose answer is missing.`;
}
