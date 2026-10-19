import type { AudienceChannel, ContactEvidence, LeadSignal } from "./schema";

/**
 * How a found or listed lead is shown before outreach: where it came from
 * and when, why it matched, how it can be reached, and what — if anything —
 * shows a need. Pure and client-safe.
 *
 * The rules that keep this honest:
 * - A potential match is not an interested customer. Only a reply the CRM
 *   classified as interested makes a lead "Interested"; someone who wrote in
 *   on their own is "Inquired"; anyone who replied otherwise is "Replied".
 * - A follow, like, reaction or generic comment is engagement, never
 *   evidence of need, and never changes the status.
 * - Location, budget and contact details that were not found stay
 *   "Unknown": nothing is filled in from the search words or a guess.
 * - What a business's own website shows is an observation: a reason it may
 *   fit, never interest. What the pages read did not show is "not found on
 *   the pages read", never "does not exist".
 */

export type ProspectStatus = "potential_match" | "inquired" | "replied" | "interested" | "excluded";

export const PROSPECT_STATUS_LABELS: Record<ProspectStatus, string> = {
  potential_match: "Potential match",
  inquired: "Inquired",
  replied: "Replied",
  interested: "Interested",
  excluded: "Left out",
};

export const UNKNOWN = "Unknown";

export type ProspectInput = {
  personId: string | null;
  name: string;
  status: "eligible" | "excluded";
  reason: string | null;
  channels: AudienceChannel[];
  source: string;
  sourceUrl: string | null;
  evidence: ContactEvidence[];
  facts: Record<string, string>;
  matchReason: string | null;
  signals: LeadSignal[];
  createdAt: Date | string;
  /** The person's CRM record, when they ever replied or wrote in on a channel. */
  crm: { categoryKey: string | null; lastInboundAt: Date | string | null } | null;
};

export type ContactRoute = { channel: string; value: string; sourceUrl: string | null; note: string };

export type Prospect = {
  personId: string | null;
  name: string;
  status: ProspectStatus;
  statusLabel: string;
  /** Why a left-out lead cannot be contacted. */
  excludedReason: string | null;
  source: { label: string; url: string | null };
  foundAt: string;
  matchReason: string;
  routes: ContactRoute[];
  /** Their own words that show a need, with where they were found. */
  needEvidence: LeadSignal[];
  /** Follows, likes and generic comments: shown, never counted as intent. */
  engagement: LeadSignal[];
  /** What their own website shows that may matter to the offer: inferred relevance, never interest. */
  observations: LeadSignal[];
  /** People their website names with a role. */
  people: LeadSignal[];
  /** Their website as read: when, which pages, and what those pages did not show (which is not proof it does not exist). */
  website: { checkedAt: string; pages: string[]; notFound: string[] } | null;
  location: string;
  budget: string;
};

const SOURCE_LABELS: Record<string, string> = {
  google_maps: "Google Maps listing",
  web_search: "Web search",
  "discovery:web-search": "Web search",
  linkedin_search: "LinkedIn search",
  apify_instagram: "Instagram (via Apify)",
  apify_facebook: "Facebook page (via Apify)",
  apify_linkedin: "LinkedIn company (via Apify)",
  list: "Your list",
  existing: "Your leads",
  "inquiry:website_form": "Website form inquiry",
  "inquiry:instagram": "Instagram inquiry",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? (source.startsWith("web") ? "Web search" : source.replace(/[_:-]+/g, " ").replace(/^./, (c) => c.toUpperCase()));
}

const ROUTE_NOTE: Record<ContactEvidence["kind"], string> = {
  email: "published email",
  phone: "published phone",
  linkedin: "LinkedIn page",
  website: "website",
  instagram: "Instagram",
};

