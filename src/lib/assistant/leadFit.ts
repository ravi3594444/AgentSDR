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

/** A stored verdict: left out or contradicting the request is no_match; unknown is unconfirmed; otherwise a match. */
export function verdictOf(sort: Pick<SortVerdict, "approach" | "requestFit">): LeadFit {
  if (sort.approach === "skip" || sort.requestFit === "does_not_fit") return "no_match";
  return sort.requestFit === "unconfirmed" ? "unconfirmed" : "match";
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
 * its reason.
 */
export function applyRequestRules(request: string, facts: Record<string, string>, sort: SortVerdict): { fit: LeadFit; reason: string } {
  const fit = verdictOf(sort);
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
 * The owner's request with the clauses about how the research runs taken
 * out (pilot finding L02): budgets and spend, time limits, which sources to
 * use, research-only and no-outreach statements, where to save or send the
 * results, and how to contact the leads. What is left — the kind of business
 * or person, the place, how many, and conditions such as having no website
 * or an Instagram account — is what a lead can fit or fail. A clause that
 * names what to find is kept whatever else it says; when every clause is
 * about how to run, the text is returned as it is.
 */
const CONTROL_CLAUSE = [
  // budgets and spend
  /(?:\$|₹|€|£)\s?\d|\b\d+\s?(?:usd|dollars?|rupees|rs|inr|credits?)\b|\b(?:budget|spend|spending|spent|cost\s+cap|no\s+cost|free\s+of\s+charge)\b/i,
  // time limits
  /\b(?:within|in|under|max(?:imum)?|up\s+to|no\s+more\s+than|at\s+most|time\s+limit(?:\s+of)?|deadline(?:\s+of)?|finish(?:\s+it)?\s+(?:within|in|by)|done\s+(?:within|in|by)|wrap\s+up\s+(?:within|in|by))\s+(?:the\s+next\s+)?(?:\d+(?:\.\d+)?|an?|one|half\s+an?|two|three|five|ten)\s*(?:minutes?|mins?|hours?|hrs?|days?|h|m|d)\b/i,
  // which sources to use
  /\b(?:free|paid|cheap|cheapest)\s+sources?\b|\bsources?\s+only\b|\b(?:use|using|prefer|stick\s+to|try)\s+(?:only\s+)?(?:free|google\s+maps|apify|tavily|bright\s?data|tinyfish|treg|the\s+web|web\s+search|reddit|hacker\s+news)\b|\bno\s+paid\b|\b(?:via|through)\s+(?:apify|google\s+maps|bright\s?data|tavily)\b/i,
  // research only, no outreach
  /\bresearch[\s-]+only\b|\b(?:only|just|purely|strictly)\s+research\b|\bno\s+(?:cold\s+)?(?:outreach|contact|contacting|messages?|messaging|campaigns?|emails?|emailing|dms?|calls?|pitching|pitches|sending)\b|\b(?:do\s+not|don'?t|dont|never)\s+(?:contact|message|email|whatsapp|dm|call|pitch|reach\s+out|approach)\b|\bwithout\s+(?:contacting|messaging|emailing|reaching\s+out)\b/i,
  // where to save or send the results
  /\b(?:save|export|download|share|keep|put)\b[^]*?\b(?:lead\s+)?(?:lists?|csv|sheet|spreadsheet|file|results?|leads?|them)\b|\b(?:send|email|mail|message|whatsapp|share|give|show)\s+(?:it\s+|them\s+|the\s+\w+\s+)?(?:to\s+)?(?:me|us)\b/i,
  // how to contact the leads
  /\b(?:contact|message|email|mail|whatsapp|dm|pitch|reach|call|approach|follow\s+up\s+with)\s+(?:them|each|every|all|everyone|the\s+(?:leads|clinics|businesses|people|owners|list|results|rest|ones))\b|\b(?:do\s+)?outreach\b|\bcampaigns?\b|\b(?:on|via|through|by|over)\s+(?:whatsapp|email|linkedin|instagram|sms|phone)\b/i,
];
/** A clause that names what to find ("find 3 dental clinics", "list every gym") is the subject, whatever else it says. */
const NAMES_SUBJECT = /\b(?:find|look(?:ing)?\s+for|search(?:\s+for)?|get|collect|gather|list|identify|research|discover|need|want|target)\s+(?:me\s+|us\s+)?(?:(?:at\s+least|about|around|up\s+to|some|all|every|the|a|an|new|more)\s+)?(?:\d[\d,]*\s+)?(?!(?:only|them|it|me|us|out|no|nothing|back)\b)[a-z]/i;
/** Clause boundaries, kept so the clauses left are joined as they were; a comma inside a number ("$1,000") is not one. */
const CLAUSE_SPLIT = /([.;!?\n]+\s*|,\s*(?!\d)|\s+(?:and|then|but|also|plus)\s+)/i;

export function requestSubject(text: string): string {
  const parts = text.trim().split(CLAUSE_SPLIT);
  let out = "";
  let kept = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index]!.trim();
    if (!clause) continue;
    if (CONTROL_CLAUSE.some((pattern) => pattern.test(clause)) && !NAMES_SUBJECT.test(clause)) continue;
    const separator = index > 0 ? parts[index - 1]! : "";
    out += out ? `${separator.includes("\n") ? separator : separator.replace(/\s+/g, " ")}${clause}` : clause;
    kept += 1;
  }
  if (!kept) return text.trim();
  const ending = text.trim().match(/[.!?]$/)?.[0];
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
    "approach 'skip': clearly not a fit for the owner's offer (a different kind of business, a competitor of the owner, closed, or obviously out of reach). Never skip only because little is known.",
    "approach is about the message the lead would get if it were contacted. Whether the owner wants anyone contacted now, or how, is decided elsewhere and never makes a lead 'skip'.",
    "reason: one short sentence the owner reads, based only on the facts given. Never invent facts about a lead. A finding from their own website (hiring, booking, websiteSays, websiteNeed, decisionMakers) is a reason they may fit, never a sign they want to buy: say 'may', never 'wants' or 'needs'.",
    "requestFit: whether the lead is what the OWNER'S REQUEST asks for. What the owner stated of the lead itself (the kind of business or person, the place, a condition such as having no website) is a requirement wherever it applies to this lead; words in a title or name ('agent', 'founder', 'realty') are hints, not proof. 'fits': the facts show it is what they asked for. 'does_not_fit': a fact contradicts what they asked (another kind of business or role, another place, a website found when they asked for ones without), or it is a skip. 'unconfirmed': nothing contradicts it, but the facts cannot show a requirement (the place is not shown, whether it has a website is not known). Never call a lead does_not_fit only because little is known. With no request given, judge against the owner's business and offer.",
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
