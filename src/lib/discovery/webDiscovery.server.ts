import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { getByokSettings } from "@/lib/ai/byok";
import { AIML_PROVIDER_KEY, AIML_PROVIDER_NAME } from "@/lib/ai/aimlapi-types";
import { db } from "@/lib/db";
import { addAudienceMembers, createAudience, type NewMember } from "@/lib/assistant/audiences.server";
import { getBusinessProfile } from "@/lib/assistant/profile.server";
import { objectiveStartProblem } from "@/lib/assistant/objective.server";
import { assistantJobs, leadAudienceMembers, type AudienceChannel, type ContactEvidence, type LeadSignal } from "@/lib/assistant/schema";
import type { AssistantJob, StepOutcome } from "@/lib/assistant/worker";
import { findOrCreateContactPerson } from "@/lib/calls/campaigns";
import { checkPhone } from "@/lib/calls/phone";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";
import { featureEnabled, FeatureDisabledError } from "@/lib/features/flags.server";
import { instagramAccounts } from "@/lib/instagram/schema";
import { instagramUsername } from "@/lib/instagram/parse";
import { upsertInstagramProspect } from "@/lib/instagram/prospects.server";
import { upsertPerson, withLeadTransaction } from "@/lib/leads/records";
import { people } from "@/lib/leads/schema";
import { mailboxes } from "@/lib/outreach/schema";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { researchUsedToday } from "@/lib/research/research.server";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { whatsappAccounts } from "@/lib/whatsapp/schema";
import { getInstagramPost, getInstagramProfile, listInstagramPostComments, unipileFailureStatus } from "@/services/unipile.instagramProfiles";
import { cleanEmail, emailMatchesDomain, ownWebsite, websiteDomain } from "./contacts";
import { discoveryPageOptions, mailDomainCheck, type MailDomainCheck } from "./discovery.server";
import { cleanBusinessName, rankEmails } from "./mapsResults";
import {
  buildKeywordQueries,
  buildSearchQueries,
  classifySourceUrl,
  directoryBusinessLinks,
  directoryListingContacts,
  instagramTarget,
  matchReasonFor,
  MAX_SEARCH_QUERIES,
  needSignal,
  ownerMailDomain,
  unusableReason,
  type MatchRelation,
} from "./webDiscovery";
import { tavilyCapProblem } from "@/lib/tavily/catalog";
import { tavilyConnection, tavilySearchesToday } from "@/lib/tavily/tavily.server";
import { TinyfishWaitError } from "@/lib/tinyfish/tinyfish.server";
import { searchWeb, webSearchAvailability, WebSearchUnavailableError, type WebSearchProvider } from "./webSearch.server";
import { collectWebsiteContacts, fetchPublicPage } from "./websiteContacts.server";
import { offerFocus, recipientFields, websiteNotes, type OfferFocus, type WebsiteProfile } from "./websiteProfile";
import { instagramCommenterHold, instagramResearchHold } from "./instagramEligibility";
import { mentionsPlace } from "@/lib/apify/mapping";

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
 * Instagram discovery reads a profile (its listed website and
 * public contact buttons) and a post's comments, each commenter kept with
 * what they wrote as a signal ("need" only for an explicit ask). Nobody is
 * contacted until an outreach plan is approved. Instagram-only profiles
 * stay eligible for that channel without inventing email or phone details.
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
/** At most this many of a lead's emails are checked and kept (best first): each costs DNS lookups. */
const MAX_EMAILS_PER_LEAD = 5;
const MAX_SKIPPED_KEPT = 30;
/** Website searches an organization may have queued or running at once. */
export const MAX_OPEN_WEB_DISCOVERIES = 2;
/** Website searches an organization may start in 24 hours (each is up to 3 paid provider searches). */
export const MAX_WEB_DISCOVERIES_PER_DAY = 10;

export const INSTAGRAM_ONLY_REASON = "no usable Instagram username, email or phone was returned; open the source post to check the profile";
export const INSTAGRAM_PROFILE_ONLY_REASON = "no usable Instagram username, email or phone was returned; open the source profile to check it";

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

type ContactAfter = { channels: AudienceChannel[] | null; ownerRequest?: string; requestId?: string } | null;

/**
 * The search result a candidate came from: what the match reason quotes.
 * `url` is always the page the provider returned; `finalUrl` is where it
 * redirected when it did, the page actually read.
 */
