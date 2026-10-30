import { draftLeaks, draftPlaceholders, unverifiedActionClaims } from "@/lib/crm/ai/grounding";
import { JOB_TITLES, WEBSITE_FACT_KEYS } from "@/lib/discovery/websiteProfile";
import { unbackedLinks, unbackedNumbers } from "./replyCheck";
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
  browser: {
    steps: 2,
    maxBody: 600,
    subject: false,
    waitUnit: "days",
    defaultWaits: [0, 4],
    describe: "Direct message on X, Instagram, Facebook or LinkedIn, sent through the owner's own account in their browser: a first message under 400 characters, conversational, no subject or formatting, one clear question, and one short follow-up if they have not replied.",
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

/** What a website shows that a message might say they lack. */
const FEATURES = String.raw`(?:online bookings?|bookings?|book(?:ing)? online|appointments?|websites?|sites?|chats?|whatsapp|reviews?|presence|contact forms?|forms?|receptionists?|calendars?|systems?|scheduling)`;
/** A clause that only supposes ("if you are not using…"), which claims nothing about the lead. */
const NOT_SUPPOSED = String.raw`(?<!\b(?:if|whether|unless|when|once)\s)`;
const JOB = new RegExp(`\\b${JOB_TITLES}\\b`, "gi");
/** "Your job posting", "your vacancy": a hiring claim with no subject to name. */
const HIRING_POSSESSIVE = /\byour (?:job (?:post|posting|ad|advert|opening|listing)s?|vacanc(?:y|ies)|open (?:position|role|opening)s?|hiring|careers? page)\b/i;
const GREETING_NAME = /^\s*(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear|[Nn]amaste|[Gg]ood (?:morning|afternoon|evening))[ ,]+((?:(?:Dr|Mr|Mrs|Ms|Prof)\.?\s+)?[A-Z][\p{L}'’-]+)/mu;
const TITLED_NAME = /\b(?:Dr|Mr|Mrs|Ms|Prof)\.?\s+([A-Z][\p{L}'’-]+)/gu;
const NOT_A_NAME = new Set(["there", "team", "all", "everyone", "folks", "friends", "both", "sir", "madam", "maam", "ma'am", "ma’am", "ji", "doc", "doctor", "dr", "owner", "owners", "manager", "managers", "guys"]);

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

/** Who a sentence could be about: the lead by any of its names, or "you", "your clinic", "they", "it". */
function subjectPattern(facts: Readonly<Record<string, string>>): string {
  const names = [facts.businessName, facts.company, facts.name]
    .map((value) => value?.replace(/\s*\(.*$/, "").trim())
    .filter((value): value is string => Boolean(value && value.length >= 3))
    .map(escapeRegExp);
  return `(?:you|your \\w+(?: \\w+)?|it|they|its \\w+|their \\w+|the (?:clinic|practice|business|site|website|team)${names.length ? `|${names.join("|")}` : ""})`;
}

/**
 * What a message written for one lead says about them that neither their
 * facts nor the owner's information back, or null. In code, not only the
 * prompt: a price, percentage or link the information does not hold; that
 * they are hiring, unless their website showed that job; a greeting to a name
 * that is not theirs; or that they lack something (the pages read not showing
 * it is not proof it does not exist).
 */
export function leadClaimProblem(text: string, facts: Readonly<Record<string, string>>, knowledge: string): string | null {
  // A price or a percentage is about the offer: only the owner's information backs one (never a lead's review count or street number).
  const numbers = unbackedNumbers(text, knowledge);
  if (numbers.length) return `it gives ${numbers.slice(0, 2).join(", ")}, which your information does not contain`;
  // A link is backed by the owner's information or the lead's own listing (its website), never by what a crawled page said.
  const sourced = Object.entries(facts).filter(([key]) => !(WEBSITE_FACT_KEYS as readonly string[]).includes(key)).map(([, value]) => value);
  const links = unbackedLinks(text, `${knowledge}\n${sourced.join("\n")}`);
  if (links.length) return `it gives a link or address (${links.slice(0, 2).join(", ")}) your information does not contain`;

  const subject = subjectPattern(facts);
  const job = JOB_TITLES;
  const hiringClaim = new RegExp(`\\b(?:(?:you|they|${subject})(?:['’]re| are| is)|(?:saw|noticed|see|read)(?: that)? (?:you|they|${subject})(?:['’]re| are| is)?) (?:currently |now |still )?(?:hiring|recruiting|looking for (?:an? |new |another )*(?:[\\w-]+ ){0,3}?${job}|in need of (?:an? )?(?:[\\w-]+ ){0,3}?${job})`, "i");
  const hiring = hiringClaim.exec(text) ?? HIRING_POSSESSIVE.exec(text);
  if (hiring) {
    if (!facts.hiring) return "it says they are hiring, which their website did not show";
    // The finding backs the job it names, not any job.
    const sentence = text.slice(text.lastIndexOf(".", hiring.index) + 1).split(/[.!?\n]/)[0] ?? "";
    const opening = facts.hiring.toLowerCase();
    const other = [...sentence.matchAll(JOB)].map((match) => match[0].toLowerCase().replace(/s$/, "")).find((word) => !opening.includes(word));
    if (other) return `it says they are hiring a ${other}, which their website did not show`;
  }

  const absence = [
    new RegExp(`${NOT_SUPPOSED}\\b${subject}\\s+(?:(?:do|does)(?:n['’]?t| not) (?:yet |really |seem to |appear to )?(?:have(?! to\\b)|offer|use|show|list|provide|take|accept|allow|support)|ha(?:ve|s)(?:n['’]?t| not) got|ha(?:ve|s) no|lacks?|(?:are|is) (?:missing|without))\\b[^.?!]{0,40}?\\b${FEATURES}\\b`, "i"),
    new RegExp(`${NOT_SUPPOSED}\\b(?:you['’]re|you are|${subject}(?:['’]s| is| are)) not (?:yet )?(?:using|offering|showing|taking|listing|providing|accepting)\\b[^.?!]{0,40}?\\b${FEATURES}\\b`, "i"),
    new RegExp(`${NOT_SUPPOSED}\\b(?:patients|customers|clients|people|visitors|guests)\\s+(?:can['’]?t|cannot|can not|are unable to|have no way to)\\s+(?:yet\\s+)?(?:book|reach|chat|message|find|contact|pay)\\b[^.?!]{0,40}\\b(?:with|on|at|through|via)\\s+(?:you|your|its|their|${subject})\\b`, "i"),
    /\b(?:couldn['’]?t|could not|didn['’]?t|did not|can['’]?t|cannot|wasn['’]?t able to) (?:find|see|spot|locate)\b[^.?!]{0,50}\b(?:on|in) (?:your|its|their) (?:site|website|page|homepage|profile)\b/i,
    /\b(?:there(?:['’]s| is) no|no) (?:online |easy |simple |clear )?(?:way to book|booking|appointment booking|website|chat|contact form|reviews?)\b[^.?!]{0,30}\b(?:on|in) (?:your|its|their)\b/i,
  ];
  if (absence.some((pattern) => pattern.test(text))) return "it says they lack something; not finding it on the pages read does not mean they lack it";

  // A greeting names the lead (their facts alone); a titled name elsewhere may be the sender's or a client's from the information.
  const own = wordSet(Object.values(facts).join(" "));
  const anyone = new Set([...own, ...wordSet(knowledge)]);
  const unknown = (name: string, known: Set<string>) => !NOT_A_NAME.has(name.toLowerCase()) && name.split(/[^\p{L}\p{N}]+/u).filter((part) => part.length >= 2).some((part) => !known.has(part.toLowerCase()));
  const greeted = GREETING_NAME.exec(text)?.[1]?.split(/\s+/).at(-1);
  if (greeted && unknown(greeted, own)) return `it addresses ${greeted}, a name not in their facts`;
  const stranger = [...text.matchAll(TITLED_NAME)].map((match) => match[1]!).find((name) => unknown(name, anyone));
  if (stranger) return `it names ${stranger}, who is in neither their facts nor your information`;
  return null;
}

/**
 * Claims about the sender's results that a message may make only when the
 * owner's information holds them (pilot fix F05): a client story or case
 * study ("we recently helped a similar agency…", "we built an agent for one
 * agency…", "our clients cut…"), a percentage, a multiplier ("3x") or a
 * speed ("under a minute", "within 5 minutes"). A saved case study backs a
 * story that shares its words, and each figure must be in the information as
 * that figure.
 */
const CLIENT_STORY = [
  /\b(?:we|i)(?:['’]ve| have)?\s+(?:recently\s+|just\s+|already\s+|once\s+)?(?:helped|worked with|partnered with|supported)\s+(?:a|an|one|another|several|many|other|similar|dozens|hundreds|over|more than|\d+)\b/i,
  /\b(?:we|i)(?:['’]ve| have)?\s+(?:recently\s+|just\s+|already\s+|once\s+)?(?:built|set up|created|launched|automated|did|ran|designed)\b[^.!?\n]{0,60}?\bfor\s+(?:a|an|one|another|several|many|other|similar|\d+)\s+(?:similar\s+|local\s+|other\s+)?(?:client|customer|agency|agencies|clinic|clinics|company|companies|business|businesses|firm|firms|brokerage|brokerages|team|teams|realtor|realtors|brand|brands|store|stores)\b/i,
  /\b(?:our|my)\s+(?:clients?|customers?|users?)\s+(?:have\s+|has\s+)?(?:saw|see|seen|got|get|cut|increased|doubled|tripled|reduced|grew|achieved|reported|saved|closed|went)\b/i,
  /\b(?:a|one)\s+(?:client|customer)\s+of\s+(?:ours|mine)\b/i,
  /\bcase\s+stud(?:y|ies)\b/i,
];
const PERCENT_CLAIM = /\b(\d+(?:\.\d+)?)\s?(?:%|percent\b)/gi;
const MULTIPLIER_CLAIM = /\b(\d+(?:\.\d+)?)\s?(?:x|×)(?=[\s.,!?)]|$)|\b(\d+(?:\.\d+)?)\s+times\s+(?:more|faster|higher|better|as)\b/gi;
const SPEED_CLAIM = /\b(?:in\s+under|in\s+less\s+than|under|less\s+than|within|in\s+just|in\s+only|in\s+about)\s+(a|an|one|\d+(?:\.\d+)?)\s*-?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/gi;
const STORY_STOPWORDS = new Set(["that", "this", "with", "from", "your", "their", "they", "them", "have", "will", "would", "could", "about", "into", "just", "like", "more", "than", "what", "when", "which", "were", "been", "also", "only", "very", "help", "helped", "recently", "similar", "agency", "client", "clients", "business", "company"]);

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
}

function storyWords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4 && !STORY_STOPWORDS.has(word)));
}

/** A speed as a comparable phrase: "under a minute" → "1 minute". */
function speedKey(amount: string, unit: string): string {
  const n = /^(?:a|an|one)$/i.test(amount) ? "1" : amount;
  const u = unit.toLowerCase().replace(/^secs?$/, "second").replace(/^mins?$/, "minute").replace(/^hrs?$/, "hour").replace(/s$/, "");
  return `${n} ${u}`;
}

function knownSpeeds(knowledge: string): Set<string> {
  const out = new Set<string>();
  for (const match of knowledge.matchAll(/\b(a|an|one|\d+(?:\.\d+)?)\s*-?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/gi)) out.add(speedKey(match[1]!, match[2]!));
  return out;
}

export function sequenceClaimProblem(text: string, knowledge: string): string | null {
  const plain = text.replace(/\{\{[^}]*\}\}/g, " ");
  const known = knowledge.toLowerCase();
  const story = sentences(plain).find((sentence) => CLIENT_STORY.some((pattern) => pattern.test(sentence)));
  if (story) {
    // Backed by a saved story it retells: a client-result sentence in the information sharing at least two of its words.
    const words = storyWords(story);
    const saved = sentences(knowledge).filter((sentence) => CLIENT_STORY.some((pattern) => pattern.test(sentence)) || /\b(?:result|results|case study|client|customer)\b/i.test(sentence));
    if (!saved.some((sentence) => [...storyWords(sentence)].filter((word) => words.has(word)).length >= 2)) {
      return `it tells a client story (“${story.slice(0, 120)}”) that your information does not contain; describe the offer instead, or save the case study first`;
    }
  }
  for (const match of plain.matchAll(PERCENT_CLAIM)) {
    if (!new RegExp(`\\b${match[1]!.replace(".", "\\.")}\\s?(?:%|percent\\b)`, "i").test(known)) return `it claims ${match[0].trim()}, a figure your information does not give`;
  }
  for (const match of plain.matchAll(MULTIPLIER_CLAIM)) {
    const n = (match[1] ?? match[2])!.replace(".", "\\.");
    if (!new RegExp(`\\b${n}\\s?(?:x|×|times)\\b`, "i").test(known)) return `it claims “${match[0].trim()}”, which your information does not give`;
  }
  const speeds = knownSpeeds(knowledge);
  for (const match of plain.matchAll(SPEED_CLAIM)) {
    if (!speeds.has(speedKey(match[1]!, match[2]!))) return `it promises “${match[0].trim()}”, a speed your information does not give`;
  }
  // A price or link the information does not hold, and anything said about the recipients (hiring, what they lack):
  // a template goes to every lead of its group, so no one lead's facts back it.
  return leadClaimProblem(plain, {}, knowledge);
}

/**
 * Checks every step of a plan's sequences (sequenceClaimProblem) once the
 * writer is done with them: a follow-up that still makes an unbacked claim
 * is dropped (its wait moves to the next step, so the timing holds), and a
 * first message that does stops the plan (`blocked`). The preview and the
 * launch use what this returns.
 */
export function groundSequences(sequences: Partial<Record<AudienceChannel, PlannedStep[]>>, knowledge: string): {
  sequences: Partial<Record<AudienceChannel, PlannedStep[]>>;
  dropped: { channel: AudienceChannel; step: number; problem: string }[];
  blocked: { channel: AudienceChannel; problem: string } | null;
} {
  const out: Partial<Record<AudienceChannel, PlannedStep[]>> = {};
  const dropped: { channel: AudienceChannel; step: number; problem: string }[] = [];
  let blocked: { channel: AudienceChannel; problem: string } | null = null;
  for (const [channel, steps] of Object.entries(sequences) as [AudienceChannel, PlannedStep[]][]) {
    const kept: PlannedStep[] = [];
    let carriedWait = 0;
    steps.forEach((step, index) => {
      const problem = sequenceClaimProblem(`${step.subject ?? ""}\n${step.body}`, knowledge);
      if (problem && index === 0) {
        blocked ??= { channel, problem };
        kept.push(step);
      } else if (problem) {
        dropped.push({ channel, step: index + 1, problem });
        carriedWait += step.waitDays;
      } else {
        kept.push(index > 0 && carriedWait ? { ...step, waitDays: Math.min(30, step.waitDays + carriedWait) } : step);
        if (index > 0) carriedWait = 0;
      }
    });
    out[channel] = kept;
  }
  return { sequences: out, dropped, blocked };
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
