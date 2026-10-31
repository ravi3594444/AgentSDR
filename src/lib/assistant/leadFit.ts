import type { LeadApproach } from "./messages";
import type { LeadFit } from "./schema";

/**
 * Whether a lead matches what the owner asked for (pilot fix F02). The lead
 * sorter judges each contactable lead against the owner's request as well as
 * the offer; the verdict is stored on the lead list member, and only a
 * "match" counts toward a request's target. Having a contact route is not a
 * match, and keywords in a title are hints, not proof.
 */

/** The sorter's answer on the request, as it gives it (writerReply.ts lead_sorting). */
export type RequestFit = "fits" | "unconfirmed" | "does_not_fit";

export type SortVerdict = { approach: LeadApproach; reason: string; requestFit: RequestFit; noWebsiteRequired: boolean };

/**
 * A stored verdict: contradicting the request is no_match; unknown is
 * unconfirmed; otherwise a match. With a request given, relevance comes from
 * requestFit alone (pilot finding L02): a lead the owner asked for is a
 * match even when the sorter would not message it ("skip", say because the
 * saved target customers differ), and plan preparation leaves a skipped lead
 * out with its reason, so who gets contacted does not widen. With no
 * request, the owner's business decides and a skip is no match.
 */
export function verdictOf(sort: Pick<SortVerdict, "approach" | "requestFit">, options: { requestGiven?: boolean } = {}): LeadFit {
  if (sort.requestFit === "does_not_fit" || (!options.requestGiven && sort.approach === "skip")) return "no_match";
  return sort.requestFit === "unconfirmed" ? "unconfirmed" : "match";
}

/** The facts that say who a lead is, as the sources write them: a business or person's name, or a profile of theirs. */
const IDENTITY_FACTS = ["name", "fullName", "businessName", "listingName", "company", "username", "instagram", "instagramUsername", "linkedinUrl", "profileUrl", "profile"] as const;

/**
 * Whether a lead's facts name a business or person. A contact read off a
 * directory page names nobody: its "business name" is the contact itself
 * ("hi@star.in (listed on pune-guide.example)"), so an email, a phone number
 * or the listed value does not count.
 */
export function namesLead(facts: Record<string, string>): boolean {
  const listed = facts.listedAs?.trim().toLowerCase() || null;
  return IDENTITY_FACTS.some((key) => {
    const value = facts[key]?.replace(/\s*\(listed on [^)]*\)\s*$/i, "").trim();
    if (!value) return false;
    if (listed && value.toLowerCase() === listed) return false;
    return !/^[^\s@]+@[^\s@]+$/.test(value) && !/^\+?[\d\s().-]{6,}$/.test(value);
  });
}

// ── A lead's website, as far as it was checked ───────────────────────────────

/**
 * What is known of a lead's website, kept apart because "none listed",
 * "could not be checked" and "found" are different outcomes: an empty Maps
 * field is not proof there is none, and a failed fetch is not proof either.
 */
export type WebsiteState = "none_listed" | "listed_unchecked" | "read" | "domain_unchecked" | "unknown";

/** The `websiteStatus` fact a lead carries (the sorter reads it; websiteState reads it back). */
export function websiteStatusFact(input: { state: Exclude<WebsiteState, "unknown">; url?: string | null; where?: string; why?: string | null }): string {
  switch (input.state) {
    case "none_listed":
      return `none listed on its ${input.where ?? "Google Maps listing"} (not proof it has none)`;
    case "listed_unchecked":
      return `listed (${input.url ?? "a link"}) but could not be checked${input.why ? `: ${input.why.replace(/\s+/g, " ").slice(0, 120)}` : ""}`;
    case "read":
      return `website found and read: ${input.url ?? "its own site"}`;
    case "domain_unchecked":
      return "company domain on record, not checked";
  }
}

export function websiteState(fact: string | undefined | null): WebsiteState {
  if (!fact) return "unknown";
  if (fact.startsWith("none listed")) return "none_listed";
  if (fact.startsWith("listed (")) return "listed_unchecked";
  if (fact.startsWith("website found and read")) return "read";
  if (fact.startsWith("company domain on record")) return "domain_unchecked";
  return "unknown";
}