type Origin = { query: string; url: string; title: string | null; snippet: string | null; finalUrl?: string | null };

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
  /** The page the LinkedIn link was on (older payloads: none, the website is used). */
  companyLinkedinSource?: string | null;
  instagram: { username: string; url: string; sourceUrl: string; source: string } | null;
  signals: LeadSignal[];
  /** Why the website could not be read, when it could not. */
  error: string | null;
  facts: Record<string, string>;
  /** What its own website showed for the owner's offer, as read (kept in the payload, so a retry keeps the read time). */
  profile?: WebsiteProfile | null;
};

type SearchRecord = { query: string; sources: number; provider: string | null; model: string | null; costUsd: number | null; error: string | null };
type Tally = { eligible: number; excluded: number; duplicates: number; alreadyKnown: number; withEmail: number; withPhoneOnly: number; withInstagram: number; instagramOnly: number; needSignals: number; ownBusiness?: number };

type Payload = {
  criteria: WebDiscoveryCriteria;
  queries: string[];
  /** The same searches as keywords (buildKeywordQueries), for a search engine such as TinyFish. */
  keywordQueries?: string[];
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
  /** The provider the run started with (research.server.ts counts AI/ML API searches against the research limit). */
  searchProvider?: string | null;
  /** The search a step started paying for, saved before the call: a retried step never buys it again. */
  searchStarted?: number;
  /** The owner's message this search serves (its request's per-platform coverage). */
  requestMessageId?: string | null;
  /** The search job that handed its request to this one, which finds it here if it runs again. */
  handedOffFrom?: string;
};

export class WebDiscoveryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebDiscoveryUnavailableError";
  }
}

/**
 * The organization's website searches are at a limit: the message says which
 * and when to ask again. `slotsFull`: only its open searches are in the way,
 * a wait rather than a limit (an objective tries again when one finishes).
 */
export class WebDiscoveryLimitError extends WebDiscoveryUnavailableError {
  readonly slotsFull: boolean;
  constructor(message: string, options: { slotsFull?: boolean } = {}) {
    super(message);
    this.name = "WebDiscoveryLimitError";
    this.slotsFull = options.slotsFull ?? false;
  }
}

