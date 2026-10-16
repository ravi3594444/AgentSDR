import "server-only";

import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { addAudienceMembers, createAudience, type NewMember } from "@/lib/assistant/audiences.server";
import { assistantJobs, type AudienceChannel, type ContactEvidence, type LeadSignal } from "@/lib/assistant/schema";
import type { AssistantJob, StepOutcome } from "@/lib/assistant/worker";
import { findOrCreateContactPerson } from "@/lib/calls/campaigns";
import { checkPhone } from "@/lib/calls/phone";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";
import { featureEnabled, FeatureDisabledError } from "@/lib/features/flags.server";
import { instagramAccounts } from "@/lib/instagram/schema";
import { upsertPerson, withLeadTransaction } from "@/lib/leads/records";
import { people } from "@/lib/leads/schema";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { getInstagramPost, getInstagramProfile, listInstagramPostComments, unipileFailureStatus } from "@/services/unipile.instagramProfiles";
import { cleanEmail, extractContacts, ownWebsite, websiteDomain } from "./contacts";
import { discoveryPageOptions, emailDomainCheck } from "./discovery.server";
import { cleanBusinessName, rankEmails } from "./mapsResults";
import {
  buildSearchQueries,
  classifySourceUrl,
  directoryBusinessLinks,
  instagramTarget,
  matchReasonFor,
  needSignal,
  unusableReason,
  type MatchRelation,
} from "./webDiscovery";
import { searchWeb, webSearchAvailability, WebSearchUnavailableError } from "./webSearch.server";
import { collectWebsiteContacts, fetchPublicPage } from "./websiteContacts.server";

/**
 * Lead discovery from a description of the owner's customers, through a
 * real web search (webSearch.server.ts): the businesses' own websites and
 * local directories or lists the search provider returned, and — with the
 * Instagram feature on and an Instagram account linked in Unipile — public
 * Instagram profiles and posts. Every page it reads is one the provider
 * returned, or a business link on such a directory page, or the website an
 * Instagram profile lists; every contact is saved with the exact page it
 * was read from, validated (email syntax and the domain's mail servers,
 * phone numbers to E.164) and matched against the organization's existing
 * People by email and by phone before anyone is created. Nothing is
 * guessed: a business that publishes no contact is kept in the audience as
 * excluded, with the reason.
 *
 * Instagram is read, never acted on: a profile (its listed website and
 * public contact buttons) and a post's comments, each commenter kept with
 * what they wrote as a signal ("need" only for an explicit ask). Nobody is
 * contacted on Instagram in this release, so an Instagram-only lead stays
 * excluded with a reason that tells the owner to open the post themselves.
 *
 * Runs as an assistant job (worker.ts) in stages, each step bounded so a
 * restart resumes where it stopped:
 *   queued → searching (one provider search per step) → reading (a few
 *   pages per step) → saving (a batch per step) → done.
 */

export const WEB_DISCOVERY_SOURCE = "web_search";
const PERSON_SOURCE = "discovery:web-search";
export const MAX_WEB_SITES = 40;
const DEFAULT_WEB_SITES = 20;
const MAX_DIRECTORY_PAGES = 5;
const MAX_DIRECTORY_LINKS = 20;
const MAX_DIRECTORY_CONTACTS = 20;
const MAX_INSTAGRAM_STARTS = 6;
const MAX_POST_COMMENTS = 50;
const READ_BATCH = 6;
const READ_CONCURRENCY = 3;
const SAVE_BATCH = 25;
const MAX_SKIPPED_KEPT = 30;

export const INSTAGRAM_ONLY_REASON = "reachable only on Instagram; Instagram outreach is not available — open the post to reply yourself";
export const INSTAGRAM_PROFILE_ONLY_REASON = "reachable only on Instagram; Instagram outreach is not available — open the profile to message them yourself";

export type WebDiscoveryCriteria = {
  /** Who the customers are, in the owner's words: "dental clinics", "families renovating a flat". */
  customers: string;
  /** Where: "Baner, Pune". */
  where: string;
  /** What the owner sells, so the search does not return competitors. */
  offer: string | null;
  /** The owner's own website, never returned as a lead. */
  ownWebsite: string | null;
  /** At most this many business websites are read (5–40). */
  maxResults: number;
  language: string;
};

type ContactAfter = { channels: AudienceChannel[] | null; ownerRequest?: string } | null;

/** The search result a candidate came from: what the match reason quotes. */
type Origin = { query: string; url: string; title: string | null; snippet: string | null };

type Candidate = {
  kind: "own_site" | "directory" | "instagram_profile" | "instagram_post";
  url: string;
  origin: Origin;
  via?: MatchRelation;
  /** A name the page that led here gives it: a directory's link text, an Instagram profile's name. */
  label?: string | null;
  /** The Instagram profile that listed this website. */
  instagram?: { username: string; url: string } | null;
};

type FoundContactValue = { value: string; sourceUrl: string; source: string };

type FoundLead = {
  kind: "site" | "directory_contact" | "instagram_profile" | "instagram_commenter";
  name: string;
  /** Where the lead was found: the search result, directory page, Instagram profile or post. */
  sourceUrl: string;
  matchReason: string;
  website: string | null;
  domain: string | null;
  emails: FoundContactValue[];
  /** E.164. */
  phones: FoundContactValue[];
  companyLinkedin: string | null;
  instagram: { username: string; url: string; sourceUrl: string; source: string } | null;
  signals: LeadSignal[];
  /** Why the website could not be read, when it could not. */
  error: string | null;
  facts: Record<string, string>;
};