/** Whether the owner's words ask for leads without a website ("people who do not have a website", "no website"). */
export function requiresNoWebsite(request: string): boolean {
  return /\b(?:no|without(?:\s+an?)?|don'?t\s+have(?:\s+an?)?|do\s+not\s+have(?:\s+an?)?|doesn'?t\s+have(?:\s+an?)?|does\s+not\s+have(?:\s+an?)?|lacks?(?:\s+an?)?|lacking(?:\s+an?)?|missing(?:\s+an?)?|haven'?t\s+got(?:\s+an?)?)\s+(?:own\s+|proper\s+|real\s+)?(?:websites?|web\s?sites?|sites?|web\s+presence|online\s+presence)\b/i.test(request);
}

/**
 * The code's own check on a verdict, for what must never be counted on the
 * model's word alone. Where the owner asked for leads without a website (and
 * the sorter says that applies to this lead): a website found and read is no
 * match; one listed but unchecked, a domain on record or nothing known leaves
 * the lead unconfirmed. "None listed" stays a match, with that uncertainty in
 * its reason. And a lead whose facts name no business or person (namesLead)
 * is never a match, whatever the model says: at most unconfirmed.
 */
export function applyRequestRules(request: string, facts: Record<string, string>, sort: SortVerdict): { fit: LeadFit; reason: string } {
  const judged = websiteRule(request, facts, sort);
  if (judged.fit !== "match" || namesLead(facts)) return judged;
  const only = facts.listedAs?.trim() ? ` (only ${facts.listedAs.trim()}, listed on a directory page)` : "";
  return { fit: "unconfirmed", reason: `Nothing found names a business or person${only}, so it cannot count as a match.` };
}

function websiteRule(request: string, facts: Record<string, string>, sort: SortVerdict): { fit: LeadFit; reason: string } {
  const fit = verdictOf(sort, { requestGiven: request.trim() !== "" });
  if (fit !== "match" || !sort.noWebsiteRequired || !requiresNoWebsite(request)) return { fit, reason: sort.reason };
  const state = websiteState(facts.websiteStatus);
  if (state === "read") return { fit: "no_match", reason: `It has a website (${facts.websiteStatus!.replace(/^website found and read:\s*/, "")}), and you asked for ones without.` };
  if (state === "listed_unchecked") return { fit: "unconfirmed", reason: `A website is listed but could not be checked, so “no website” is not confirmed. ${sort.reason}`.trim() };
  if (state === "domain_unchecked") return { fit: "unconfirmed", reason: `A company domain is on record and was not checked, so “no website” is not confirmed. ${sort.reason}`.trim() };
  if (state === "unknown") return { fit: "unconfirmed", reason: `Whether it has a website is not known. ${sort.reason}`.trim() };
  return { fit, reason: /website/i.test(sort.reason) ? sort.reason : `${sort.reason} No website is listed for it; that was not checked further.`.trim() };
}

// ── The request the leads are judged against ─────────────────────────────────

/**
 * The owner's request with the instructions about how the research runs
 * taken out (pilot finding L02), so "do not contact anyone", "$0" or "within
 * 5 minutes" is never a requirement a lead fails. A clause is taken out only
 * when it is nothing but such an instruction: one of its words says so (a
 * budget, a time limit, a source, research only, a list to save or send, or
 * contacting the leads) and every other word is one such an instruction is
 * made of. Any word about the leads themselves keeps the clause ("ones that
 * spend on ads", "active on Instagram", "within 10 minutes of the beach",
 * "send me their emails"), so the kind, the place, the count and every
 * condition stay, and a clause that is unsure stays. A no-website
 * requirement is never lost; when every clause is an instruction the text is
 * returned as it is. The clauses kept are joined as they were written.
 */
const INSTRUCTION_SAYS = [
  // a budget
  /\b(?:spend|spending|spent|budget|costs?|cap)\b|[$₹€£]\s?\d|\b\d[\d,.]*\s*(?:usd|dollars?|rupees?|rs|inr|credits?)\b|\bfree\s+of\s+charge\b|\bno\s+cost\b/i,
  // a time limit
  /\b(?:minutes?|mins?|hours?|hrs?|seconds?|secs?|deadline)\b|\btime\s+limit\b|\b\d+\s*(?:m|h|min|hr)\b/i,
  // which sources to use
  /\bsources?\b|\b(?:google\s+maps|apify|tavily|bright\s?data|tinyfish|treg|reddit|hacker\s+news|web\s+search)\b/i,
  // research only, no outreach
  /\bresearch[\s-]+only\b|\b(?:only|just|purely|strictly)\s+(?:for\s+)?research\b|\bno\s+(?:cold\s+)?(?:outreach|contact(?:ing)?|messages?|messaging|campaigns?|emails?|emailing|dms?|calls?|pitch(?:es|ing)?|sending)\b|\b(?:do\s+not|don'?t|dont|never)\s+(?:contact|message|email|whatsapp|dm|call|pitch|text|approach|reach|send)\b|\bwithout\s+(?:contacting|messaging|emailing|reaching)\b/i,
  // where to save or send the list
  /\b(?:save|export|download|share|put|create|build|make|keep)\b.*\b(?:lists?|csv|sheets?|spreadsheet|file|results?|report|excel|table)\b|\b(?:send|give|show|email)\s+(?:it\s+|them\s+|the\s+\w+\s+)?(?:to\s+)?(?:me|us)\b|\blist\s+them\b/i,
];
/** "message them on WhatsApp", "do outreach on email": how to contact the leads, whose words may name a channel. */
const CONTACT_THEM = /\b(?:message|email|whatsapp|contact|dm|pitch|call|text|reach\s+out\s+to|follow\s+up\s+with)\s+(?:them|each(?:\s+of\s+them)?|everyone|all\s+of\s+them)\b|\b(?:do|start|run)\s+(?:the\s+)?outreach\b/i;
/** The words such instructions are made of. A word not here is about the leads, and keeps its clause. */
const INSTRUCTION_WORDS = new Set([
  // joining words
  "a", "an", "the", "and", "or", "with", "at", "of", "to", "for", "in", "on", "is", "it", "be", "please", "also", "then", "just", "only", "up", "under", "below",
  "within", "no", "not", "more", "than", "max", "maximum", "most", "least", "total", "per", "this", "yet", "now", "today", "so", "all", "any", "as", "by", "from",
  "use", "using", "our", "my", "you", "can", "will", "let", "s", "first", "keep", "stick", "try", "prefer", "request", "search", "searches",
  // a budget
  "spend", "spending", "spent", "budget", "budgets", "cost", "costs", "cap", "capped", "limit", "limited", "usd", "dollar", "dollars", "rupee", "rupees", "rs", "inr",
  "credit", "credits", "zero", "nil", "none", "nothing", "money", "paid", "pay", "free", "cheap", "cheapest", "charge", "charges", "price",
  // a time limit
  "finish", "finished", "done", "wrap", "complete", "completed", "stop", "minute", "minutes", "mins", "min", "m", "hour", "hours", "hrs", "hr", "h", "second", "seconds",
  "secs", "deadline", "time", "half", "one", "two", "three", "four", "five", "ten", "fifteen", "twenty", "thirty", "sixty", "take", "takes", "longer", "quick", "quickly", "fast",
  // which sources
  "source", "sources", "google", "maps", "map", "apify", "tavily", "bright", "brightdata", "data", "tinyfish", "treg", "web", "reddit", "hacker", "news",
  // research only, no outreach
  "research", "purely", "strictly", "outreach", "contact", "contacting", "message", "messages", "messaging", "campaign", "campaigns", "email", "emails", "emailing",
  "dm", "dms", "call", "calls", "calling", "pitch", "pitches", "pitching", "sending", "send", "cold", "do", "don", "t", "dont", "never", "anyone", "anybody", "people",
  "them", "without", "reaching", "reach", "out", "approach", "nobody",
  // a list to save or send
  "save", "saved", "export", "download", "share", "put", "make", "create", "build", "give", "show", "me", "us", "lead", "leads", "list", "lists", "csv", "sheet", "sheets",
  "spreadsheet", "file", "results", "result", "into", "report", "excel", "table",
]);
/** How to contact the leads may also name a channel and whom. */
const CONTACT_WORDS = new Set(["whatsapp", "linkedin", "instagram", "phone", "sms", "text", "via", "through", "over", "each", "every", "everyone", "follow", "after", "afterwards", "later", "run", "start"]);
/** Clause boundaries, kept so the clauses left are joined as they were. A point or comma inside a number ("4.5", "$1,000") is not one. */
const CLAUSE_SPLIT = /((?:[;!?\n]|\.(?!\d))+\s*|,(?!\d)\s*|\s+(?:and|then|but|also|plus)\s+)/i;

function isInstruction(clause: string): boolean {
  const words = clause.toLowerCase().match(/[$₹€£]?\d[\d,.]*|[a-z]+/g) ?? [];
  const contactThem = CONTACT_THEM.test(clause);
  if (!words.length || !(contactThem || INSTRUCTION_SAYS.some((pattern) => pattern.test(clause)))) return false;
  return words.every((word) => /^[$₹€£]?\d/.test(word) || INSTRUCTION_WORDS.has(word) || (contactThem && CONTACT_WORDS.has(word)));
}

export function requestSubject(text: string): string {
  const whole = text.trim();
  const parts = whole.split(CLAUSE_SPLIT);
  let out = "";
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index]!.trim();
    if (!clause || isInstruction(clause)) continue;
    const separator = index > 0 ? parts[index - 1]! : "";
    out += out ? `${separator.includes("\n") ? separator : separator.replace(/\s+/g, " ")}${clause}` : clause;
  }
  if (!out || (requiresNoWebsite(whole) && !requiresNoWebsite(out))) return whole;
  const ending = whole.match(/[.!?]$/)?.[0];
  return ending && !/[.;!?]$/.test(out) ? `${out}${ending}` : out;
}