/** Test hook: the mail-server check (scripts stand it in; production uses DNS). */
let mailCheck: (domain: string) => Promise<MailDomainCheck> = (domain) => mailDomainCheck(domain);
export function setWebDiscoveryMailCheck(check: ((domain: string) => Promise<MailDomainCheck>) | null): void {
  mailCheck = check ?? ((domain) => mailDomainCheck(domain));
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

/**
 * The owner's own business, never a lead: the organization's Instagram
 * accounts, its mailboxes (and their domain, unless a free mail provider),
 * its WhatsApp numbers, and the website in its business profile (and the
 * one the search started with).
 */
type OwnerIdentity = { instagram: Set<string>; emails: Set<string>; domains: string[]; phones: Set<string> };

async function ownerIdentity(criteria: WebDiscoveryCriteria): Promise<OwnerIdentity> {
  const [accounts, boxes, numbers, profile] = await Promise.all([
    db.select({ username: instagramAccounts.username }).from(instagramAccounts).where(inOrg(instagramAccounts)),
    db.select({ email: mailboxes.emailAddress }).from(mailboxes).where(inOrg(mailboxes)),
    db.select({ phone: whatsappAccounts.phone }).from(whatsappAccounts).where(inOrg(whatsappAccounts)),
    getBusinessProfile(),
  ]);
  const emails = new Set(boxes.map((box) => box.email.trim().toLowerCase()));
  const domains = new Set<string>();
  for (const site of [criteria.ownWebsite, profile.website]) {
    const domain = websiteDomain(ownWebsite(site));
    if (domain) domains.add(domain);
  }
  for (const email of emails) {
    const domain = ownerMailDomain(email);
    if (domain) domains.add(domain);
  }
  return {
    instagram: new Set(accounts.flatMap((account) => (account.username ? [account.username.replace(/^@/, "").toLowerCase()] : []))),
    emails,
    domains: [...domains],
    phones: new Set(numbers.flatMap((number) => (number.phone ? [number.phone] : []))),
  };
}

const ownsDomain = (owner: OwnerIdentity, domain: string | null) => Boolean(domain) && owner.domains.some((own) => domain === own || domain!.endsWith(`.${own}`));
const ownsEmail = (owner: OwnerIdentity, email: string) => owner.emails.has(email.toLowerCase()) || owner.domains.some((own) => emailMatchesDomain(email.toLowerCase(), own));

/** Starts a website and directory discovery: an audience to fill and the job that fills it. */
export async function startWebDiscovery(
  criteria: WebDiscoveryCriteria,
  context: { threadId: string | null; userId: string | null },
  options: { contactAfter?: ContactAfter; requestMessageId?: string | null; handedOffFrom?: string | null } = {},
): Promise<{ jobId: string; audienceId: string; phrase: string; queries: string[]; provider: string; model: string; instagram: { usable: boolean; reason: string | null } }> {
  if (!(await featureEnabled("web_discovery"))) throw new WebDiscoveryUnavailableError(new FeatureDisabledError("web_discovery").message);
  const availability = await webSearchAvailability();
  if (!availability.available) throw new WebDiscoveryUnavailableError(availability.reason ?? "No web search is set up.");
  // A request paused, stopped or at its limit starts no new search, including one another search hands over.
  const closed = await objectiveStartProblem(options.requestMessageId ?? options.contactAfter?.requestId ?? null);
  if (closed) throw new WebDiscoveryUnavailableError(`Not started: ${closed}.`);
  const readiness = await instagramReadiness();
  const instagram = { usable: readiness.usable, reason: readiness.reason };
  const queries = buildSearchQueries({ customers: criteria.customers, offer: criteria.offer, where: criteria.where, language: criteria.language, instagram: instagram.usable });
  const keywordQueries = buildKeywordQueries({ customers: criteria.customers, where: criteria.where, instagram: instagram.usable });
  const phrase = `${criteria.customers} in ${criteria.where}`;
  const organizationId = currentOrganizationId();
  // One start at a time per organization (a transaction-scoped lock), so two requests cannot both pass the limits.
  const started = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`web_discovery:${organizationId}`}, 0))`);
    const [counts] = await tx.select({
      open: sql<number>`count(*) filter (where ${assistantJobs.status} in ('queued', 'running'))::int`,
      recent: sql<number>`count(*) filter (where ${assistantJobs.createdAt} > now() - interval '24 hours')::int`,
    }).from(assistantJobs).where(and(inOrg(assistantJobs), eq(assistantJobs.kind, "web_discovery")));
    const open = Number(counts?.open ?? 0);
    const recent = Number(counts?.recent ?? 0);
    if (open >= MAX_OPEN_WEB_DISCOVERIES) {
      throw new WebDiscoveryLimitError(`${open} website search${open === 1 ? " is" : "es are"} already running for this organization (at most ${MAX_OPEN_WEB_DISCOVERIES} at a time). Ask again when one has finished; lead_search_status shows their progress.`, { slotsFull: true });
    }
    if (availability.provider === "tavily") {
      // Tavily: the owner's own daily cap of searches (Settings → Organization → Tavily) replaces the fixed one.
      const tavily = await tavilyConnection();
      const problem = tavily ? tavilyCapProblem(await tavilySearchesToday(tx), queries.length, tavily.dailySearches) : "no Tavily key is saved";
      if (problem) throw new WebDiscoveryLimitError(`Not started: ${problem}. It frees up as the last 24 hours pass; owners and admins can raise it.`);
    } else if (availability.provider !== "tinyfish" && recent >= MAX_WEB_DISCOVERIES_PER_DAY) {
      // TinyFish searches are free and bounded by its own allowance (lib/tinyfish/), which waits rather than refuses.
      throw new WebDiscoveryLimitError(`This organization has started ${recent} website searches in the last 24 hours, the most allowed (${MAX_WEB_DISCOVERIES_PER_DAY}; each is up to ${MAX_SEARCH_QUERIES} paid web searches). Ask again later, or use Google Maps search, which has no per-search fee.`);
    }
    if (availability.provider === AIML_PROVIDER_KEY) {
      // AI/ML API searches with the research model, so they count against its daily research limit.
      const limit = (await getByokSettings()).researchDailyLimit;
      const used = await researchUsedToday();
      if (used + queries.length > limit) {
        throw new WebDiscoveryLimitError(`Today's web research limit on ${AIML_PROVIDER_NAME} (${limit}, Settings → AI provider) leaves ${Math.max(0, limit - used)} search${limit - used === 1 ? "" : "es"}; this request needs ${queries.length}. It resets at 00:00 UTC; owners and admins can raise it.`);
      }
    }
    const audienceId = await createAudience({
      name: `${criteria.customers} — ${criteria.where} (web)`,
      source: "discovery",
      criteria: { source: WEB_DISCOVERY_SOURCE, queries, where: criteria.where, customers: criteria.customers, maxResults: criteria.maxResults },
      threadId: context.threadId,
      userId: context.userId,
    });
    const payload: Payload = { criteria, queries, keywordQueries, phrase, instagram, contactAfter: options.contactAfter ?? null, searchProvider: availability.provider, requestMessageId: options.requestMessageId ?? null, ...(options.handedOffFrom ? { handedOffFrom: options.handedOffFrom } : {}) };
    const [job] = await tx.insert(assistantJobs).values({
      organizationId,
      kind: "web_discovery",
      threadId: context.threadId,
      audienceId,
      payload: payload as unknown as Record<string, unknown>,
      progress: { stage: "queued", found: 0, searches: queries.length },
      createdBy: context.userId,
    }).returning({ id: assistantJobs.id });
    return { jobId: job!.id, audienceId };
  });
  return { ...started, phrase, queries, provider: availability.provider!, model: availability.model!, instagram };
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