type SearchRecord = { query: string; sources: number; provider: string | null; model: string | null; costUsd: number | null; error: string | null };
type Tally = { eligible: number; excluded: number; duplicates: number; alreadyKnown: number; withEmail: number; withPhoneOnly: number; instagramOnly: number; needSignals: number };

type Payload = {
  criteria: WebDiscoveryCriteria;
  queries: string[];
  phrase: string;
  instagram: { usable: boolean; reason: string | null };
  contactAfter?: ContactAfter;
  searchIndex?: number;
  searches?: SearchRecord[];
  candidates?: Candidate[];
  readIndex?: number;
  leads?: FoundLead[];
  skipped?: { url: string; reason: string }[];
  skippedCount?: number;
  saveIndex?: number;
  tally?: Tally;
  /** People this run created, and people already added to its audience: a later match to either is a duplicate. */
  createdIds?: string[];
  memberIds?: string[];
};

export class WebDiscoveryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebDiscoveryUnavailableError";
  }
}

/** Test hook: the mail-server check (scripts stand it in; production uses DNS). */
let mailCheck: (domain: string) => Promise<"accepts" | "rejects" | "unknown"> = emailDomainCheck;
export function setWebDiscoveryMailCheck(check: ((domain: string) => Promise<"accepts" | "rejects" | "unknown">) | null): void {
  mailCheck = check ?? emailDomainCheck;
}

export function normalizeWebCriteria(
  input: { customers?: unknown; where?: unknown; maxResults?: unknown; language?: unknown; offer?: unknown; ownWebsite?: unknown },
  fallbackLanguage = "en",
): WebDiscoveryCriteria | { error: string } {
  const customers = typeof input.customers === "string" ? input.customers.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  const where = typeof input.where === "string" ? input.where.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (!customers) return { error: "Say who the customers are (in the owner's words or from the business profile)." };
  if (!where) return { error: "Say where to look (a city, area or region)." };
  const requested = Number(input.maxResults ?? DEFAULT_WEB_SITES);
  const maxResults = Number.isFinite(requested) ? Math.min(MAX_WEB_SITES, Math.max(5, Math.round(requested))) : DEFAULT_WEB_SITES;
  const language = typeof input.language === "string" && /^[a-z]{2}$/i.test(input.language) ? input.language.toLowerCase() : fallbackLanguage;
  const offer = typeof input.offer === "string" && input.offer.trim() ? input.offer.trim().slice(0, 300) : null;
  const own = typeof input.ownWebsite === "string" ? ownWebsite(input.ownWebsite) : null;
  return { customers, where, offer, ownWebsite: own, maxResults, language };
}

/** Whether Instagram can be read for discovery in the organization in scope, with its linked account. */
export async function instagramReadiness(): Promise<{ usable: boolean; reason: string | null; accountId: string | null; username: string | null }> {
  const off = (reason: string) => ({ usable: false, reason, accountId: null, username: null });
  if (!(await featureEnabled("instagram"))) return off("Instagram is off for this organization (Settings → Organization → Optional features)");
  if (!(await isPlatformConnected("unipile"))) return off("Unipile is not connected, so Instagram cannot be read");
  const [account] = await db.select({ unipileAccountId: instagramAccounts.unipileAccountId, username: instagramAccounts.username })
    .from(instagramAccounts)
    .where(and(inOrg(instagramAccounts), eq(instagramAccounts.status, "connected")))
    .orderBy(asc(instagramAccounts.createdAt))
    .limit(1);
  if (!account) return off("no Instagram account is connected (Settings → Instagram)");
  return { usable: true, reason: null, accountId: account.unipileAccountId, username: account.username?.toLowerCase() ?? null };
}

/** Starts a website and directory discovery: an audience to fill and the job that fills it. */
export async function startWebDiscovery(
  criteria: WebDiscoveryCriteria,
  context: { threadId: string | null; userId: string | null },
  options: { contactAfter?: ContactAfter } = {},
): Promise<{ jobId: string; audienceId: string; phrase: string; queries: string[]; provider: string; model: string; instagram: { usable: boolean; reason: string | null } }> {
  if (!(await featureEnabled("web_discovery"))) throw new WebDiscoveryUnavailableError(new FeatureDisabledError("web_discovery").message);
  const availability = await webSearchAvailability();
  if (!availability.available) throw new WebDiscoveryUnavailableError(availability.reason ?? "No web-searching AI provider is set up.");
  const readiness = await instagramReadiness();
  const instagram = { usable: readiness.usable, reason: readiness.reason };
  const queries = buildSearchQueries({ customers: criteria.customers, offer: criteria.offer, where: criteria.where, language: criteria.language, instagram: instagram.usable });
  const phrase = `${criteria.customers} in ${criteria.where}`;
  const audienceId = await createAudience({
    name: `${criteria.customers} — ${criteria.where} (web)`,
    source: "discovery",
    criteria: { source: WEB_DISCOVERY_SOURCE, queries, where: criteria.where, customers: criteria.customers, maxResults: criteria.maxResults },
    threadId: context.threadId,
    userId: context.userId,
  });
  const payload: Payload = { criteria, queries, phrase, instagram, contactAfter: options.contactAfter ?? null };
  const [job] = await db.insert(assistantJobs).values({
    organizationId: currentOrganizationId(),
    kind: "web_discovery",
    threadId: context.threadId,
    audienceId,
    payload: payload as unknown as Record<string, unknown>,
    progress: { stage: "queued", found: 0, searches: queries.length },
    createdBy: context.userId,
  }).returning({ id: assistantJobs.id });
  return { jobId: job!.id, audienceId, phrase, queries, provider: availability.provider!, model: availability.model!, instagram };
}