/**
 * What the sorter is told (writer.server.ts sortLeads): the groups, the
 * approaches, and how to judge a lead against the owner's request. How the
 * research runs is never a requirement, and approach concerns the message a
 * lead would get if contacted, not whether the owner wants anyone contacted.
 */
export function leadSortingSystemPrompt(knownGroups: readonly string[]): string {
  return [
    "You sort a business owner's leads before outreach, so each gets the right message. You do not write the messages.",
    "group: name the kind of lead in 2 to 4 words ('Real estate agents', 'Cleaning companies', 'Dental clinics'), the same words for leads of the same kind." + (knownGroups.length ? ` Reuse these names when they fit: ${knownGroups.map((group) => `'${group}'`).join(", ")}.` : ""),
    "approach 'standard': the group's message fits this lead. This is the default.",
    "approach 'personal': rare. Every standard message already opens with a line from the lead's address, rating and category, so choose 'personal' only when the facts show something particular to this lead that the group's message would miss (a specialty, a stated need, a detail from its website or title) and it fits the owner's offer well.",
    "approach 'skip': clearly not a fit for the owner's offer (a different kind of business from the one THE OWNER'S REQUEST asks for, or with no request from the owner's customers; a competitor of the owner; closed; or obviously out of reach). Never skip only because little is known.",
    "When THE OWNER'S REQUEST names a kind of lead or a place, that is whom the owner wants now: it replaces the target customers and locations saved in THE OWNER'S BUSINESS. A lead the request asks for is never 'skip' or 'does_not_fit' because the saved target customers or locations differ.",
    "When a request is broad, keep it broad: the saved profile and earlier campaigns do not add mandatory industries, roles, cities or countries. A segment or place chosen by the assistant is a search strategy, not an owner requirement. A lead outside that strategy may still fit the owner's request.",
    "A question the owner wants to ask after contact is not a fact the lead must already have published. Do not demand public evidence of a cost problem, buying intent or interest merely because the outreach will ask about it; require such evidence only when the owner explicitly asks for leads already showing that need. Never invent success, revenue or buying intent.",
    "approach is about the message the lead would get if it were contacted. Whether the owner wants anyone contacted now, or how, is decided elsewhere and never makes a lead 'skip'.",
    "reason: one short sentence the owner reads, based only on the facts given. Never invent facts about a lead. A finding from their own website (hiring, booking, websiteSays, websiteNeed, decisionMakers) is a reason they may fit, never a sign they want to buy: say 'may', never 'wants' or 'needs'.",
    "requestFit: whether the lead is what the OWNER'S REQUEST asks for. What the owner stated of the lead itself (the kind of business or person, the place, a condition such as having no website) is a requirement wherever it applies to this lead; words in a title, a name or an @handle ('agent', 'founder', 'realty', a city in a username) are hints, not proof. 'fits': the facts show it is what they asked for. 'does_not_fit': a fact contradicts what they asked (another kind of business or role, another place (a neighbouring city or suburb is another place unless the request asks for the area; a place is a requirement only when the owner's own words name it: when they left the place open, 'anywhere' or none named, a place only the assistant's line names is where it chose to search, and a lead elsewhere still fits on place), closed for good, a website found when they asked for ones without). 'unconfirmed': nothing contradicts it, but the facts cannot show a requirement (the place is not shown, whether it has a website is not known). Never call a lead does_not_fit only because little is known. With no request given, judge against the owner's business and offer.",
    "Instructions about how the research runs (research only, no outreach, do not contact anyone, a budget or spend cap, a time limit, which sources to use, how many leads, where to save or send the list, which channel to use) are NOT requirements and never change requestFit or approach. A request that asks for no contact changes nothing about fit: judge the lead as if it would be contacted.",
    "noWebsiteRequired: true only when the owner's request asks for leads like this one to have no website (a request can list several kinds of lead and say it of only one). websiteStatus says what is known of its website: 'none listed' is not proof it has none, and 'could not be checked' is not proof either.",
    "reason, when requestFit is not 'fits': say which requirement is unmet or unconfirmed.",
  ].join("\n");
}