function iso(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

/** Where the lead is, only from facts the source gave (city, address); otherwise Unknown. */
function locationOf(facts: Record<string, string>): string {
  const place = facts.city?.trim() || facts.address?.trim() || facts.location?.trim();
  return place || UNKNOWN;
}

/** A budget is only known when the lead stated one; nothing here reads one in. */
function budgetOf(facts: Record<string, string>): string {
  return facts.budget?.trim() || UNKNOWN;
}

/** What the website check looks for, as the owner reads it when the pages read did not show it. */
const LOOKED_FOR: [NonNullable<LeadSignal["topic"]>, string][] = [
  ["booking", "an online booking link"],
  ["hiring", "hiring that matches your offer"],
  ["person", "people named with a role"],
];

function websiteRead(evidence: readonly ContactEvidence[], signals: readonly LeadSignal[]): Prospect["website"] {
  const site = evidence.find((item) => item.kind === "website" && item.checkedAt);
  if (!site?.checkedAt) return null;
  const seen = new Set(signals.map((signal) => signal.topic));
  return { checkedAt: site.checkedAt, pages: site.pagesRead ?? [], notFound: LOOKED_FOR.filter(([topic]) => !seen.has(topic)).map(([, label]) => label) };
}

export function prospectStatus(input: Pick<ProspectInput, "status" | "signals" | "crm" | "source">): ProspectStatus {
  if (input.status === "excluded") return "excluded";
  if (input.crm?.categoryKey === "interested") return "interested";
  // Writing in is the person's own initiative (and their inquiry is itself the
  // CRM's inbound message); a comment someone else's search found is not.
  if (input.source.startsWith("inquiry:") && input.signals.some((signal) => signal.kind === "need")) return "inquired";
  if (input.crm?.lastInboundAt) return "replied";
  return "potential_match";
}

export function qualifyProspect(input: ProspectInput): Prospect {
  const status = prospectStatus(input);
  const routes: ContactRoute[] = input.evidence
    .filter((item) => item.kind !== "website")
    .map((item) => ({ channel: item.kind, value: item.value, sourceUrl: item.sourceUrl, note: `${ROUTE_NOTE[item.kind]} · ${item.source}` }));
  return {
    personId: input.personId,
    name: input.name,
    status,
    statusLabel: PROSPECT_STATUS_LABELS[status],
    excludedReason: input.status === "excluded" ? input.reason ?? "cannot be contacted" : null,
    source: { label: sourceLabel(input.source), url: input.sourceUrl },
    foundAt: iso(input.createdAt),
    matchReason: input.matchReason?.trim() || UNKNOWN,
    routes,
    needEvidence: input.signals.filter((signal) => signal.kind === "need"),
    engagement: input.signals.filter((signal) => signal.kind === "engagement"),
    observations: input.signals.filter((signal) => signal.kind === "observation" && signal.topic !== "person"),
    people: input.signals.filter((signal) => signal.topic === "person"),
    website: websiteRead(input.evidence, input.signals),
    location: locationOf(input.facts),
    budget: budgetOf(input.facts),
  };
}

/**
 * Why a lead matched, for lists made before match reasons were recorded:
 * from what was actually searched (the list's criteria) and what the source
 * listed (the category), never from a guess. Null when nothing is known.
 */
export function derivedMatchReason(source: string, criteria: Record<string, unknown>, facts: Record<string, string>): string | null {
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  if (source === "google_maps") {
    const what = text(criteria.what);
    const where = text(criteria.where);
    if (!what) return null;
    return `Listed on Google Maps for “${what}”${where ? ` in ${where}` : ""}${facts.category ? `, as “${facts.category}”` : ""}.`;
  }
  if (source === "linkedin_search") {
    const keywords = text(criteria.keywords);
    return keywords ? `Found by a LinkedIn search for “${keywords}”.` : null;
  }
  if (source === "list") return "In a list you gave.";
  return null;
}

export type ProspectCounts = Record<ProspectStatus, number> & { withNeedEvidence: number };

export function countProspects(prospects: readonly Prospect[]): ProspectCounts {
  const counts: ProspectCounts = { potential_match: 0, inquired: 0, replied: 0, interested: 0, excluded: 0, withNeedEvidence: 0 };
  for (const prospect of prospects) {
    counts[prospect.status] += 1;
    if (prospect.needEvidence.length) counts.withNeedEvidence += 1;
  }
  return counts;
}