// ── Stages ──────────────────────────────────────────────────────────────────

function payloadOf(job: AssistantJob): Payload {
  return job.payload as unknown as Payload;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function stageQueued(job: AssistantJob): Promise<StepOutcome> {
  // The feature may have been switched off since the owner asked.
  if (!(await featureEnabled("web_discovery"))) return { next: "failed", error: new FeatureDisabledError("web_discovery").message };
  const { queries } = payloadOf(job);
  return {
    next: "stage",
    stage: "searching",
    payload: { searchIndex: 0, searches: [], candidates: [], skipped: [], skippedCount: 0 },
    progress: { stage: "searching", searches: queries.length, searchesDone: 0 },
  };
}

function candidateKey(candidate: Pick<Candidate, "kind" | "url">): string {
  if (candidate.kind === "own_site") return `site:${websiteDomain(candidate.url) ?? candidate.url}`;
  if (candidate.kind === "directory") return `directory:${candidate.url.replace(/#.*$/, "")}`;
  const target = instagramTarget(candidate.url);
  if (target?.kind === "instagram_profile") return `instagram:${target.username}`;
  if (target?.kind === "instagram_post") return `post:${target.shortcode}`;
  return candidate.url;
}

const isInstagram = (kind: Candidate["kind"]) => kind === "instagram_profile" || kind === "instagram_post";

/** Whether a candidate list may still take one of this kind, under the run's bounds. */
function room(candidates: readonly Candidate[], kind: Candidate["kind"], criteria: WebDiscoveryCriteria): boolean {
  if (kind === "own_site") return candidates.filter((candidate) => candidate.kind === "own_site").length < criteria.maxResults;
  if (kind === "directory") return candidates.filter((candidate) => candidate.kind === "directory").length < MAX_DIRECTORY_PAGES;
  return candidates.filter((candidate) => isInstagram(candidate.kind)).length < MAX_INSTAGRAM_STARTS;
}

function skip(payload: Payload, url: string, reason: string): void {
  const skipped = payload.skipped ?? [];
  if (skipped.some((item) => item.url === url)) return;
  payload.skippedCount = (payload.skippedCount ?? 0) + 1;
  if (skipped.length < MAX_SKIPPED_KEPT) skipped.push({ url, reason });
  payload.skipped = skipped;
}

/** Adds a candidate unless it is already there, is the owner's own site, or the run's bounds are reached. */
function addCandidate(payload: Payload, candidate: Candidate): boolean {
  const candidates = payload.candidates ?? [];
  const key = candidateKey(candidate);
  if (candidates.some((existing) => candidateKey(existing) === key)) return false;
  const ownDomain = websiteDomain(payload.criteria.ownWebsite);
  if (candidate.kind === "own_site" && ownDomain && websiteDomain(candidate.url) === ownDomain) return false;
  if (!room(candidates, candidate.kind, payload.criteria)) return false;
  candidates.push(candidate);
  payload.candidates = candidates;
  return true;
}

async function stageSearching(job: AssistantJob, heartbeat: () => Promise<void>): Promise<StepOutcome> {
  const payload = payloadOf(job);
  const index = payload.searchIndex ?? 0;
  const query = payload.queries[index];
  const searches = [...(payload.searches ?? [])];
  if (query) {
    try {
      const result = await searchWeb(query);
      searches.push({ query, sources: result.sources.length, provider: result.provider, model: result.model, costUsd: result.costUsd, error: result.sources.length ? null : "the provider returned no web sources" });
      for (const source of result.sources) {
        const origin: Origin = { query, url: source.url, title: source.title, snippet: source.snippet };
        const kind = classifySourceUrl(source.url);
        if (kind === "own_site" || kind === "directory") {
          addCandidate(payload, { kind, url: source.url, origin });
        } else if (kind === "instagram_profile" || kind === "instagram_post") {
          const target = instagramTarget(source.url)!;
          if (!payload.instagram.usable) skip(payload, target.url, `Instagram ${kind === "instagram_post" ? "post" : "profile"} not read: ${payload.instagram.reason}`);
          else addCandidate(payload, { kind, url: target.url, origin });
        } else {
          skip(payload, source.url, unusableReason(kind, source.url) ?? "not readable");
        }
      }
    } catch (error) {
      if (error instanceof WebSearchUnavailableError) return { next: "failed", error: error.message };
      searches.push({ query, sources: 0, provider: null, model: null, costUsd: null, error: message(error).slice(0, 300) });
    }
    await heartbeat();
  }
  const next = index + 1;
  const common = { searches, candidates: payload.candidates ?? [], skipped: payload.skipped ?? [], skippedCount: payload.skippedCount ?? 0 };
  if (next < payload.queries.length) {
    return { next: "stage", stage: "searching", payload: { ...common, searchIndex: next }, progress: { stage: "searching", searches: payload.queries.length, searchesDone: next, candidates: common.candidates.length } };
  }
  // Every call failed (none answered at all): the provider's error, not "nothing found".
  if (searches.length && searches.every((search) => search.provider === null)) {
    return { next: "failed", error: `The web search failed: ${searches[0]!.error}` };
  }
  return {
    next: "stage",
    stage: "reading",
    payload: { ...common, searchIndex: next, readIndex: 0, leads: [] },
    progress: { stage: "reading", searches: payload.queries.length, searchesDone: next, candidates: common.candidates.length, read: 0 },
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────

const GENERIC_TITLE_PART = /^(?:home|homepage|home page|welcome|index|contact|contact us|about|about us|official (?:web)?site|website)$/i;

/** A business name from a page title ("Home | Lotus Dental Care" → "Lotus Dental Care"); null when none reads like one. */
function nameFromTitle(title: string | null): string | null {
  if (!title?.trim()) return null;
  const parts = title.split(/\s+[|•·–—-]\s+|\s*\|\s*/).map((part) => part.trim()).filter((part) => part && !GENERIC_TITLE_PART.test(part));
  return parts[0] ? cleanBusinessName(parts[0]).slice(0, 120) : null;
}

type ReadOutput = { leads: FoundLead[]; candidates: Candidate[]; skipped: { url: string; reason: string }[] };

type ReadContext = {
  country: string | undefined;
  instagram: { usable: boolean; reason: string | null; accountId: string | null; username: string | null } | null;
};

function phonesOf(values: { value: string; sourceUrl: string }[], country: string | undefined, source: string): FoundContactValue[] {
  const out: FoundContactValue[] = [];
  for (const contact of values) {
    const checked = checkPhone(contact.value, country);
    if (checked.ok && !out.some((phone) => phone.value === checked.e164)) out.push({ value: checked.e164, sourceUrl: contact.sourceUrl, source });
  }
  return out;
}

async function readSite(candidate: Candidate, context: ReadContext): Promise<ReadOutput> {
  const website = ownWebsite(candidate.url) ?? candidate.url;
  const domain = websiteDomain(website);
  const result = await collectWebsiteContacts(website, discoveryPageOptions());
  const emails = result.contacts.filter((contact) => contact.kind === "email").map((contact) => ({ value: contact.value, sourceUrl: contact.sourceUrl, source: "the business's website" }));
  const phones = phonesOf(result.contacts.filter((contact) => contact.kind === "phone"), context.country, "the business's website");
  const companyLinkedin = result.contacts.find((contact) => contact.kind === "linkedin" && /\/company\//.test(contact.value))?.value ?? null;
  const direct = !candidate.via;
  const name = candidate.label?.trim() || (direct ? nameFromTitle(candidate.origin.title) : null) || domain || website;
  // Where it was found: the search result itself, the directory page that linked it, or the Instagram profile.
  const sourceUrl = candidate.via === "website_of" ? candidate.instagram?.url ?? candidate.origin.url : candidate.origin.url;
  const facts: Record<string, string> = { businessName: name, website, foundVia: "web search", searchQuery: candidate.origin.query };
  if (candidate.via === "linked_from") facts.directoryPage = candidate.origin.url;
  if (candidate.instagram) facts.instagram = candidate.instagram.url;
  return {
    leads: [{
      kind: "site",
      name,
      sourceUrl,
      matchReason: matchReasonFor({ ...candidate.origin, via: candidate.via }),
      website,
      domain,
      emails,
      phones,
      companyLinkedin,
      instagram: candidate.instagram ? { ...candidate.instagram, sourceUrl: candidate.instagram.url, source: "Instagram profile" } : null,
      signals: [],
      error: result.error,
      facts,
    }],
    candidates: [],
    skipped: [],
  };
}

async function readDirectory(candidate: Candidate, context: ReadContext): Promise<ReadOutput> {
  let page: { url: string; html: string } | null;
  try {
    page = await fetchPublicPage(candidate.url, discoveryPageOptions());
  } catch (error) {
    return { leads: [], candidates: [], skipped: [{ url: candidate.url, reason: `the directory page could not be read (${message(error)})` }] };
  }
  if (!page) return { leads: [], candidates: [], skipped: [{ url: candidate.url, reason: "the directory page is not a web page" }] };
  const pageDomain = websiteDomain(page.url);
  const title = candidate.origin.title;
  const label = title ? `the directory page “${title.slice(0, 100)}”` : "the directory page";
  const origin: Origin = { ...candidate.origin, url: page.url };
  const matchReason = matchReasonFor({ ...origin, via: "listed_on" });
  const facts = (value: string): Record<string, string> => ({ listedAs: value, directoryPage: page!.url, foundVia: "web search", searchQuery: candidate.origin.query });
  // The page's own contacts, each its own lead (a directory does not say
  // which phone goes with which address). The directory operator's own
  // addresses (on the directory's domain) are not listings.
  const contacts = extractContacts(page.html, page.url)
    .filter((contact) => contact.kind !== "linkedin")
    .filter((contact) => contact.kind !== "email" || !pageDomain || !((contact.value.split("@")[1] ?? "") === pageDomain || (contact.value.split("@")[1] ?? "").endsWith(`.${pageDomain}`)))
    .slice(0, MAX_DIRECTORY_CONTACTS);
  const leads: FoundLead[] = [];
  for (const contact of contacts) {
    const phones = contact.kind === "phone" ? phonesOf([contact], context.country, label) : [];
    if (contact.kind === "phone" && !phones.length) continue;
    const value = contact.kind === "phone" ? phones[0]!.value : contact.value;
    leads.push({
      kind: "directory_contact",
      name: `${value} (listed on ${pageDomain ?? "a directory"})`,
      sourceUrl: page.url,
      matchReason,
      website: null,
      domain: null,
      emails: contact.kind === "email" ? [{ value: contact.value, sourceUrl: contact.sourceUrl, source: label }] : [],
      phones,
      companyLinkedin: null,
      instagram: null,
      signals: [],
      error: null,
      facts: facts(value),
    });
  }
  const candidates: Candidate[] = directoryBusinessLinks(page.html, page.url, MAX_DIRECTORY_LINKS).map((link) => ({
    kind: "own_site",
    url: link.url,
    origin,
    via: "linked_from",
    label: link.text,
  }));
  return { leads, candidates, skipped: [] };
}

function unipileProblem(error: unknown, what: string): string {
  const status = unipileFailureStatus(error);
  return `Unipile could not read this Instagram ${what}${status ? ` (HTTP ${status})` : ""}: ${message(error).slice(0, 200)}`;
}

async function readInstagramProfile(candidate: Candidate, context: ReadContext): Promise<ReadOutput> {
  const target = instagramTarget(candidate.url);
  if (!target || target.kind !== "instagram_profile") return { leads: [], candidates: [], skipped: [{ url: candidate.url, reason: "not an Instagram profile" }] };
  if (!context.instagram?.usable || !context.instagram.accountId) return { leads: [], candidates: [], skipped: [{ url: target.url, reason: `Instagram profile not read: ${context.instagram?.reason ?? "Instagram is not available"}` }] };
  let profile;
  try {
    profile = await getInstagramProfile(context.instagram.accountId, target.username);
  } catch (error) {
    return { leads: [], candidates: [], skipped: [{ url: target.url, reason: unipileProblem(error, "profile") }] };
  }
  const name = profile.fullName ?? `@${profile.username}`;
  const instagram = { username: profile.username, url: target.url };
  // The website the profile lists, or a link written in its bio (with http(s):// or www., so
  // "Dr.Smile" is never taken for a domain): the business published it.
  const bioSite = profile.biography?.match(/\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/i)?.[0] ?? null;
  const website = ownWebsite(profile.website) ?? ownWebsite(bioSite);
  const candidates: Candidate[] = website
    ? [{ kind: "own_site", url: website, origin: candidate.origin, via: "website_of", label: profile.fullName, instagram }]
    : [];
  const emails = profile.publicEmail ? [{ value: profile.publicEmail, sourceUrl: target.url, source: "the business's Instagram profile" }] : [];
  const phones = profile.publicPhone ? phonesOf([{ value: profile.publicPhone, sourceUrl: target.url }], context.country, "the business's Instagram profile") : [];
  // Without its own contact buttons the profile is a lead only when it lists no website (else its website is).
  const leads: FoundLead[] = emails.length || phones.length || !website
    ? [{
        kind: "instagram_profile",
        name,
        sourceUrl: target.url,
        matchReason: matchReasonFor({ ...candidate.origin }),
        website: null,
        domain: null,
        emails,
        phones,
        companyLinkedin: null,
        instagram: { ...instagram, sourceUrl: target.url, source: "Instagram profile" },
        signals: [],
        error: null,
        facts: { businessName: name, instagram: target.url, ...(profile.biography ? { instagramBio: profile.biography.slice(0, 300) } : {}), foundVia: "web search", searchQuery: candidate.origin.query },
      }]
    : [];
  return { leads, candidates, skipped: [] };
}

async function readInstagramPost(candidate: Candidate, context: ReadContext): Promise<ReadOutput> {
  const target = instagramTarget(candidate.url);
  if (!target || target.kind !== "instagram_post") return { leads: [], candidates: [], skipped: [{ url: candidate.url, reason: "not an Instagram post" }] };
  if (!context.instagram?.usable || !context.instagram.accountId) return { leads: [], candidates: [], skipped: [{ url: target.url, reason: `Instagram post not read: ${context.instagram?.reason ?? "Instagram is not available"}` }] };
  let post;
  try {
    post = await getInstagramPost(context.instagram.accountId, target.shortcode);
  } catch (error) {
    return { leads: [], candidates: [], skipped: [{ url: target.url, reason: unipileProblem(error, "post") }] };
  }
  if (!post) return { leads: [], candidates: [], skipped: [{ url: target.url, reason: "Unipile returned this Instagram post without an id to list its comments by" }] };
  let comments;
  try {
    comments = await listInstagramPostComments(context.instagram.accountId, post.providerId, MAX_POST_COMMENTS);
  } catch (error) {
    return { leads: [], candidates: [], skipped: [{ url: target.url, reason: unipileProblem(error, "post's comments") }] };
  }
  const own = new Set([post.authorUsername, context.instagram.username].filter((value): value is string => Boolean(value)));
  const byAuthor = new Map<string, FoundLead>();
  for (const comment of comments) {
    if (comment.authorUsername && own.has(comment.authorUsername)) continue;
    const key = comment.authorUsername ?? comment.authorName;
    if (!key) continue;
    const signal: LeadSignal = { kind: needSignal(comment.text), text: comment.text.slice(0, 1_000), sourceUrl: target.url, source: "Instagram comment", at: comment.date };
    const existing = byAuthor.get(key);
    if (existing) {
      existing.signals.push(signal);
      continue;
    }
    const profileUrl = comment.authorUsername ? `https://www.instagram.com/${comment.authorUsername}/` : comment.authorProfileUrl;
    byAuthor.set(key, {
      kind: "instagram_commenter",
      name: comment.authorName ?? `@${comment.authorUsername}`,
      sourceUrl: target.url,
      matchReason: matchReasonFor({ ...candidate.origin, url: target.url, via: "commented_on" }),
      website: null,
      domain: null,
      emails: [],
      phones: [],
      companyLinkedin: null,
      instagram: { username: comment.authorUsername ?? key, url: profileUrl ?? target.url, sourceUrl: target.url, source: "Instagram comment" },
      signals: [signal],
      error: null,
      facts: { ...(comment.authorUsername ? { instagramUsername: comment.authorUsername } : {}), instagramPost: target.url, foundVia: "web search", searchQuery: candidate.origin.query },
    });
  }
  return { leads: [...byAuthor.values()], candidates: [], skipped: [] };
}

async function readCandidate(candidate: Candidate, context: ReadContext): Promise<ReadOutput> {
  switch (candidate.kind) {
    case "own_site":
      return readSite(candidate, context);
    case "directory":
      return readDirectory(candidate, context);
    case "instagram_profile":
      return readInstagramProfile(candidate, context);
    case "instagram_post":
      return readInstagramPost(candidate, context);
  }
}

async function stageReading(job: AssistantJob, heartbeat: () => Promise<void>): Promise<StepOutcome> {
  const payload = payloadOf(job);
  payload.candidates = [...(payload.candidates ?? [])];
  const start = payload.readIndex ?? 0;
  const batch = payload.candidates.slice(start, start + READ_BATCH);
  const needsInstagram = batch.some((candidate) => candidate.kind === "instagram_profile" || candidate.kind === "instagram_post");
  const context: ReadContext = {
    country: await organizationPhoneCountry(),
    // Re-checked per step: the account may have been unlinked or the feature switched off.
    instagram: needsInstagram ? await instagramReadiness() : null,
  };
  const outputs: ReadOutput[] = new Array(batch.length);
  const web = batch.map((candidate, index) => ({ candidate, index })).filter((item) => item.candidate.kind === "own_site" || item.candidate.kind === "directory");
  for (let index = 0; index < web.length; index += READ_CONCURRENCY) {
    const chunk = web.slice(index, index + READ_CONCURRENCY);
    const results = await Promise.all(chunk.map((item) => readCandidate(item.candidate, context).catch((error): ReadOutput => ({ leads: [], candidates: [], skipped: [{ url: item.candidate.url, reason: message(error) }] }))));
    results.forEach((result, offset) => {
      outputs[chunk[offset]!.index] = result;
    });
    await heartbeat();
  }
  // Instagram one at a time: its limits are per account.
  for (const item of batch.map((candidate, index) => ({ candidate, index })).filter((entry) => !outputs[entry.index])) {
    outputs[item.index] = await readCandidate(item.candidate, context).catch((error): ReadOutput => ({ leads: [], candidates: [], skipped: [{ url: item.candidate.url, reason: message(error) }] }));
    await heartbeat();
  }
  const leads = [...(payload.leads ?? [])];
  for (const output of outputs) {
    leads.push(...output.leads);
    for (const candidate of output.candidates) {
      if (addCandidate(payload, candidate) || candidate.via !== "website_of") continue;
      if (websiteDomain(candidate.url) === websiteDomain(payload.criteria.ownWebsite)) continue;
      // A profile's website that is not read: say why, so the profile is not lost without a word.
      const known = (payload.candidates ?? []).some((existing) => candidateKey(existing) === candidateKey(candidate));
      skip(payload, candidate.url, known
        ? `listed on the Instagram profile ${candidate.instagram?.url ?? ""}; already found through the search`
        : `listed on the Instagram profile ${candidate.instagram?.url ?? ""}; not read: this search's limit of ${payload.criteria.maxResults} websites was reached`);
    }
    for (const item of output.skipped) skip(payload, item.url, item.reason);
  }
  const next = start + batch.length;
  const common = { candidates: payload.candidates, leads, skipped: payload.skipped ?? [], skippedCount: payload.skippedCount ?? 0 };
  const progress = { stage: "reading", candidates: payload.candidates.length, read: next, found: leads.length };
  if (next < payload.candidates.length) return { next: "stage", stage: "reading", payload: { ...common, readIndex: next }, progress };
  // Websites first: a business's own site carries more than a directory's line or a comment.
  const order: Record<FoundLead["kind"], number> = { site: 0, instagram_profile: 1, directory_contact: 2, instagram_commenter: 3 };
  const sorted = leads.map((lead, index) => ({ lead, index })).sort((a, b) => order[a.lead.kind] - order[b.lead.kind] || a.index - b.index).map((entry) => entry.lead);
  return {
    next: "stage",
    stage: "saving",
    payload: { ...common, leads: sorted, readIndex: next, saveIndex: 0, createdIds: [], memberIds: [] },
    progress: { ...progress, stage: "saving", saved: 0 },
  };
}

// ── Saving ──────────────────────────────────────────────────────────────────

function mailCheckText(check: "accepts" | "unknown"): string {
  return check === "accepts" ? "domain has mail servers (MX); mailbox not verified" : "domain's mail servers not checked; mailbox not verified";
}

/** The lead's emails that may be used (syntax, junk and the domain's mail servers checked), best first, and whether one was dropped. */
async function usableEmails(lead: FoundLead): Promise<{ emails: FoundContactValue[]; rejected: number }> {
  const bySource = new Map<string, FoundContactValue>();
  for (const email of lead.emails) {
    const clean = cleanEmail(email.value);
    if (clean && !bySource.has(clean)) bySource.set(clean, { ...email, value: clean });
  }
  const out: FoundContactValue[] = [];
  let rejected = 0;
  for (const value of rankEmails([...bySource.keys()], lead.domain)) {
    const email = bySource.get(value)!;
    const check = await mailCheck(value.split("@")[1]!);
    if (check === "rejects") {
      rejected += 1;
      continue;
    }
    out.push({ ...email, source: `${email.source} · ${mailCheckText(check)}` });
  }
  return { emails: out, rejected };
}

function evidenceOf(lead: FoundLead, emails: FoundContactValue[]): ContactEvidence[] {
  const evidence: ContactEvidence[] = [];
  if (lead.website) {
    const source = lead.facts.directoryPage ? "linked from a directory page" : lead.instagram ? "listed on the business's Instagram profile" : "web search result";
    evidence.push({ kind: "website", value: lead.website, sourceUrl: lead.sourceUrl, source });
  }
  if (lead.instagram) evidence.push({ kind: "instagram", value: lead.instagram.url, sourceUrl: lead.instagram.sourceUrl, source: lead.instagram.source });
  for (const email of emails) evidence.push({ kind: "email", value: email.value, sourceUrl: email.sourceUrl, source: email.source });
  for (const phone of lead.phones) evidence.push({ kind: "phone", value: phone.value, sourceUrl: phone.sourceUrl, source: phone.source });
  if (lead.companyLinkedin) evidence.push({ kind: "linkedin", value: lead.companyLinkedin, sourceUrl: lead.website, source: "the business's website" });
  return evidence;
}

function noContactReason(lead: FoundLead, rejected: number): { reason: string; instagramOnly: boolean } {
  if (lead.kind === "instagram_commenter") return { reason: INSTAGRAM_ONLY_REASON, instagramOnly: true };
  if (lead.kind === "instagram_profile") return { reason: INSTAGRAM_PROFILE_ONLY_REASON, instagramOnly: true };
  if (lead.instagram) return { reason: `${INSTAGRAM_PROFILE_ONLY_REASON} (its website lists no usable email or phone)`, instagramOnly: true };
  if (rejected) return { reason: lead.kind === "site" ? "its published email's domain does not receive mail, and it lists no phone" : "the listed email's domain does not receive mail", instagramOnly: false };
  if (lead.error) return { reason: `its website could not be read (${lead.error})`, instagramOnly: false };
  return { reason: "no email or phone published on its website", instagramOnly: false };
}

/** People of the organization with one of these emails (any case) or phones; email matches first. */
async function existingPerson(emails: string[], phones: string[]): Promise<{ id: string; email: string | null; phone: string | null } | null> {
  if (!emails.length && !phones.length) return null;
  const lowered = emails.map((email) => email.toLowerCase());
  const rows = await db.select({ id: people.id, email: people.email, phone: people.phone }).from(people)
    .where(and(inOrg(people), or(
      lowered.length ? inArray(sql`lower(${people.email})`, lowered) : undefined,
      phones.length ? inArray(people.phone, phones) : undefined,
    )))
    .orderBy(asc(people.createdAt))
    .limit(20);
  for (const email of lowered) {
    const match = rows.find((row) => row.email?.toLowerCase() === email);
    if (match) return match;
  }
  for (const phone of phones) {
    const match = rows.find((row) => row.phone === phone);
    if (match) return match;
  }
  return null;
}

type SaveOutcome = { member: NewMember | null; outcome: "eligible" | "excluded" | "duplicate"; known: boolean; email: boolean; instagramOnly: boolean };

async function saveLead(lead: FoundLead, payload: Payload): Promise<SaveOutcome> {
  const { emails, rejected } = await usableEmails(lead);
  const evidence = evidenceOf(lead, emails);
  const base = { source: WEB_DISCOVERY_SOURCE, sourceUrl: lead.sourceUrl, evidence, facts: lead.facts, matchReason: lead.matchReason, signals: lead.signals };
  const email = emails[0]?.value ?? null;
  const phone = lead.phones[0]?.value ?? null;
  if (!email && !phone) {
    const { reason, instagramOnly } = noContactReason(lead, rejected);
    return { member: { personId: null, name: lead.name, reason, ...base }, outcome: "excluded", known: false, email: false, instagramOnly };
  }
  const memberIds = new Set(payload.memberIds ?? []);
  const createdIds = new Set(payload.createdIds ?? []);
  // Every email and phone the lead has, against everyone the organization already has (and this run created).
  const existing = await existingPerson(emails.map((item) => item.value), lead.phones.map((item) => item.value));
  if (existing && (memberIds.has(existing.id) || createdIds.has(existing.id))) return { member: null, outcome: "duplicate", known: false, email: false, instagramOnly: false };
  let personId: string;
  let hasEmail: boolean;
  if (existing) {
    // Someone the owner already has: used as they are, nothing about them is changed.
    personId = existing.id;
    hasEmail = Boolean(existing.email);
  } else {
    const raw = {
      businessName: lead.name,
      ...(lead.website ? { website: lead.website } : {}),
      ...(lead.instagram ? { instagram: lead.instagram.url } : {}),
      sourcePage: lead.sourceUrl,
      searchQuery: lead.facts.searchQuery ?? "",
      discoveredVia: "web search",
    };
    const company = lead.kind === "directory_contact" ? null : { name: lead.name, domain: lead.domain, linkedinUrl: lead.companyLinkedin };
    const person = await withLeadTransaction(async (tx) => {
      if (email) return upsertPerson(tx, { email, phone, company, raw, source: PERSON_SOURCE });
      const created = await findOrCreateContactPerson(tx, {
        fullName: null,
        phone: phone!,
        companyName: company?.name ?? null,
        companyDomain: company?.domain ?? null,
        title: null,
        email: null,
      }, PERSON_SOURCE);
      await tx.update(people)
        .set({ raw: sql`coalesce(${people.raw}, '{}'::jsonb) || ${JSON.stringify(raw)}::jsonb`, updatedAt: new Date() })
        .where(and(inOrg(people), eq(people.id, created.id)));
      return created;
    });
    personId = person.id;
    hasEmail = Boolean(email);
    createdIds.add(personId);
    payload.createdIds = [...createdIds];
  }
  memberIds.add(personId);
  payload.memberIds = [...memberIds];
  return { member: { personId, ...base }, outcome: "eligible", known: Boolean(existing), email: hasEmail, instagramOnly: false };
}

function emptyTally(): Tally {
  return { eligible: 0, excluded: 0, duplicates: 0, alreadyKnown: 0, withEmail: 0, withPhoneOnly: 0, instagramOnly: 0, needSignals: 0 };
}

async function stageSaving(job: AssistantJob, heartbeat: () => Promise<void>): Promise<StepOutcome> {
  const payload = payloadOf(job);
  const leads = payload.leads ?? [];
  const start = payload.saveIndex ?? 0;
  const tally = payload.tally ?? emptyTally();
  const members: NewMember[] = [];
  for (const lead of leads.slice(start, start + SAVE_BATCH)) {
    const saved = await saveLead(lead, payload);
    if (saved.outcome === "duplicate") tally.duplicates += 1;
    if (saved.member) members.push(saved.member);
    if (saved.known) tally.alreadyKnown += 1;
    if (saved.instagramOnly) tally.instagramOnly += 1;
    if (saved.member) tally.needSignals += lead.signals.some((signal) => signal.kind === "need") ? 1 : 0;
    if (saved.outcome === "eligible") {
      if (saved.email) tally.withEmail += 1;
      else tally.withPhoneOnly += 1;
    }
  }
  await heartbeat();
  if (job.audienceId && members.length) {
    const added = await addAudienceMembers(job.audienceId, members);
    tally.eligible += added.eligible;
    tally.excluded += added.excluded;
  }
  const next = start + SAVE_BATCH;
  const progress = { stage: "saving", saved: Math.min(next, leads.length), found: leads.length, ...tally };
  if (next < leads.length) {
    return { next: "stage", stage: "saving", payload: { saveIndex: next, tally, createdIds: payload.createdIds ?? [], memberIds: payload.memberIds ?? [] }, progress };
  }
  const searches = payload.searches ?? [];
  const costs = searches.map((search) => search.costUsd).filter((cost): cost is number => cost !== null);
  const instagramSkipped = (payload.skipped ?? []).filter((item) => item.reason.startsWith("Instagram ")).length;
  const notes: string[] = [];
  if (!leads.length) {
    const sources = searches.reduce((sum, search) => sum + search.sources, 0);
    notes.push(sources
      ? `The web search for “${payload.phrase}” returned ${sources} pages, but none was a business website, directory${payload.instagram.usable ? " or Instagram profile or post" : ""} it could read. Try other words or a wider area.`
      : `The web search for “${payload.phrase}” returned no pages. Try other words or a wider area.`);
  }
  if (instagramSkipped) notes.push(`${instagramSkipped} Instagram page${instagramSkipped === 1 ? " was" : "s were"} not read: ${payload.instagram.reason ?? "Instagram is not available"}.`);
  return {
    next: "done",
    progress: { ...progress, stage: "done" },
    result: {
      audienceId: job.audienceId,
      phrase: payload.phrase,
      queries: payload.queries,
      found: leads.length,
      ...tally,
      searches,
      sourcesFound: searches.reduce((sum, search) => sum + search.sources, 0),
      candidatesRead: (payload.candidates ?? []).length,
      skipped: payload.skipped ?? [],
      skippedCount: payload.skippedCount ?? 0,
      provider: searches.find((search) => search.provider)?.provider ?? null,
      model: searches.find((search) => search.model)?.model ?? null,
      costUsd: costs.length ? Number(costs.reduce((sum, cost) => sum + cost, 0).toFixed(6)) : null,
      note: notes.length ? notes.join(" ") : null,
    },
  };
}

export async function runWebDiscoveryStep(job: AssistantJob, heartbeat: () => Promise<void>): Promise<StepOutcome> {
  try {
    switch (job.stage) {
      case "queued":
        return await stageQueued(job);
      case "searching":
        return await stageSearching(job, heartbeat);
      case "reading":
        return await stageReading(job, heartbeat);
      case "saving":
        return await stageSaving(job, heartbeat);
      default:
        return { next: "failed", error: `Unknown web discovery stage ${job.stage}` };
    }
  } catch (error) {
    if (error instanceof WebSearchUnavailableError) return { next: "failed", error: error.message };
    throw error;
  }
}