/**
 * Whether a contact is one the owner typed into the chat themselves (its
 * email, LinkedIn link or phone number is in their message). Those are the
 * owner's own choice and count as a match; contacts the assistant found on a
 * page are judged like any other lead.
 */
export function typedByOwner(contact: { email?: string | null; phone?: string | null; linkedinUrl?: string | null }, ownerText: string): boolean {
  const text = ownerText.toLowerCase();
  if (contact.email && text.includes(contact.email.trim().toLowerCase())) return true;
  const slug = contact.linkedinUrl?.trim().toLowerCase().replace(/^https?:\/\/(?:www\.)?/, "").replace(/\/+$/, "");
  if (slug && text.includes(slug)) return true;
  const digits = contact.phone?.replace(/\D/g, "") ?? "";
  if (digits.length < 7) return false;
  const tail = digits.slice(-8);
  return [...ownerText.matchAll(/\+?\d[\d\s().-]{5,}\d/g)].some((match) => match[0].replace(/\D/g, "").endsWith(tail));
}

// ── Facts for a LinkedIn profile ─────────────────────────────────────────────

/** What a LinkedIn people search shows of a profile, as facts the sorter can judge: headline, place, company, and the words searched. */
export function linkedinProfileFacts(lead: { headline?: string | null; location?: string | null; companyName?: string | null }, keywords: string): Record<string, string> {
  const facts: Record<string, string> = { foundVia: "LinkedIn people search", searchedFor: keywords.slice(0, 200) };
  if (lead.headline?.trim()) facts.headline = lead.headline.trim().slice(0, 200);
  if (lead.location?.trim()) facts.location = lead.location.trim().slice(0, 120);
  else facts.location = "not shown on the search result";
  if (lead.companyName?.trim()) facts.company = lead.companyName.trim().slice(0, 120);
  return facts;
}

