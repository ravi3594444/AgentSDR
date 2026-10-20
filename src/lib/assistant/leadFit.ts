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