/** Whether a candidate is the owner's own website or Instagram profile. */
function ownersCandidate(candidate: Candidate, owner: OwnerIdentity): boolean {
  if (candidate.kind === "own_site") return ownsDomain(owner, websiteDomain(candidate.url));
  const target = instagramTarget(candidate.url);
  return target?.kind === "instagram_profile" && owner.instagram.has(target.username);
}

/** Adds a candidate unless it is already there, is the owner's own site or profile, or the run's bounds are reached. */
function addCandidate(payload: Payload, candidate: Candidate, owner: OwnerIdentity): boolean {
  const candidates = payload.candidates ?? [];
  const key = candidateKey(candidate);
  if (candidates.some((existing) => candidateKey(existing) === key)) return false;
  if (ownersCandidate(candidate, owner)) return false;
  if (!room(candidates, candidate.kind, payload.criteria)) return false;
  candidates.push(candidate);
  payload.candidates = candidates;
  return true;
}

/**
 * Writes part of the job's payload now, while this worker still holds the
 * job (a step's outcome is otherwise stored only when the step returns), and
 * beats the heartbeat with it.
 */
async function savePayload(job: AssistantJob, patch: Partial<Payload>): Promise<void> {
  await db.update(assistantJobs)
    .set({ payload: sql`${assistantJobs.payload} || ${JSON.stringify(patch)}::jsonb`, heartbeatAt: new Date() })
    .where(and(inOrg(assistantJobs), eq(assistantJobs.id, job.id), job.lockedBy ? eq(assistantJobs.lockedBy, job.lockedBy) : sql`false`));
}

const INTERRUPTED_SEARCH = "this search stopped after it was sent to the provider and is not repeated, so it is never paid for twice";