// ── Counting a request's leads ───────────────────────────────────────────────

/**
 * A request's leads at each step, by distinct person: found, contactable
 * (a route), and of those, matching, not matching, unconfirmed or not yet
 * judged. A person found twice counts once; a no-match anywhere wins, so a
 * person is never counted as a match on one list's thinner facts.
 */
export type LeadFunnel = {
  found: number;
  contactable: number;
  qualified: number;
  notMatching: number;
  unconfirmed: number;
  pending: number;
  /** Members still waiting for a verdict (one person can be on several lists). */
  pendingMembers: number;
  /** The most common reasons people did not match, largest first. */
  noMatchReasons: { reason: string; count: number }[];
};

export const EMPTY_FUNNEL: LeadFunnel = { found: 0, contactable: 0, qualified: 0, notMatching: 0, unconfirmed: 0, pending: 0, pendingMembers: 0, noMatchReasons: [] };

/** One person's standing, from their memberships' verdicts. */
export function personFit(verdicts: readonly (LeadFit | null)[]): LeadFit | "pending" {
  if (verdicts.includes("no_match")) return "no_match";
  if (verdicts.includes("match")) return "match";
  if (verdicts.includes("unconfirmed")) return "unconfirmed";
  return "pending";
}

/** "3 of 50 match your request (40 do not: …; 7 unconfirmed)" — a search's or a request's judging, in one line. */
export function funnelLine(funnel: Pick<LeadFunnel, "contactable" | "qualified" | "notMatching" | "unconfirmed" | "pending" | "noMatchReasons">): string {
  const parts = [
    funnel.notMatching ? `${funnel.notMatching} do not${funnel.noMatchReasons.length ? ` (${funnel.noMatchReasons.slice(0, 2).map((item) => reasonShort(item.reason)).join("; ")})` : ""}` : null,
    funnel.unconfirmed ? `${funnel.unconfirmed} unconfirmed` : null,
    funnel.pending ? `${funnel.pending} not judged yet` : null,
  ].filter(Boolean);
  return `${funnel.qualified} of ${funnel.contactable} contactable match your request${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function reasonShort(reason: string): string {
  const text = reason.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return text.length > 90 ? `${text.slice(0, 88).replace(/\s+\S*$/, "")}…` : text;
}

/** The prefix setLeadFit gives a verdict the assistant recorded itself (after reading the lead's own evidence). */
export const ASSISTANT_CHECKED = "Checked by the assistant: ";

export type RequestCheck = { leads: number; match: number; noMatch: number; unconfirmed: number; pending: number; unchecked: number };

/**
 * Where a request's saved leads stand, one count per person: the verdicts,
 * and how many nobody has really checked yet (not judged at all, or left
 * unconfirmed by the judge without the assistant reading their evidence).
 * A request that saved leads is finished only once these are checked, or
 * once the assistant says why they cannot be (finish_request).
 */
export function requestCheck(rows: readonly { personId: string | null; fit: LeadFit | null; fitReason: string | null }[]): RequestCheck {
  const byPerson = new Map<string, { fit: LeadFit | null; fitReason: string | null }[]>();
  for (const row of rows) if (row.personId) byPerson.set(row.personId, [...(byPerson.get(row.personId) ?? []), row]);
  const out: RequestCheck = { leads: byPerson.size, match: 0, noMatch: 0, unconfirmed: 0, pending: 0, unchecked: 0 };
  for (const verdicts of byPerson.values()) {
    const fit = personFit(verdicts.map((row) => row.fit));
    const checked = verdicts.some((row) => row.fitReason?.startsWith(ASSISTANT_CHECKED));
    if (fit === "match") out.match += 1;
    else if (fit === "no_match") out.noMatch += 1;
    else if (fit === "unconfirmed") out.unconfirmed += 1;
    else out.pending += 1;
    if (fit === "pending" || (fit === "unconfirmed" && !checked)) out.unchecked += 1;
  }
  return out;
}

/** "26 leads: 0 match, 3 not a match, 23 unconfirmed (23 not checked yet)". */
export function requestCheckLine(check: RequestCheck): string {
  const parts = [`${check.match} match`, `${check.noMatch} not a match`, `${check.unconfirmed} unconfirmed`, ...(check.pending ? [`${check.pending} not judged`] : [])];
  return `${check.leads} lead${check.leads === 1 ? "" : "s"}: ${parts.join(", ")}${check.unchecked ? ` (${check.unchecked} not checked yet)` : ""}`;
}