async function stageSearching(job: AssistantJob, heartbeat: () => Promise<void>): Promise<StepOutcome> {
  // The feature may have been switched off since the last search: stop before paying for another.
  if (!(await featureEnabled("web_discovery"))) {
    return { next: "failed", error: `${new FeatureDisabledError("web_discovery").message} The search stopped before its remaining paid searches.` };
  }
  const payload = payloadOf(job);
  const index = payload.searchIndex ?? 0;
  const query = payload.queries[index];
  const searches = [...(payload.searches ?? [])];
  if (query && payload.searchStarted === index) {
    // A step that started this paid search stopped before saving its result (a crash, a database
    // error): it may have been billed, so it is recorded as interrupted rather than bought again.
    searches.push({ query, sources: 0, provider: null, model: null, costUsd: null, error: INTERRUPTED_SEARCH });
  } else if (query) {
    const owner = await ownerIdentity(payload.criteria);
    // Saved before the call: if this step dies after paying, the retry sees it (above).
    await savePayload(job, { searchStarted: index });
    try {
      const result = await searchWeb(query, { provider: (payload.searchProvider ?? null) as WebSearchProvider | null, keywords: payload.keywordQueries?.[index] ?? null, jobId: job.id });
      searches.push({ query, sources: result.sources.length, provider: result.provider, model: result.model, costUsd: result.costUsd, error: result.sources.length ? null : "the provider returned no web sources" });
      for (const source of result.sources) {
        const origin: Origin = { query, url: source.url, title: source.title, snippet: source.snippet };
        const kind = classifySourceUrl(source.url);
        if (kind === "own_site" || kind === "directory") {
          if (kind === "own_site" && ownsDomain(owner, websiteDomain(source.url))) skip(payload, source.url, "the owner's own website");
          else addCandidate(payload, { kind, url: source.url, origin }, owner);
        } else if (kind === "instagram_profile" || kind === "instagram_post") {
          const target = instagramTarget(source.url)!;
          if (target.kind === "instagram_profile" && owner.instagram.has(target.username)) skip(payload, target.url, "the owner's own Instagram profile");
          else if (!payload.instagram.usable) skip(payload, target.url, `Instagram ${kind === "instagram_post" ? "post" : "profile"} not read: ${payload.instagram.reason}`);
          else addCandidate(payload, { kind, url: target.url, origin }, owner);
        } else {
          skip(payload, source.url, unusableReason(kind, source.url) ?? "not readable");
        }
      }
    } catch (error) {
      if (error instanceof WebSearchUnavailableError) return { next: "failed", error: error.message };
      if (error instanceof TinyfishWaitError) {
        // Nothing was bought (TinyFish refused before or without charging): wait for its allowance and run this search then.
        await savePayload(job, { searchStarted: -1 });
        const delayMs = Math.max(1_000, error.until.getTime() - Date.now());
        return { next: "wait", delayMs, payload: { searchStarted: -1 }, progress: { stage: "searching", searches: payload.queries.length, searchesDone: index, candidates: (payload.candidates ?? []).length, waiting: { kind: "quota", provider: "tinyfish", until: error.until.toISOString(), reason: error.reason } } };
      }
      searches.push({ query, sources: 0, provider: null, model: null, costUsd: null, error: message(error).slice(0, 300) });
    }
    // The paid result is stored at once, before anything else can fail this step.
    await savePayload(job, { searches, candidates: payload.candidates ?? [], skipped: payload.skipped ?? [], skippedCount: payload.skippedCount ?? 0, searchIndex: index + 1 });
    await heartbeat().catch(() => undefined);
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
  /** The organization's saved offer and customers, which website findings are matched against. */
  focus: OfferFocus;
  instagram: { usable: boolean; reason: string | null; accountId: string | null; username: string | null } | null;
  owner: OwnerIdentity;
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
  const result = await collectWebsiteContacts(website, discoveryPageOptions(), context.focus);
  const emails = result.contacts.filter((contact) => contact.kind === "email").map((contact) => ({ value: contact.value, sourceUrl: contact.sourceUrl, source: "the business's website" }));
  const phones = phonesOf(result.contacts.filter((contact) => contact.kind === "phone"), context.country, "the business's website");
  const linkedin = result.contacts.find((contact) => contact.kind === "linkedin" && /\/company\//.test(contact.value)) ?? null;
  const direct = !candidate.via;
  const name = candidate.label?.trim() || (direct ? nameFromTitle(candidate.origin.title) : null) || domain || website;
  // Where it was found: the search result itself, the directory page that linked it (as read,
  // after any redirect), or the Instagram profile.
  const directoryPage = candidate.origin.finalUrl ?? candidate.origin.url;
  const sourceUrl = candidate.via === "website_of" ? candidate.instagram?.url ?? candidate.origin.url : candidate.via === "linked_from" ? directoryPage : candidate.origin.url;
  const facts: Record<string, string> = { businessName: name, website, foundVia: "web search", searchQuery: candidate.origin.query };
  if (candidate.via === "linked_from") {
    facts.directoryPage = directoryPage;
    if (directoryPage !== candidate.origin.url) facts.searchResult = candidate.origin.url;
  }
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
      companyLinkedin: linkedin?.value ?? null,
      companyLinkedinSource: linkedin?.sourceUrl ?? null,
      instagram: candidate.instagram ? { ...candidate.instagram, sourceUrl: candidate.instagram.url, source: "Instagram profile" } : null,
      signals: [],
      error: result.error,
      facts,
      profile: result.profile,
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
  // The provider's URL stays the origin; the page read after a redirect is kept beside it.
  const origin: Origin = { ...candidate.origin, finalUrl: page.url !== candidate.origin.url ? page.url : null };
  const matchReason = matchReasonFor({ ...origin, via: "listed_on" });
  const facts = (value: string): Record<string, string> => ({
    listedAs: value,
    directoryPage: page!.url,
    ...(origin.finalUrl ? { searchResult: candidate.origin.url } : {}),
    foundVia: "web search",
    searchQuery: candidate.origin.query,
  });
  // The listings' contacts, each its own lead (a directory does not say which
  // phone goes with which address). Not the directory's own: its header,
  // navigation and footer, a helpline repeated beside the listings, its
  // domain's addresses. Nor the owner's own.
  const contacts = directoryListingContacts(page.html, page.url)
    .filter((contact) => !(contact.kind === "email" && ownsEmail(context.owner, contact.value)))
    .slice(0, MAX_DIRECTORY_CONTACTS);
  const leads: FoundLead[] = [];
  for (const contact of contacts) {
    const phones = contact.kind === "phone" ? phonesOf([contact], context.country, label) : [];
    if (contact.kind === "phone" && (!phones.length || context.owner.phones.has(phones[0]!.value))) continue;
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
  // The post's author and the owner's own accounts are not commenters to find.
  const own = new Set([post.authorUsername, context.instagram.username, ...context.owner.instagram].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase()));
  const byAuthor = new Map<string, FoundLead>();
  for (const comment of comments) {
    if (comment.authorUsername && own.has(comment.authorUsername.toLowerCase())) continue;
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
    focus: offerFocus(await getBusinessProfile()),
    // Re-checked per step: the account may have been unlinked or the feature switched off.
    instagram: needsInstagram ? await instagramReadiness() : null,
    owner: await ownerIdentity(payload.criteria),
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
      if (addCandidate(payload, candidate, context.owner) || candidate.via !== "website_of") continue;
      if (ownersCandidate(candidate, context.owner)) continue;
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

/** What the mail check showed, in the evidence's words; never more than it showed. */
export function mailCheckText(check: Exclude<MailDomainCheck, "rejects">): string {
  if (check === "mx") return "domain has mail servers (MX); mailbox not verified";
  // No MX record, but an address record mail servers fall back to.
  if (check === "address") return "domain can receive mail; mailbox not verified";
  return "domain's mail servers not checked; mailbox not verified";
}

/**
 * The lead's emails that may be used (syntax, junk and the domain's mail
 * servers checked), best first, at most MAX_EMAILS_PER_LEAD; how many were
 * dropped because their domain takes no mail.
 */
async function usableEmails(lead: FoundLead, owner: OwnerIdentity): Promise<{ emails: FoundContactValue[]; rejected: number }> {
  const bySource = new Map<string, FoundContactValue>();
  for (const email of lead.emails) {
    const clean = cleanEmail(email.value);
    if (clean && !bySource.has(clean) && !ownsEmail(owner, clean)) bySource.set(clean, { ...email, value: clean });
  }
  const out: FoundContactValue[] = [];
  let rejected = 0;
  for (const value of rankEmails([...bySource.keys()], lead.domain).slice(0, MAX_EMAILS_PER_LEAD)) {
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

function evidenceOf(lead: FoundLead, emails: FoundContactValue[], phones: FoundContactValue[]): ContactEvidence[] {
  const evidence: ContactEvidence[] = [];
  if (lead.website) {
    const source = lead.facts.directoryPage ? "linked from a directory page" : lead.instagram ? "listed on the business's Instagram profile" : "web search result";
    evidence.push({ kind: "website", value: lead.website, sourceUrl: lead.sourceUrl, source, ...(lead.profile ? { checkedAt: lead.profile.checkedAt, pagesRead: lead.profile.pagesRead } : {}) });
  }
  if (lead.instagram) evidence.push({ kind: "instagram", value: lead.instagram.url, sourceUrl: lead.instagram.sourceUrl, source: lead.instagram.source });
  for (const email of emails) evidence.push({ kind: "email", value: email.value, sourceUrl: email.sourceUrl, source: email.source });
  for (const phone of phones) evidence.push({ kind: "phone", value: phone.value, sourceUrl: phone.sourceUrl, source: phone.source });
  // The page the link was on (a contact or about page), not just the site.
  if (lead.companyLinkedin) evidence.push({ kind: "linkedin", value: lead.companyLinkedin, sourceUrl: lead.companyLinkedinSource ?? lead.website, source: "the business's website" });
  return evidence;
}

function noContactReason(lead: FoundLead, rejected: number, ownOnly: boolean): { reason: string; instagramOnly: boolean } {
  if (lead.kind === "instagram_commenter") return { reason: INSTAGRAM_ONLY_REASON, instagramOnly: true };
  if (lead.kind === "instagram_profile") return { reason: INSTAGRAM_PROFILE_ONLY_REASON, instagramOnly: true };
  if (lead.instagram) return { reason: `${INSTAGRAM_PROFILE_ONLY_REASON} (its website lists no usable email or phone)`, instagramOnly: true };
  if (rejected) return { reason: lead.kind === "site" ? "its published email's domain does not receive mail, and it lists no phone" : "the listed email's domain does not receive mail", instagramOnly: false };
  if (ownOnly) return { reason: "the only email or phone it publishes is your own", instagramOnly: false };
  if (lead.error) return { reason: `its website could not be read (${lead.error})`, instagramOnly: false };
  return { reason: "no email or phone published on its website", instagramOnly: false };
}

type ExistingPerson = { id: string; email: string | null; phone: string | null; source: string | null; createdAt: Date };

/** People of the organization with one of these emails (any case) or phones; email matches first. */
async function existingPerson(emails: string[], phones: string[]): Promise<ExistingPerson | null> {
  if (!emails.length && !phones.length) return null;
  const lowered = emails.map((email) => email.toLowerCase());
  const rows = await db.select({ id: people.id, email: people.email, phone: people.phone, source: people.source, createdAt: people.createdAt }).from(people)
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

/**
 * The audience member id of the lead at `index` in this job's list: the
 * same on every attempt, so a retried or taken-over step adds nothing twice
 * (excluded rows have no person to make them unique otherwise).
 */
function stableMemberId(jobId: string, index: number): string {
  const hex = createHash("sha256").update(`web_discovery:${jobId}:${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Whether a lead is the owner's own business: its website's domain or its Instagram account. */
function ownersLead(lead: FoundLead, owner: OwnerIdentity): boolean {
  return ownsDomain(owner, lead.domain) || Boolean(lead.instagram && owner.instagram.has(lead.instagram.username.toLowerCase()));
}

type SaveOutcome = { member: NewMember | null; outcome: "eligible" | "excluded" | "duplicate" | "own"; known: boolean; email: boolean; phone?: boolean; instagramOnly: boolean };

async function saveLead(lead: FoundLead, payload: Payload, context: { job: AssistantJob; index: number; owner: OwnerIdentity }): Promise<SaveOutcome> {
  const { owner } = context;
  if (ownersLead(lead, owner)) return { member: null, outcome: "own", known: false, email: false, instagramOnly: false };
  const { emails, rejected } = await usableEmails(lead, owner);
  const phones = lead.phones.filter((phone) => !owner.phones.has(phone.value));
  const ownContacts = lead.emails.some((item) => ownsEmail(owner, item.value)) || phones.length < lead.phones.length;
  // A directory line that is only the owner's own email or number is the owner, not a lead.
  if (lead.kind === "directory_contact" && ownContacts && !emails.length && !phones.length) return { member: null, outcome: "own", known: false, email: false, instagramOnly: false };
  const evidence = evidenceOf(lead, emails, phones);
  const id = stableMemberId(context.job.id, context.index);
  const email = emails[0]?.value ?? null;
  // What its website showed; the lead is a named person only when the address used is that person's own.
  const notes = websiteNotes(lead.profile, email);
  const base = { id, source: WEB_DISCOVERY_SOURCE, sourceUrl: lead.sourceUrl, evidence, facts: { ...lead.facts, ...notes.facts }, matchReason: lead.matchReason, signals: [...lead.signals, ...notes.signals] };
  const phone = phones[0]?.value ?? null;
  // A comment's fallback key may be a numeric provider ID, not a username.
  const username = lead.kind === "instagram_commenter" && !lead.facts.instagramUsername ? null : instagramUsername(lead.instagram?.username);
  if (!email && !phone && !username) {
    const { reason, instagramOnly } = noContactReason(lead, rejected, ownContacts);
    return { member: { personId: null, name: lead.name, reason, ...base }, outcome: "excluded", known: false, email: false, instagramOnly };
  }
  // An Instagram-only lead is reached by DM through the connected Instagram account once a plan is
  // approved, so it is a lead when verified: a profile read through Unipile that names the place.
  // A commenter's profile is not read, and an unplaced profile is not placed: both are kept for research.
  if (!email && !phone && username && (lead.kind === "instagram_commenter" || lead.kind === "instagram_profile")) {
    const hold = lead.kind === "instagram_commenter"
      ? instagramCommenterHold(lead.sourceUrl)
      : instagramResearchHold({ profileRead: true, placeNamed: mentionsPlace(payload.criteria.where ?? "", lead.facts.instagramBio, lead.name), where: payload.criteria.where });
    if (hold) return { member: { personId: null, name: lead.name, reason: hold, ...base }, outcome: "excluded", known: false, email: false, instagramOnly: true };
  }
  const memberIds = new Set(payload.memberIds ?? []);
  const createdIds = new Set(payload.createdIds ?? []);
  // Every email and phone the lead has, against everyone the organization already has (and this run created).
  const existing = await existingPerson(emails.map((item) => item.value), phones.map((item) => item.value));
  if (existing && (memberIds.has(existing.id) || createdIds.has(existing.id))) return { member: null, outcome: "duplicate", known: false, email: false, instagramOnly: false };
  let personId: string;
  let hasEmail: boolean;
  let known: boolean;
  if (existing) {
    // Reuse the canonical person; a newly observed Instagram route is attached.
    // A person created by this job before a retry is not counted as already known.
    personId = username ? (await withLeadTransaction((tx) => upsertInstagramProspect(tx, username, {
      email, phone, raw: { instagram: { username, profileUrl: lead.instagram!.url } }, source: PERSON_SOURCE,
    }))).id : existing.id;
    hasEmail = Boolean(existing.email);
    known = !(existing.source === PERSON_SOURCE && existing.createdAt >= context.job.createdAt);
  } else {
    const raw = {
      businessName: lead.name,
      ...(lead.website ? { website: lead.website } : {}),
      ...(username && lead.instagram ? { instagram: { username, profileUrl: lead.instagram.url } } : {}),
      sourcePage: lead.sourceUrl,
      searchQuery: lead.facts.searchQuery ?? "",
      discoveredVia: "web search",
    };
    const company = lead.kind === "directory_contact" ? null : { name: lead.name, domain: lead.domain, linkedinUrl: lead.companyLinkedin };
    const person = await withLeadTransaction(async (tx) => {
      if (username) return upsertInstagramProspect(tx, username, { email, phone, company, raw, source: PERSON_SOURCE });
      // A new person (an existing one was matched above): named after the website's person only when the address is theirs.
      if (email) return upsertPerson(tx, { email, phone, company, raw, source: PERSON_SOURCE, ...recipientFields(notes.recipient, null) });
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
    known = false;
    createdIds.add(personId);
    payload.createdIds = [...createdIds];
  }
  if (memberIds.has(personId)) return { member: null, outcome: "duplicate", known: false, email: false, instagramOnly: false };
  memberIds.add(personId);
  payload.memberIds = [...memberIds];
  return { member: { personId, ...base }, outcome: "eligible", known, email: hasEmail, phone: Boolean(phone), instagramOnly: Boolean(username && !email && !phone) };
}

function emptyTally(): Tally {
  return { eligible: 0, excluded: 0, duplicates: 0, alreadyKnown: 0, withEmail: 0, withPhoneOnly: 0, withInstagram: 0, instagramOnly: 0, needSignals: 0, ownBusiness: 0 };
}

/** Eligible and excluded members of the audience as stored: right even when a step ran twice. */
async function memberCounts(audienceId: string): Promise<{ eligible: number; excluded: number }> {
  const [row] = await db.select({
    eligible: sql<number>`count(*) filter (where ${leadAudienceMembers.status} = 'eligible')::int`,
    excluded: sql<number>`count(*) filter (where ${leadAudienceMembers.status} = 'excluded')::int`,
  }).from(leadAudienceMembers).where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.audienceId, audienceId)));
  return { eligible: Number(row?.eligible ?? 0), excluded: Number(row?.excluded ?? 0) };
}

async function stageSaving(job: AssistantJob, heartbeat: () => Promise<void>): Promise<StepOutcome> {
  const payload = payloadOf(job);
  const leads = payload.leads ?? [];
  const start = payload.saveIndex ?? 0;
  const tally = { ...emptyTally(), ...payload.tally };
  const owner = await ownerIdentity(payload.criteria);
  const members: NewMember[] = [];
  const batch = leads.slice(start, start + SAVE_BATCH);
  for (const [offset, lead] of batch.entries()) {
    const saved = await saveLead(lead, payload, { job, index: start + offset, owner });
    if (saved.outcome === "duplicate") tally.duplicates += 1;
    if (saved.outcome === "own") {
      tally.ownBusiness = (tally.ownBusiness ?? 0) + 1;
      skip(payload, lead.sourceUrl, `the owner's own business (${lead.name}), not a lead`);
    }
    if (saved.member) members.push(saved.member);
    if (saved.known) tally.alreadyKnown += 1;
    if (saved.instagramOnly) tally.instagramOnly += 1;
    if (saved.member) tally.needSignals += (saved.member.signals ?? []).some((signal) => signal.kind === "need") ? 1 : 0;
    if (saved.outcome === "eligible") {
      if (saved.email) tally.withEmail += 1;
      else if (saved.phone) tally.withPhoneOnly += 1;
      if (instagramUsername(lead.instagram?.username)) tally.withInstagram += 1;
    }
    // A lead can take several DNS checks: keep the step from looking stalled (3 minutes) and being taken over.
    await heartbeat();
  }
  if (job.audienceId && members.length) {
    const added = await addAudienceMembers(job.audienceId, members);
    tally.eligible += added.eligible;
    tally.excluded += added.excluded;
  }
  const next = start + SAVE_BATCH;
  const kept = { skipped: payload.skipped ?? [], skippedCount: payload.skippedCount ?? 0 };
  if (next < leads.length) {
    const progress = { stage: "saving", saved: Math.min(next, leads.length), found: leads.length, ...tally };
    return { next: "stage", stage: "saving", payload: { saveIndex: next, tally, createdIds: payload.createdIds ?? [], memberIds: payload.memberIds ?? [], ...kept }, progress };
  }
  // The final counts are the audience's rows, so a step that ran twice cannot count anything twice.
  if (job.audienceId) Object.assign(tally, await memberCounts(job.audienceId));
  const progress = { stage: "saving", saved: Math.min(next, leads.length), found: leads.length, ...tally };
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
      skipped: kept.skipped,
      skippedCount: kept.skippedCount,
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
