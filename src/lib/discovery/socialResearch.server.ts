import "server-only";

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { addAudienceMembers, createAudience, type NewMember } from "@/lib/assistant/audiences.server";
import { getBusinessProfile } from "@/lib/assistant/profile.server";
import { AI_SEARCH_ESTIMATE_USD, type SpendRoom } from "@/lib/assistant/objective";
import { jobRequestId, objectiveSpendGuard, objectiveStartProblem, requestSpendCap } from "@/lib/assistant/objective.server";
import { assistantJobs, leadAudienceMembers, type AudienceChannel, type ContactEvidence, type LeadSignal } from "@/lib/assistant/schema";
import type { AssistantJob, StepOutcome } from "@/lib/assistant/worker";
import { findOrCreateContactPerson } from "@/lib/calls/campaigns";
import { checkPhone } from "@/lib/calls/phone";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";
import { featureEnabled, FeatureDisabledError } from "@/lib/features/flags.server";
import { instagramUsername } from "@/lib/instagram/parse";
import { upsertInstagramProspect } from "@/lib/instagram/prospects.server";
import { upsertPerson, withLeadTransaction } from "@/lib/leads/records";
import { people } from "@/lib/leads/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { mentionsPlace } from "@/lib/apify/mapping";
import {
  BRIGHTDATA_LIMITS,
  BRIGHTDATA_USD_PER_CREDIT,
  isBrightdataPlatform,
  PLATFORM_LIMITATIONS,
  PLATFORM_NAMES,
  type BrightdataDatasetKey,
  type BrightdataPlatform,
} from "@/lib/brightdata/catalog";
import { brightdataReadiness, pollCollection, serpSearchThroughBrightdata, startCollection, type CollectionSpec } from "@/lib/brightdata/brightdata.server";
import { readRecords, type SocialFinding } from "@/lib/brightdata/mapping";
import { datasetForUrl } from "@/lib/brightdata/urls";
import { brightdataTaskWaitMs } from "@/lib/brightdata/waits";
import { TinyfishWaitError } from "@/lib/tinyfish/tinyfish.server";
import { cleanEmail, websiteDomain } from "./contacts";
import { discoveryPageOptions } from "./discovery.server";
import { instagramResearchHold } from "./instagramEligibility";
import { rankEmails } from "./mapsResults";
import { needSignal } from "./webDiscovery";
import { mailCheckText, ownerIdentity, ownsDomain, ownsEmail, webDiscoveryMailCheck, type OwnerIdentity } from "./webDiscovery.server";
import { searchWeb, webSearchAvailability, webSearchProviderName, WebSearchUnavailableError, type WebSearchProvider } from "./webSearch.server";
import { collectWebsiteContacts } from "./websiteContacts.server";
import { offerFocus } from "./websiteProfile";

/**
 * Social research through Bright Data (src/lib/brightdata/): what people
 * say about the owner's kind of customers and the need they serve, on
 * Reddit (its posts and comments, found by keyword — the one platform
 * Bright Data searches natively), and on X, Instagram and Facebook (posts,
 * profiles and pages a web search returns, then read through Bright Data).
 * A relevant discussion is research evidence: it is kept with its link,
 * the words quoted, who wrote them and when Bright Data read them. Someone
 * becomes a contactable lead only when their own profile or page — or the
 * website it lists — publishes a contact route: an email, a phone, or an
 * Instagram username for a DM through a connected Instagram sender.
 * Nothing is guessed, and AgentSDR never messages anyone on Reddit, X or
 * Facebook.
 *
 * Runs as an assistant job (worker.ts) in stages, each step bounded so a
 * restart resumes where it stopped, and every paid call recorded before it
 * is made (a retried step polls the collection its first attempt started):
 *   queued → searching (one web search or one collection start per step)
 *   → collecting (one poll per step; then the authors' profiles, once)
 *   → reading (the websites profiles list, a few per step)
 *   → saving (a batch per step) → done.
 * A source that fails keeps what it found and never stops the others.
 */

export const SOCIAL_RESEARCH_SOURCE = "social_research";
const PERSON_SOURCE = "discovery:social-research";
export const MAX_OPEN_SOCIAL_RESEARCH = 2;
/** Keyword searches per platform (each is a paid web search, or one Reddit discovery input). */
const MAX_QUERIES_PER_PLATFORM = 2;
/** Authors whose own profile is read after their post, per platform (each profile is a record). */
const MAX_PROFILE_HOPS = 10;
const MAX_WEBSITE_READS = 12;
const READ_BATCH = 4;
const SAVE_BATCH = 25;
const MAX_FINDINGS_KEPT = 300;
const MAX_FAILURES_KEPT = 30;
const FINDING_TEXT_CHARS = 1_200;
const POLL_DELAY_MS = 20_000;
/** Minimum wait when the provider names none; the task deadline bounds longer waits. */
const MIN_WAIT_MS = 60_000;
/** Collections one job keeps open before it polls them: the organization's cap (BRIGHTDATA_LIMITS.openCollections) is never filled by one job's starts alone. */
const JOB_OPEN_COLLECTIONS = 2;
const MAX_EMAILS_PER_LEAD = 5;

export type SocialResearchCriteria = {
  platforms: BrightdataPlatform[];
  /** Who the customers are, in the owner's words. */
  customers: string;
  /** What they would be asking about or complaining of, in the owner's words; the search terms come from it. */
  need: string | null;
  where: string | null;
  /** Subreddits the owner named, without r/. */
  subreddits: string[];
  /** Exact search phrases the owner gave, used as they are. */
  keywords: string[];
  /** At most this many records across the job (posts, comments do not count, profiles, pages). */
  maxResults: number;
  language: string;
};

type ContactAfter = { channels: AudienceChannel[] | null; ownerRequest?: string; requestId?: string } | null;

export type SourceState = {
  platform: BrightdataPlatform;
  state: "pending" | "searching" | "collecting" | "searched" | "failed" | "not_searched";
  reason: string | null;
  queries: string[];
  /** URLs the web search returned for this platform that Bright Data can read. */
  urls: number;
  /** Findings (posts, comments, profiles, pages) read from it. */
  found: number;
  /** Credits its collections took (estimated from delivered records). */
  credits: number;
  notes: string[];
};

type SearchTask =
  | { kind: "collect"; platform: BrightdataPlatform; spec: CollectionSpec; hop: boolean; label: string }
  | { kind: "web"; platform: BrightdataPlatform; query: string };

type CollectionState = {
  usageId: string;
  snapshotId: string;
  platform: BrightdataPlatform;
  dataset: BrightdataDatasetKey;
  hop: boolean;
  state: "open" | "done" | "failed";
  startedAt: string;
  polls: number;
  reused: boolean;
  findings: number;
  credits: number;
  note: string | null;
};

type FoundUrl = { url: string; dataset: BrightdataDatasetKey; title: string | null; snippet: string | null; query: string };

/** Web search records in the same shape as a website search's, so the request's spend reads them the same way (objective.ts webSearchLedger). */
type SearchRecord = { query: string; sources: number; provider: string | null; model: string | null; costUsd: number | null; error: string | null; estimateUsd?: number };

type WebsiteRead = {
  profileUrl: string;
  website: string;
  emails: { value: string; sourceUrl: string }[];
  phones: { value: string; sourceUrl: string }[];
  error: string | null;
  checkedAt: string;
  pagesRead: string[];
};

type FoundContactValue = { value: string; sourceUrl: string; source: string };

type Lead = {
  /** A profile or page Bright Data read (its contacts are evidence); or an author known only from a post or comment. */
  kind: "identity" | "author";
  platform: BrightdataPlatform;
  name: string;
  username: string | null;
  profileUrl: string | null;
  /** The profile or page, or the discussion the author was found in. */
  sourceUrl: string;
  bio: string | null;
  website: string | null;
  emails: FoundContactValue[];
  phones: FoundContactValue[];
  signals: LeadSignal[];
  matchReason: string;
  facts: Record<string, string>;
  /** Why the author's profile was not read, when it was not. */
  unread: string | null;
};

type Tally = { eligible: number; excluded: number; duplicates: number; alreadyKnown: number; withEmail: number; withPhoneOnly: number; withInstagram: number; needSignals: number; ownBusiness: number };

type Payload = {
  criteria: SocialResearchCriteria;
  phrase: string;
  contactAfter?: ContactAfter;
  requestMessageId?: string | null;
  sources: SourceState[];
  /** How X, Instagram and Facebook URLs are found: a web search provider, Bright Data's SERP zone, or nothing. */
  urlFinder: WebSearchProvider | "brightdata_serp" | null;
  searchProvider?: string | null;
  plan: SearchTask[];
  searchIndex?: number;
  searches?: SearchRecord[];
  searchStarted?: number;
  searchEstimateUsd?: number;
  urls?: Partial<Record<BrightdataPlatform, FoundUrl[]>>;
  collections?: CollectionState[];
  findings?: SocialFinding[];
  failures?: { platform: BrightdataPlatform; input: string | null; reason: string }[];
  /** Records reserved so far against criteria.maxResults. */
  reservedRecords?: number;
  hopsDone?: boolean;
  urlsCollected?: boolean;
  readIndex?: number;
  websites?: WebsiteRead[];
  leads?: Lead[];
  saveIndex?: number;
  tally?: Tally;
  createdIds?: string[];
  memberIds?: string[];
  /** Why no source could be searched at all. */
  notSearched?: string;
  /** When each plan task first had to wait for Bright Data (by index): a task that waits longer than a collection may take is given up. */
  waits?: Record<string, string>;
};

export class SocialResearchUnavailableError extends Error {
  readonly slotsFull: boolean;
  constructor(message: string, options: { slotsFull?: boolean } = {}) {
    super(message);
    this.name = "SocialResearchUnavailableError";
    this.slotsFull = options.slotsFull ?? false;
  }
}

const DEFAULT_RESULTS = 40;

export function normalizeSocialCriteria(
  input: { platforms?: unknown; customers?: unknown; need?: unknown; where?: unknown; subreddits?: unknown; keywords?: unknown; maxResults?: unknown; language?: unknown },
  limits: { maxRecordsPerSearch: number },
  fallbackLanguage = "en",
): SocialResearchCriteria | { error: string } {
  const text = (value: unknown, limit: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "");
  const platforms = [...new Set((Array.isArray(input.platforms) ? input.platforms : []).filter(isBrightdataPlatform))];
  if (!platforms.length) return { error: "Say which platforms to research: any of reddit, x, instagram, facebook." };
  const customers = text(input.customers, 200);
  if (!customers) return { error: "Say who the customers are (in the owner's words or from the business profile)." };
  const need = text(input.need, 300) || null;
  const where = text(input.where, 200) || null;
  const list = (value: unknown, limit: number, each: number) => [...new Set((Array.isArray(value) ? value : []).map((item) => text(item, each)).filter(Boolean))].slice(0, limit);
  const subreddits = list(input.subreddits, 3, 40).map((name) => name.replace(/^\/?r\//i, "").replace(/\/$/, "")).filter((name) => /^[A-Za-z0-9_]{2,21}$/.test(name));
  const keywords = list(input.keywords, 3, 120);
  const requested = Number(input.maxResults ?? DEFAULT_RESULTS);
  const cap = Math.min(limits.maxRecordsPerSearch, BRIGHTDATA_LIMITS.maxRecordsPerSearch.max);
  const maxResults = Number.isFinite(requested) ? Math.min(cap, Math.max(5, Math.round(requested))) : Math.min(cap, DEFAULT_RESULTS);
  const language = typeof input.language === "string" && /^[a-z]{2}$/i.test(input.language) ? input.language.toLowerCase() : fallbackLanguage;
  return { platforms, customers, need, where, subreddits, keywords, maxResults, language };
}

/** The search phrases for a platform: the owner's own, else the need (and the customers with it), with the place when one is named. */
export function socialQueries(criteria: SocialResearchCriteria, platform: BrightdataPlatform): string[] {
  const base = criteria.keywords.length ? criteria.keywords : [criteria.need ?? criteria.customers, criteria.need ? `${criteria.customers} ${criteria.need}` : null].filter((item): item is string => Boolean(item));
  const placed = criteria.where && platform !== "reddit" ? base.map((query) => `${query} ${criteria.where}`) : base;
  const site = platform === "reddit" ? null : platform === "x" ? "site:x.com" : platform === "instagram" ? "site:instagram.com" : "site:facebook.com";
  return [...new Set(placed.map((query) => (site ? `${site} ${query}` : query).replace(/\s+/g, " ").trim()))].slice(0, MAX_QUERIES_PER_PLATFORM);
}

/** Starts social research: an audience to fill and the job that fills it. */
export async function startSocialResearch(
  criteria: SocialResearchCriteria,
  context: { threadId: string | null; userId: string | null },
  options: { contactAfter?: ContactAfter; requestMessageId?: string | null } = {},
): Promise<{ jobId: string; audienceId: string; phrase: string; sources: SourceState[]; urlFinder: string | null }> {
  if (!(await featureEnabled("brightdata"))) throw new SocialResearchUnavailableError(new FeatureDisabledError("brightdata").message);
  const readiness = await brightdataReadiness();
  if (!readiness.usable) throw new SocialResearchUnavailableError(`Not started: ${readiness.reason}.`);
  const requestId = options.requestMessageId ?? options.contactAfter?.requestId ?? null;
  const closed = await objectiveStartProblem(requestId);
  if (closed) throw new SocialResearchUnavailableError(`Not started: ${closed}.`);
  // Bright Data records are paid (its free tier aside): a free-only request ($0 cap) starts none.
  if ((await requestSpendCap(requestId)) === 0) {
    throw new SocialResearchUnavailableError("Not started: this request is limited to free sources (its spend cap is $0), and Bright Data research is metered (one credit per record). Name a budget in the request to use it.");
  }
  const availability = await webSearchAvailability();
  const urlFinder: Payload["urlFinder"] = availability.available ? availability.provider! : readiness.settings.serpZone ? "brightdata_serp" : null;
  const sources: SourceState[] = criteria.platforms.map((platform) => {
    const queries = socialQueries(criteria, platform);
    if (platform === "reddit" && !readiness.settings.redditEnabled) {
      return { platform, state: "not_searched", reason: "Reddit research is off: an owner or admin turns it on in Settings → Providers & features → Bright Data", queries, urls: 0, found: 0, credits: 0, notes: [] };
    }
    if (platform !== "reddit" && !urlFinder) {
      return { platform, state: "not_searched", reason: `${PLATFORM_NAMES[platform]} needs a web search to find its pages (TinyFish, Tavily or an AI provider that searches the web), or a SERP API zone in the Bright Data settings; none is set up`, queries, urls: 0, found: 0, credits: 0, notes: [] };
    }
    return { platform, state: "pending", reason: null, queries, urls: 0, found: 0, credits: 0, notes: [] };
  });
  if (!sources.some((source) => source.state === "pending")) {
    throw new SocialResearchUnavailableError(`Not started: ${sources.map((source) => `${PLATFORM_NAMES[source.platform]} — ${source.reason}`).join("; ")}.`);
  }
  const phrase = [criteria.need ?? criteria.customers, criteria.where ? `in ${criteria.where}` : null].filter(Boolean).join(" ");
  const organizationId = currentOrganizationId();
  const started = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`social_research:${organizationId}`}, 0))`);
    const [counts] = await tx.select({ open: sql<number>`count(*) filter (where ${assistantJobs.status} in ('queued', 'running'))::int` })
      .from(assistantJobs).where(and(inOrg(assistantJobs), eq(assistantJobs.kind, "social_research")));
    const open = Number(counts?.open ?? 0);
    if (open >= MAX_OPEN_SOCIAL_RESEARCH) {
      throw new SocialResearchUnavailableError(`${open} social research job${open === 1 ? " is" : "s are"} already running for this organization (at most ${MAX_OPEN_SOCIAL_RESEARCH} at a time). Ask again when one has finished.`, { slotsFull: true });
    }
    const audienceId = await createAudience({
      name: `${criteria.customers} — ${phrase} (social)`,
      source: "discovery",
      criteria: { source: SOCIAL_RESEARCH_SOURCE, platforms: criteria.platforms, customers: criteria.customers, need: criteria.need, where: criteria.where, maxResults: criteria.maxResults },
      threadId: context.threadId,
      userId: context.userId,
    });
    const payload: Payload = { criteria, phrase, contactAfter: options.contactAfter ?? null, requestMessageId: options.requestMessageId ?? null, sources, urlFinder, searchProvider: urlFinder === "brightdata_serp" ? null : urlFinder, plan: [] };
    const [job] = await tx.insert(assistantJobs).values({
      organizationId,
      kind: "social_research",
      threadId: context.threadId,
      audienceId,
      payload: payload as unknown as Record<string, unknown>,
      progress: { stage: "queued", found: 0, sources: sources.map((source) => ({ platform: source.platform, state: source.state })) },
      createdBy: context.userId,
    }).returning({ id: assistantJobs.id });
    return { jobId: job!.id, audienceId };
  });
  return { ...started, phrase, sources, urlFinder };
}

// ── Stages ──────────────────────────────────────────────────────────────────

function payloadOf(job: AssistantJob): Payload {
  return job.payload as unknown as Payload;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function source(payload: Payload, platform: BrightdataPlatform): SourceState {
  return payload.sources.find((item) => item.platform === platform)!;
}

function note(state: SourceState, text: string): void {
  if (state.notes.length < 4 && !state.notes.includes(text)) state.notes.push(text);
}

function progressOf(payload: Payload, stage: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stage,
    found: (payload.findings ?? []).length,
    sources: payload.sources.map((item) => ({ platform: item.platform, state: item.state, found: item.found, credits: item.credits })),
    credits: payload.sources.reduce((sum, item) => sum + item.credits, 0),
    ...extra,
  };
}

/** Writes part of the payload now, while this worker holds the job, so a paid call's record survives a crash later in the step. */
async function savePayload(job: AssistantJob, patch: Partial<Payload>): Promise<void> {
  await db.update(assistantJobs)
    .set({ payload: sql`${assistantJobs.payload} || ${JSON.stringify(patch)}::jsonb`, heartbeatAt: new Date() })
    .where(and(inOrg(assistantJobs), eq(assistantJobs.id, job.id), job.lockedBy ? eq(assistantJobs.lockedBy, job.lockedBy) : sql`false`));
}

/** The records budget split over the platforms still pending, leaving room for the authors' profiles. */
function platformBudget(payload: Payload): number {
  const pending = payload.sources.filter((item) => item.state === "pending" || item.state === "searching" || item.state === "collecting").length || 1;
  const forProfiles = Math.min(MAX_PROFILE_HOPS * pending, Math.floor(payload.criteria.maxResults / 3));
  return Math.max(3, Math.floor((payload.criteria.maxResults - forProfiles) / pending));
}

async function stageQueued(job: AssistantJob): Promise<StepOutcome> {
  if (!(await featureEnabled("brightdata"))) return { next: "failed", error: new FeatureDisabledError("brightdata").message };
  const payload = payloadOf(job);
  const plan: SearchTask[] = [];
  const budget = platformBudget(payload);
  for (const state of payload.sources) {
    if (state.state !== "pending") continue;
    state.state = "searching";
    if (state.platform === "reddit") {
      const perInput = Math.max(1, Math.floor(budget / Math.max(1, state.queries.length)));
      plan.push({
        kind: "collect", platform: "reddit", hop: false, label: `Reddit posts for ${state.queries.map((query) => `“${query}”`).join(", ")}`,
        spec: { dataset: "reddit_posts", discoverBy: "keyword", inputs: state.queries.map((keyword) => ({ keyword, date: "Past year", num_of_posts: perInput })), limitPerInput: perInput },
      });
      if (payload.criteria.subreddits.length) {
        const perSub = Math.max(1, Math.floor(budget / payload.criteria.subreddits.length));
        const keyword = payload.criteria.keywords[0] ?? payload.criteria.need ?? payload.criteria.customers;
        plan.push({
          kind: "collect", platform: "reddit", hop: false, label: `Reddit posts in ${payload.criteria.subreddits.map((name) => `r/${name}`).join(", ")} about “${keyword}”`,
          spec: { dataset: "reddit_posts", discoverBy: "subreddit_url", inputs: payload.criteria.subreddits.map((name) => ({ url: `https://www.reddit.com/r/${name}/`, keyword, num_of_posts: perSub, sort_by: "Relevance" })), limitPerInput: perSub },
        });
      }
    } else {
      for (const query of state.queries) plan.push({ kind: "web", platform: state.platform, query });
    }
  }
  return {
    next: "stage",
    stage: "searching",
    payload: { sources: payload.sources, plan, searchIndex: 0, searches: [], urls: {}, collections: [], findings: [], failures: [], reservedRecords: 0 },
    progress: progressOf(payload, "searching", { searches: plan.length, searchesDone: 0 }),
  };
}

/** How a URL finder charges: TinyFish free, Tavily in credits, Bright Data SERP guarded by its own ledger, AI web research in dollars. */
function searchPrice(finder: Payload["urlFinder"]): "free" | "credits" | "own" | "usd" {
  if (finder === "tinyfish") return "free";
  if (finder === "tavily") return "credits";
  if (finder === "brightdata_serp") return "own";
  return "usd";
}

/**
 * Records that the next web search is about to be made, once the request's
 * spend guard allows it, in one transaction: a retried step never buys it
 * again (INTERRUPTED below). Free and self-guarded searches pass no guard.
 */
async function reserveWebSearch(job: AssistantJob, index: number): Promise<SpendRoom> {
  const payload = payloadOf(job);
  const price = searchPrice(payload.urlFinder);
  const estimateUsd = price === "usd" ? AI_SEARCH_ESTIMATE_USD : 0;
  const guard = price === "free" || price === "own" ? undefined : await objectiveSpendGuard(jobRequestId(job));
  return db.transaction(async (tx) => {
    const room: SpendRoom = guard ? await guard(tx, estimateUsd, { credits: price === "credits" }) : { ok: true, maxUsd: Number.POSITIVE_INFINITY };
    if (!room.ok) return room;
    const patch: Partial<Payload> = { searchStarted: index, searchEstimateUsd: estimateUsd };
    await tx.update(assistantJobs)
      .set({ payload: sql`${assistantJobs.payload} || ${JSON.stringify(patch)}::jsonb`, heartbeatAt: new Date() })
      .where(and(inOrg(assistantJobs), eq(assistantJobs.id, job.id), job.lockedBy ? eq(assistantJobs.lockedBy, job.lockedBy) : sql`false`));
    return room;
  });
}

const INTERRUPTED_SEARCH = "this search stopped after it was sent to the provider and is not repeated, so it is never paid for twice";

function keepUrl(payload: Payload, platform: BrightdataPlatform, found: FoundUrl): boolean {
  const urls = payload.urls ?? (payload.urls = {});
  const list = urls[platform] ?? (urls[platform] = []);
  if (list.some((item) => item.url === found.url)) return false;
  list.push(found);
  return true;
}

/** The web search tasks are done: the URLs each platform's searches found become one collection per dataset, within its budget. */
function collectTasksFor(payload: Payload): SearchTask[] {
  const tasks: SearchTask[] = [];
  const budget = platformBudget(payload);
  for (const state of payload.sources) {
    if (state.platform === "reddit" || state.state !== "searching") continue;
    const found = payload.urls?.[state.platform] ?? [];
    if (!found.length) {
      state.state = "not_searched";
      state.reason = state.queries.length ? `the web search returned no ${PLATFORM_NAMES[state.platform]} post, profile or page it can read` : "no search terms";
      continue;
    }
    // Posts first (they carry the words), then profiles and pages, within the platform's share of the budget.
    const ordered = [...found].sort((a, b) => Number(/_profiles$|_pages$/.test(a.dataset)) - Number(/_profiles$|_pages$/.test(b.dataset))).slice(0, budget);
    if (ordered.length < found.length) note(state, `${found.length - ordered.length} more ${PLATFORM_NAMES[state.platform]} pages the search returned were not read: this job's limit of ${payload.criteria.maxResults} records`);
    const byDataset = new Map<BrightdataDatasetKey, FoundUrl[]>();
    for (const item of ordered) byDataset.set(item.dataset, [...(byDataset.get(item.dataset) ?? []), item]);
    for (const [dataset, items] of byDataset) {
      tasks.push({ kind: "collect", platform: state.platform, hop: false, label: `${items.length} ${PLATFORM_NAMES[state.platform]} ${dataset.replace(/^[a-z]+_/, "")} from the web search`, spec: { dataset, discoverBy: null, inputs: items.map((item) => ({ url: item.url })), limitPerInput: null } });
    }
  }
  return tasks;
}

/**
 * A wait Bright Data imposed on the plan task at `index` (a rate limit, the
 * organization's open collections): the step sleeps for the time asked,
 * within bounds, and the first wait is remembered so a provider that keeps
 * asking is given up after the time a collection may take (null then). A
 * paused request is not bounded here: it waits as long as the owner pauses.
 */
function waitFor(payload: Payload, index: number, retryAfterMs: number | null): { next: "wait"; delayMs: number; payload: Partial<Payload> } | null {
  const waits = payload.waits ?? (payload.waits = {});
  const since = waits[String(index)] ?? (waits[String(index)] = new Date().toISOString());
  const delayMs = brightdataTaskWaitMs(since, Date.now(), retryAfterMs);
  if (delayMs === null) return null;
  return { next: "wait", delayMs, payload: { waits, sources: payload.sources } };
}

async function startPlannedCollection(job: AssistantJob, payload: Payload, task: Extract<SearchTask, { kind: "collect" }>, index: number): Promise<StepOutcome | null> {
  const state = source(payload, task.platform);
  const started = await startCollection({ spec: task.spec, jobId: job.id, requestId: jobRequestId(job), threadId: job.threadId, spendGuard: await objectiveSpendGuard(jobRequestId(job)) });
  if (!started.started) {
    if (started.wait) {
      // Open collections in the way (this job's, or another's): poll this job's own first, else wait.
      if (started.slotsFull && (payload.collections ?? []).some((item) => item.state === "open")) return pollFirst(payload);
      const waiting = { kind: started.rateLimited ? "quota" : "paused", provider: "brightdata", reason: `${task.label} waits: ${started.reason}` };
      const hold = started.rateLimited || started.slotsFull ? waitFor(payload, index, started.retryAfterMs ?? null) : { next: "wait" as const, delayMs: MIN_WAIT_MS, payload: {} };
      if (hold) return { ...hold, progress: progressOf(payload, "searching", { waiting }) };
      // Waited as long as a collection may take: this collection is given up, the source goes on with what it has.
      const reason = `Bright Data kept asking to wait for ${BRIGHTDATA_LIMITS.collectionTimeoutMinutes} minutes (${started.reason})`;
      state.state = task.hop ? state.state : "failed";
      note(state, `${task.label}: not collected — ${reason}`);
      if (!task.hop) state.reason = reason;
      return null;
    }
    state.state = task.hop ? state.state : "failed";
    note(state, `${task.label}: not collected — ${started.reason}`);
    if (!task.hop) state.reason = started.reason;
    return null;
  }
  const collections = payload.collections ?? (payload.collections = []);
  if (!collections.some((item) => item.usageId === started.usageId)) {
    collections.push({ usageId: started.usageId, snapshotId: started.snapshotId, platform: task.platform, dataset: task.spec.dataset, hop: task.hop, state: "open", startedAt: new Date().toISOString(), polls: 0, reused: started.reused, findings: 0, credits: 0, note: null });
    payload.reservedRecords = (payload.reservedRecords ?? 0) + started.reservedCredits;
  }
  if (started.reused) note(state, `${task.label}: the same collection ran within the last ${BRIGHTDATA_LIMITS.reuseDays} days; its records were read again at no cost`);
  state.state = "collecting";
  return null;
}

/** Leaves the plan where it is and polls the job's open collections; the collecting stage comes back to the plan when they are done. */
function pollFirst(payload: Payload): StepOutcome {
  return {
    next: "stage",
    stage: "collecting",
    payload: { sources: payload.sources, plan: payload.plan, searchIndex: payload.searchIndex ?? 0, collections: payload.collections ?? [], reservedRecords: payload.reservedRecords ?? 0, findings: payload.findings ?? [], failures: payload.failures ?? [], urls: payload.urls ?? {} },
    progress: progressOf(payload, "collecting", { collecting: (payload.collections ?? []).filter((item) => item.state === "open").length }),
  };
}

async function stageSearching(job: AssistantJob, heartbeat: () => Promise<void>): Promise<StepOutcome> {
  if (!(await featureEnabled("brightdata"))) return { next: "failed", error: `${new FeatureDisabledError("brightdata").message} The research stopped before its remaining paid searches.` };
  const payload = payloadOf(job);
  const index = payload.searchIndex ?? 0;
  const task = payload.plan[index];
  const searches = [...(payload.searches ?? [])];
  const finish = (): StepOutcome => {
    const next = index + 1;
    const common = { sources: payload.sources, plan: payload.plan, searches, urls: payload.urls ?? {}, collections: payload.collections ?? [], reservedRecords: payload.reservedRecords ?? 0, searchIndex: next };
    if (next < payload.plan.length) return { next: "stage", stage: "searching", payload: common, progress: progressOf(payload, "searching", { searches: payload.plan.length, searchesDone: next }) };
    // Every web search made: the URLs become collections, started one per step like the rest.
    if (!payload.urlsCollected) {
      const more = collectTasksFor(payload);
      if (more.length) return { next: "stage", stage: "searching", payload: { ...common, sources: payload.sources, plan: [...payload.plan, ...more], urlsCollected: true }, progress: progressOf(payload, "searching", { searches: payload.plan.length + more.length, searchesDone: next }) };
    }
    return { next: "stage", stage: "collecting", payload: { ...common, urlsCollected: true, findings: payload.findings ?? [], failures: payload.failures ?? [] }, progress: progressOf(payload, "collecting") };
  };
  if (!task) return finish();
  // End an overdue provider wait before any new trigger or SERP request,
  // even when the provider would accept it now. Earlier results stay kept.
  const waitingSince = payload.waits?.[String(index)];
  if (waitingSince && brightdataTaskWaitMs(waitingSince, Date.now(), null) === null) {
    const state = source(payload, task.platform);
    const reason = `Bright Data kept asking to wait for ${BRIGHTDATA_LIMITS.collectionTimeoutMinutes} minutes`;
    if (task.kind !== "collect" || !task.hop) { state.state = "failed"; state.reason = reason; }
    note(state, `${task.kind === "collect" ? task.label : task.query}: not collected — ${reason}`);
    return finish();
  }
  if (task.kind === "collect") {
    const outcome = await startPlannedCollection(job, payload, task, index);
    if (outcome) return outcome;
    await savePayload(job, { sources: payload.sources, collections: payload.collections ?? [], reservedRecords: payload.reservedRecords ?? 0, searchIndex: index + 1 });
    // A few open at a time: they are polled before more are started, so one job never fills the organization's cap.
    if ((payload.collections ?? []).filter((item) => item.state === "open").length >= JOB_OPEN_COLLECTIONS) return pollFirst({ ...payload, searchIndex: index + 1 });
    return finish();
  }
  const state = source(payload, task.platform);
  const estimate = searchPrice(payload.urlFinder) === "usd" ? { estimateUsd: AI_SEARCH_ESTIMATE_USD } : {};
  if (payload.searchStarted === index) {
    // The step that started this paid search died before saving its result: it may have been billed, so it is recorded, not bought again.
    searches.push({ query: task.query, sources: 0, provider: null, model: null, costUsd: null, error: INTERRUPTED_SEARCH, ...estimate });
    note(state, `the search “${task.query}” was interrupted and not repeated`);
  } else if (payload.urlFinder === "brightdata_serp") {
    const result = await serpSearchThroughBrightdata(task.query, { jobId: job.id, requestId: jobRequestId(job), threadId: job.threadId, spendGuard: await objectiveSpendGuard(jobRequestId(job)) });
    if (!result.ok && result.wait) {
      const hold = result.rateLimited ? waitFor(payload, index, result.retryAfterMs ?? null) : { next: "wait" as const, delayMs: MIN_WAIT_MS, payload: {} };
      if (hold) return { ...hold, progress: progressOf(payload, "searching", { waiting: { kind: result.rateLimited ? "quota" : "paused", provider: "brightdata", reason: `the next search waits: ${result.reason}` } }) };
      note(state, `the search “${task.query}” was not made: Bright Data kept asking to wait for ${BRIGHTDATA_LIMITS.collectionTimeoutMinutes} minutes (${result.reason})`);
    } else if (!result.ok) note(state, `the search “${task.query}” failed: ${result.reason}`);
    else {
      let kept = 0;
      for (const hit of result.results) {
        const target = datasetForUrl(hit.url);
        if (target && /^(x|instagram|facebook)_/.exec(target.dataset)?.[1] === task.platform && keepUrl(payload, task.platform, { url: target.url, dataset: target.dataset, title: hit.title, snippet: hit.snippet, query: task.query })) kept += 1;
      }
      state.urls += kept;
    }
  } else {
    const room = await reserveWebSearch(job, index);
    if (!room.ok) {
      if (room.wait) return { next: "wait", delayMs: 60_000, progress: progressOf(payload, "searching", { waiting: { kind: "paused", reason: `the next search waits: ${room.reason}` } }) };
      note(state, `the search “${task.query}” was not made: ${room.reason}`);
      state.state = state.urls ? state.state : "not_searched";
      state.reason = state.urls ? state.reason : room.reason;
    } else {
      try {
        const result = await searchWeb(task.query, { provider: (payload.searchProvider ?? null) as WebSearchProvider | null, jobId: job.id });
        searches.push({ query: task.query, sources: result.sources.length, provider: result.provider, model: result.model, costUsd: result.costUsd, error: result.sources.length ? null : "the provider returned no web sources", ...(result.costUsd === null ? estimate : {}) });
        let kept = 0;
        for (const hit of result.sources) {
          const target = datasetForUrl(hit.url);
          if (target && /^(x|instagram|facebook)_/.exec(target.dataset)?.[1] === task.platform && keepUrl(payload, task.platform, { url: target.url, dataset: target.dataset, title: hit.title, snippet: hit.snippet, query: task.query })) kept += 1;
        }
        state.urls += kept;
      } catch (error) {
        if (error instanceof WebSearchUnavailableError) {
          state.state = "failed";
          state.reason = error.message;
        } else if (error instanceof TinyfishWaitError) {
          await savePayload(job, { searchStarted: -1 });
          return { next: "wait", delayMs: Math.max(1_000, error.until.getTime() - Date.now()), payload: { searchStarted: -1 }, progress: progressOf(payload, "searching", { waiting: { kind: "quota", provider: "tinyfish", until: error.until.toISOString(), reason: error.reason } }) };
        } else {
          searches.push({ query: task.query, sources: 0, provider: null, model: null, costUsd: null, error: message(error).slice(0, 300), ...estimate });
          note(state, `the search “${task.query}” failed: ${message(error).slice(0, 200)}`);
        }
      }
    }
  }
  // The paid result is stored at once, before anything else can fail this step.
  await savePayload(job, { sources: payload.sources, searches, urls: payload.urls ?? {}, searchIndex: index + 1 });
  await heartbeat().catch(() => undefined);
  return finish();
}

// ── Collecting ──────────────────────────────────────────────────────────────

function clipFinding(finding: SocialFinding): SocialFinding {
  return { ...finding, text: finding.text ? finding.text.slice(0, FINDING_TEXT_CHARS) : null, identity: finding.identity ? { ...finding.identity, bio: finding.identity.bio?.slice(0, 600) ?? null } : null };
}

/** The authors worth reading after their posts: on Reddit those whose words ask for something; elsewhere every post author the search found, within the budget. */
function profileHops(payload: Payload): SearchTask[] {
  const findings = payload.findings ?? [];
  const known = new Set(findings.filter((item) => item.kind === "profile" || item.kind === "page").map((item) => item.url));
  const budgetLeft = payload.criteria.maxResults - (payload.reservedRecords ?? 0);
  const tasks: SearchTask[] = [];
  let left = Math.max(0, budgetLeft);
  for (const state of payload.sources) {
    if (state.state !== "collecting" && state.state !== "searched") continue;
    const seen = new Set<string>();
    const urls: { url: string; dataset: BrightdataDatasetKey }[] = [];
    for (const finding of findings) {
      if (finding.platform !== state.platform || (finding.kind !== "post" && finding.kind !== "comment") || !finding.author?.profileUrl) continue;
      if (state.platform === "reddit" && needSignal(finding.text ?? "") !== "need") continue;
      const target = datasetForUrl(finding.author.profileUrl);
      if (!target || known.has(target.url) || seen.has(target.url) || !/_profiles$|_pages$/.test(target.dataset)) continue;
      seen.add(target.url);
      urls.push({ url: target.url, dataset: target.dataset });
    }
    const take = urls.slice(0, Math.min(MAX_PROFILE_HOPS, left));
    left -= take.length;
    if (urls.length > take.length) note(state, `${urls.length - take.length} more authors' profiles were not read: ${left <= 0 ? `this job's limit of ${payload.criteria.maxResults} records` : `at most ${MAX_PROFILE_HOPS} per platform`}`);
    const byDataset = new Map<BrightdataDatasetKey, string[]>();
    for (const item of take) byDataset.set(item.dataset, [...(byDataset.get(item.dataset) ?? []), item.url]);
    for (const [dataset, items] of byDataset) {
      tasks.push({ kind: "collect", platform: state.platform, hop: true, label: `${items.length} ${PLATFORM_NAMES[state.platform]} authors' ${dataset.endsWith("_pages") ? "pages" : "profiles"}`, spec: { dataset, discoverBy: null, inputs: items.map((url) => ({ url })), limitPerInput: null } });
    }
  }
  return tasks;
}

async function stageCollecting(job: AssistantJob, heartbeat: () => Promise<void>): Promise<StepOutcome> {
  const payload = payloadOf(job);
  const collections = payload.collections ?? [];
  const findings = payload.findings ?? [];
  const failures = payload.failures ?? [];
  const open = collections.find((item) => item.state === "open");
  if (open) {
    const state = source(payload, open.platform);
    const age = Date.now() - new Date(open.startedAt).getTime();
    const polled = await pollCollection(open.usageId, { stopWaiting: age > BRIGHTDATA_LIMITS.collectionTimeoutMinutes * 60_000 });
    open.polls += 1;
    if (polled.state === "running") {
      await savePayload(job, { collections });
      return { next: "wait", delayMs: POLL_DELAY_MS, payload: { collections }, progress: progressOf(payload, "collecting", { collecting: collections.filter((item) => item.state === "open").length, records: polled.records }) };
    }
    open.state = polled.ok ? "done" : "failed";
    open.credits = polled.creditsUsed;
    open.note = polled.note;
    state.credits += polled.creditsUsed;
    if (polled.note) note(state, polled.note);
    if (polled.ok) {
      const read = readRecords(open.dataset, polled.records);
      const room = Math.max(0, MAX_FINDINGS_KEPT - findings.length);
      const kept = read.findings.slice(0, room).map(clipFinding);
      if (read.findings.length > kept.length) note(state, `${read.findings.length - kept.length} findings were not kept: this job keeps at most ${MAX_FINDINGS_KEPT}`);
      findings.push(...kept);
      open.findings = kept.length;
      state.found += kept.length;
      for (const failure of read.failures) {
        if (failures.length < MAX_FAILURES_KEPT) failures.push({ platform: open.platform, input: failure.input, reason: failure.reason });
      }
      if (read.failures.length) note(state, `${read.failures.length} input${read.failures.length === 1 ? "" : "s"} could not be read (${read.failures[0]!.reason})`);
    } else if (!open.hop) {
      // A failed collection fails the source only when nothing else of it worked; what other collections found stays.
      if (!collections.some((item) => item.platform === open.platform && item.state === "done")) {
        state.state = "failed";
        state.reason = polled.note ?? "Bright Data could not collect it";
      }
    }
    await savePayload(job, { collections, findings, failures, sources: payload.sources });
    await heartbeat().catch(() => undefined);
  }
  if (collections.some((item) => item.state === "open")) {
    return { next: "stage", stage: "collecting", payload: { collections, findings, failures, sources: payload.sources }, progress: progressOf(payload, "collecting", { collecting: collections.filter((item) => item.state === "open").length }) };
  }
  // The plan has more to start (it was left to poll first): back to it.
  if ((payload.searchIndex ?? 0) < payload.plan.length) {
    return { next: "stage", stage: "searching", payload: { collections, findings, failures, sources: payload.sources }, progress: progressOf(payload, "searching", { searches: payload.plan.length, searchesDone: payload.searchIndex ?? 0 }) };
  }
  if (!payload.hopsDone) {
    const hops = profileHops(payload);
    if (hops.length) {
      return {
        next: "stage",
        stage: "searching",
        payload: { collections, findings, failures, sources: payload.sources, hopsDone: true, plan: [...payload.plan, ...hops], searchIndex: payload.plan.length },
        progress: progressOf(payload, "searching", { searches: payload.plan.length + hops.length, searchesDone: payload.plan.length }),
      };
    }
  }
  for (const state of payload.sources) if (state.state === "collecting") state.state = "searched";
  return { next: "stage", stage: "reading", payload: { collections, findings, failures, sources: payload.sources, hopsDone: true, readIndex: 0, websites: [] }, progress: progressOf(payload, "reading", { read: 0 }) };
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** The websites profiles and pages list (one each), the first MAX_WEBSITE_READS, not the owner's own. */
function websitesToRead(payload: Payload, owner: OwnerIdentity): { profileUrl: string; website: string }[] {
  const out: { profileUrl: string; website: string }[] = [];
  const seen = new Set<string>();
  for (const finding of payload.findings ?? []) {
    const website = finding.identity?.websites[0];
    if (!website || finding.kind === "post" || finding.kind === "comment") continue;
    const domain = websiteDomain(website);
    if (!domain || seen.has(domain) || ownsDomain(owner, domain)) continue;
    seen.add(domain);
    out.push({ profileUrl: finding.url, website });
    if (out.length >= MAX_WEBSITE_READS) break;
  }
  return out;
}

async function stageReading(job: AssistantJob, heartbeat: () => Promise<void>): Promise<StepOutcome> {
  const payload = payloadOf(job);
  const profile = await getBusinessProfile();
  const owner = await ownerIdentity({ ownWebsite: profile.website ?? null });
  const all = websitesToRead(payload, owner);
  const start = payload.readIndex ?? 0;
  const batch = all.slice(start, start + READ_BATCH);
  const websites = [...(payload.websites ?? [])];
  const focus = offerFocus(profile);
  const country = await organizationPhoneCountry();
  for (const item of batch) {
    const result = await collectWebsiteContacts(item.website, discoveryPageOptions(), focus);
    const emails = result.contacts.filter((contact) => contact.kind === "email").map((contact) => ({ value: contact.value, sourceUrl: contact.sourceUrl }));
    const phones: { value: string; sourceUrl: string }[] = [];
    for (const contact of result.contacts.filter((candidate) => candidate.kind === "phone")) {
      const checked = checkPhone(contact.value, country);
      if (checked.ok && !phones.some((phone) => phone.value === checked.e164)) phones.push({ value: checked.e164, sourceUrl: contact.sourceUrl });
    }
    websites.push({ profileUrl: item.profileUrl, website: item.website, emails, phones, error: result.error, checkedAt: result.profile?.checkedAt ?? new Date().toISOString(), pagesRead: result.pagesRead });
    await heartbeat();
  }
  const next = start + batch.length;
  if (next < all.length) return { next: "stage", stage: "reading", payload: { websites, readIndex: next }, progress: progressOf(payload, "reading", { read: next, websites: all.length }) };
  return { next: "stage", stage: "saving", payload: { websites, readIndex: next, saveIndex: 0, leads: buildLeads(payload, websites), createdIds: [], memberIds: [] }, progress: progressOf(payload, "saving", { saved: 0 }) };
}

// ── Leads from findings ─────────────────────────────────────────────────────

const SIGNAL_SOURCE: Record<BrightdataPlatform, Record<"post" | "comment", string>> = {
  reddit: { post: "Reddit post", comment: "Reddit comment" },
  x: { post: "X post", comment: "X reply" },
  instagram: { post: "Instagram post", comment: "Instagram comment" },
  facebook: { post: "Facebook post", comment: "Facebook comment" },
};

function clip(value: string | null | undefined, limit: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function signalOf(finding: SocialFinding): LeadSignal {
  return {
    kind: needSignal(finding.text ?? ""),
    text: clip(finding.text, 1_000),
    sourceUrl: finding.url,
    source: SIGNAL_SOURCE[finding.platform][finding.kind === "comment" ? "comment" : "post"],
    at: finding.postedAt,
    ...(finding.retrievedAt ? { observedAt: finding.retrievedAt } : {}),
  };
}

/** Why a lead matched, in one sentence the owner can check: what they wrote, where, and the search that found it. Never a guess. */
function matchReasonOf(platform: BrightdataPlatform, discussions: SocialFinding[], identity: SocialFinding | null, query: string | null): string {
  const first = discussions[0];
  const found = query ? ` Found by the ${PLATFORM_NAMES[platform]} search “${clip(query, 120)}”.` : "";
  if (first) {
    const where = first.community ? ` in r/${first.community}` : "";
    const quoted = clip(first.title ?? first.text, 220);
    return `${first.kind === "comment" ? "Commented" : "Posted"}${where} on ${PLATFORM_NAMES[platform]}: “${quoted}” (${first.url}).${found}`;
  }
  if (identity) return `Their ${PLATFORM_NAMES[platform]} ${identity.kind === "page" ? "page" : "profile"} ${identity.url}${identity.identity?.bio ? `: “${clip(identity.identity.bio, 160)}”` : ""} was returned by the web search${query ? ` for “${clip(query, 120)}”` : ""}.`;
  return `Found on ${PLATFORM_NAMES[platform]}.${found}`;
}

/** Posts, comments, profiles and pages grouped by who they belong to, each group one lead. */
function buildLeads(payload: Payload, websites: WebsiteRead[]): Lead[] {
  const findings = payload.findings ?? [];
  const byUrl = new Map<string, WebsiteRead>();
  for (const read of websites) byUrl.set(read.profileUrl, read);
  const keyOf = (finding: SocialFinding): string | null => {
    if (finding.kind === "profile" || finding.kind === "page") return `${finding.platform}:${finding.url}`;
    if (finding.author?.profileUrl) return `${finding.platform}:${datasetForUrl(finding.author.profileUrl)?.url ?? finding.author.profileUrl}`;
    return finding.author?.username ? `${finding.platform}:@${finding.author.username.toLowerCase()}` : null;
  };
  const groups = new Map<string, { platform: BrightdataPlatform; identity: SocialFinding | null; discussions: SocialFinding[] }>();
  for (const finding of findings) {
    const key = keyOf(finding);
    if (!key) continue;
    const group = groups.get(key) ?? { platform: finding.platform, identity: null, discussions: [] };
    if (finding.kind === "profile" || finding.kind === "page") group.identity = group.identity ?? finding;
    else group.discussions.push(finding);
    groups.set(key, group);
  }
  const hopLimited = new Set(payload.sources.flatMap((state) => (state.notes.some((text) => /authors' profiles were not read/.test(text)) ? [state.platform] : [])));
  const leads: Lead[] = [];
  for (const group of groups.values()) {
    const { platform, identity, discussions } = group;
    const first = discussions[0] ?? null;
    const author = first?.author ?? null;
    const username = identity?.identity?.username ?? author?.username ?? null;
    const name = identity?.identity?.name ?? identity?.title ?? author?.name ?? (username ? `@${username}` : null) ?? `${PLATFORM_NAMES[platform]} author`;
    const profileUrl = identity?.url ?? author?.profileUrl ?? null;
    const read = identity ? byUrl.get(identity.url) ?? null : null;
    const sourceOf = (label: string) => `the ${PLATFORM_NAMES[platform]} ${identity?.kind === "page" ? "page" : "profile"}${label ? ` (${label})` : ""}`;
    const emails: FoundContactValue[] = [
      ...(identity?.identity?.emails ?? []).map((value) => ({ value, sourceUrl: identity!.url, source: sourceOf("published there") })),
      ...(read?.emails ?? []).map((email) => ({ value: email.value, sourceUrl: email.sourceUrl, source: "the website their profile lists" })),
    ];
    const phones: FoundContactValue[] = [
      ...(identity?.identity?.phones ?? []).map((value) => ({ value, sourceUrl: identity!.url, source: sourceOf("published there") })),
      ...(read?.phones ?? []).map((phone) => ({ value: phone.value, sourceUrl: phone.sourceUrl, source: "the website their profile lists" })),
    ];
    const signals = discussions.map(signalOf);
    const query = first?.input ?? identity?.input ?? null;
    const facts: Record<string, string> = {
      platform: PLATFORM_NAMES[platform],
      foundVia: "Bright Data",
      ...(query ? { searchQuery: query } : {}),
      ...(profileUrl ? { profile: profileUrl } : {}),
      ...(first ? { discussion: first.url, quote: clip(first.text, 300) } : {}),
      ...(first?.postedAt ? { postedAt: first.postedAt } : {}),
      ...(identity?.retrievedAt ?? first?.retrievedAt ? { retrievedAt: (identity?.retrievedAt ?? first?.retrievedAt)! } : {}),
      ...(first?.community ? { community: `r/${first.community}` } : {}),
      ...(identity?.identity?.bio ? { bio: clip(identity.identity.bio, 300) } : {}),
      ...(identity?.identity?.category ? { category: identity.identity.category } : {}),
      ...(identity?.identity?.location ? { location: identity.identity.location } : {}),
      ...(identity?.identity?.websites[0] ? { website: identity.identity.websites[0] } : {}),
      ...(discussions.length > 1 ? { discussions: String(discussions.length) } : {}),
    };
    const unread = identity ? null
      : platform === "reddit" && !signals.some((signal) => signal.kind === "need") ? "their words do not ask for anything, so their profile was not read"
      : hopLimited.has(platform) ? "the limit on authors' profiles read was reached"
      : author?.profileUrl ? "their profile could not be read" : "the post names no author profile";
    leads.push({
      kind: identity ? "identity" : "author",
      platform,
      name: clip(name, 120),
      username,
      profileUrl,
      sourceUrl: identity?.url ?? first?.url ?? profileUrl ?? "",
      bio: identity?.identity?.bio ?? null,
      website: identity?.identity?.websites[0] ?? null,
      emails,
      phones,
      signals,
      matchReason: matchReasonOf(platform, discussions, identity, query),
      facts,
      unread,
    });
  }
  // Those with a read profile first, then those whose words ask for something.
  return leads.sort((a, b) => Number(b.kind === "identity") - Number(a.kind === "identity") || Number(b.signals.some((s) => s.kind === "need")) - Number(a.signals.some((s) => s.kind === "need")));
}

// ── Saving ──────────────────────────────────────────────────────────────────

type ExistingPerson = { id: string; email: string | null; phone: string | null; source: string | null; createdAt: Date };

async function existingPerson(emails: string[], phones: string[]): Promise<ExistingPerson | null> {
  if (!emails.length && !phones.length) return null;
  const lowered = emails.map((email) => email.toLowerCase());
  const rows = await db.select({ id: people.id, email: people.email, phone: people.phone, source: people.source, createdAt: people.createdAt }).from(people)
    .where(and(inOrg(people), or(
      lowered.length ? inArray(sql`lower(${people.email})`, lowered) : undefined,
      phones.length ? inArray(people.phone, phones) : undefined,
    )))
    .orderBy(asc(people.createdAt)).limit(20);
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

/** The same member id on every attempt for the lead at `index`, so a retried step adds nothing twice. */
function stableMemberId(jobId: string, index: number): string {
  const hex = createHash("sha256").update(`social_research:${jobId}:${index}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function usableEmails(lead: Lead, owner: OwnerIdentity): Promise<{ emails: FoundContactValue[]; rejected: number }> {
  const byValue = new Map<string, FoundContactValue>();
  for (const email of lead.emails) {
    const clean = cleanEmail(email.value);
    if (clean && !byValue.has(clean) && !ownsEmail(owner, clean)) byValue.set(clean, { ...email, value: clean });
  }
  const out: FoundContactValue[] = [];
  let rejected = 0;
  for (const value of rankEmails([...byValue.keys()], websiteDomain(lead.website)).slice(0, MAX_EMAILS_PER_LEAD)) {
    const email = byValue.get(value)!;
    const check = await webDiscoveryMailCheck(value.split("@")[1]!);
    if (check === "rejects") {
      rejected += 1;
      continue;
    }
    out.push({ ...email, source: `${email.source} · ${mailCheckText(check)}` });
  }
  return { emails: out, rejected };
}

function evidenceOf(lead: Lead, emails: FoundContactValue[], phones: FoundContactValue[], igUsername: string | null): ContactEvidence[] {
  const evidence: ContactEvidence[] = [];
  if (lead.website && lead.profileUrl) evidence.push({ kind: "website", value: lead.website, sourceUrl: lead.profileUrl, source: `listed on their ${PLATFORM_NAMES[lead.platform]} profile` });
  if (igUsername && lead.profileUrl) evidence.push({ kind: "instagram", value: lead.profileUrl, sourceUrl: lead.sourceUrl, source: lead.kind === "identity" ? "Instagram profile" : "Instagram post" });
  for (const email of emails) evidence.push({ kind: "email", value: email.value, sourceUrl: email.sourceUrl, source: email.source });
  for (const phone of phones) evidence.push({ kind: "phone", value: phone.value, sourceUrl: phone.sourceUrl, source: phone.source });
  return evidence;
}

function noContactReason(lead: Lead, rejected: number): string {
  const platform = PLATFORM_NAMES[lead.platform];
  const noMessaging = lead.platform === "instagram" ? "" : `; AgentSDR cannot message anyone on ${platform}`;
  if (lead.kind === "author") return `a relevant ${platform} discussion, kept as research: ${lead.unread ?? "no contact route"}${noMessaging}`;
  if (rejected) return `the email their ${platform} ${lead.facts.category ? "page" : "profile"} or website publishes has a domain that does not receive mail, and no phone is published${noMessaging}`;
  return `their ${platform} ${lead.facts.category ? "page" : "profile"}${lead.website ? " and the website it lists" : ""} publish no email or phone${noMessaging}`;
}

type SaveOutcome = { member: NewMember | null; outcome: "eligible" | "excluded" | "duplicate" | "own"; known: boolean; email: boolean; phone: boolean; instagram: boolean };

async function saveLead(lead: Lead, payload: Payload, context: { job: AssistantJob; index: number; owner: OwnerIdentity; country: string | undefined }): Promise<SaveOutcome> {
  const { owner } = context;
  const none: SaveOutcome = { member: null, outcome: "own", known: false, email: false, phone: false, instagram: false };
  if (ownsDomain(owner, websiteDomain(lead.website)) || (lead.platform === "instagram" && lead.username && owner.instagram.has(lead.username.toLowerCase()))) return none;
  const { emails, rejected } = await usableEmails(lead, owner);
  // A phone a profile or page publishes is checked to E.164 like every other (the website's were, when read).
  const phones: FoundContactValue[] = [];
  for (const phone of lead.phones) {
    const checked = checkPhone(phone.value, context.country);
    if (checked.ok && !owner.phones.has(checked.e164) && !phones.some((item) => item.value === checked.e164)) phones.push({ ...phone, value: checked.e164 });
  }
  const igUsername = lead.platform === "instagram" ? instagramUsername(lead.username) : null;
  const id = stableMemberId(context.job.id, lead.platform === "reddit" ? context.index : context.index);
  const base = { id, source: SOCIAL_RESEARCH_SOURCE, sourceUrl: lead.sourceUrl, evidence: evidenceOf(lead, emails, phones, igUsername), facts: lead.facts, matchReason: lead.matchReason, signals: lead.signals };
  const email = emails[0]?.value ?? null;
  const phone = phones[0]?.value ?? null;
  if (!email && !phone && !igUsername) {
    return { member: { personId: null, name: lead.name, reason: noContactReason(lead, rejected), ...base }, outcome: "excluded", known: false, email: false, phone: false, instagram: false };
  }
  // An Instagram-only lead is reached by DM once a plan is approved, under the same rule as every other
  // Instagram profile: read, and naming the place when the research named one (instagramEligibility.ts).
  if (!email && !phone && igUsername) {
    const hold = lead.kind === "identity"
      ? instagramResearchHold({ profileRead: true, placeNamed: mentionsPlace(payload.criteria.where ?? "", lead.bio, lead.name), where: payload.criteria.where ?? "" })
      : "found by their Instagram post only; their profile was not read, so the account is kept for research";
    if (hold) return { member: { personId: null, name: lead.name, reason: hold, ...base }, outcome: "excluded", known: false, email: false, phone: false, instagram: true };
  }
  const memberIds = new Set(payload.memberIds ?? []);
  const createdIds = new Set(payload.createdIds ?? []);
  const existing = await existingPerson(emails.map((item) => item.value), phones.map((item) => item.value));
  if (existing && (memberIds.has(existing.id) || createdIds.has(existing.id))) return { ...none, outcome: "duplicate" };
  const raw = {
    businessName: lead.name,
    ...(lead.website ? { website: lead.website } : {}),
    ...(igUsername && lead.profileUrl ? { instagram: { username: igUsername, profileUrl: lead.profileUrl } } : {}),
    sourcePage: lead.sourceUrl,
    searchQuery: lead.facts.searchQuery ?? "",
    discoveredVia: `${PLATFORM_NAMES[lead.platform]} (Bright Data)`,
  };
  let personId: string;
  let known: boolean;
  if (existing) {
    personId = igUsername ? (await withLeadTransaction((tx) => upsertInstagramProspect(tx, igUsername, { email, phone, raw, source: PERSON_SOURCE }))).id : existing.id;
    known = !(existing.source === PERSON_SOURCE && existing.createdAt >= context.job.createdAt);
  } else {
    const company = lead.kind === "identity" && (lead.facts.category || lead.platform === "facebook") ? { name: lead.name, domain: websiteDomain(lead.website), linkedinUrl: null } : null;
    const person = await withLeadTransaction(async (tx) => {
      if (igUsername) return upsertInstagramProspect(tx, igUsername, { email, phone, company, raw, source: PERSON_SOURCE });
      if (email) return upsertPerson(tx, { email, phone, company, raw, source: PERSON_SOURCE });
      const created = await findOrCreateContactPerson(tx, { fullName: null, phone: phone!, companyName: company?.name ?? null, companyDomain: company?.domain ?? null, title: null, email: null }, PERSON_SOURCE);
      await tx.update(people)
        .set({ raw: sql`coalesce(${people.raw}, '{}'::jsonb) || ${JSON.stringify(raw)}::jsonb`, updatedAt: new Date() })
        .where(and(inOrg(people), eq(people.id, created.id)));
      return created;
    });
    personId = person.id;
    known = false;
    createdIds.add(personId);
    payload.createdIds = [...createdIds];
  }
  if (memberIds.has(personId)) return { ...none, outcome: "duplicate" };
  memberIds.add(personId);
  payload.memberIds = [...memberIds];
  return { member: { personId, ...base }, outcome: "eligible", known, email: Boolean(email), phone: Boolean(phone), instagram: Boolean(igUsername) };
}

function emptyTally(): Tally {
  return { eligible: 0, excluded: 0, duplicates: 0, alreadyKnown: 0, withEmail: 0, withPhoneOnly: 0, withInstagram: 0, needSignals: 0, ownBusiness: 0 };
}

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
  const profile = await getBusinessProfile();
  const owner = await ownerIdentity({ ownWebsite: profile.website ?? null });
  const country = await organizationPhoneCountry();
  const members: NewMember[] = [];
  for (const [offset, lead] of leads.slice(start, start + SAVE_BATCH).entries()) {
    const saved = await saveLead(lead, payload, { job, index: start + offset, owner, country });
    if (saved.outcome === "duplicate") tally.duplicates += 1;
    if (saved.outcome === "own") tally.ownBusiness += 1;
    if (saved.member) members.push(saved.member);
    if (saved.known) tally.alreadyKnown += 1;
    if (saved.member && lead.signals.some((signal) => signal.kind === "need")) tally.needSignals += 1;
    if (saved.outcome === "eligible") {
      if (saved.email) tally.withEmail += 1;
      else if (saved.phone) tally.withPhoneOnly += 1;
      if (saved.instagram) tally.withInstagram += 1;
    }
    await heartbeat();
  }
  if (job.audienceId && members.length) {
    const added = await addAudienceMembers(job.audienceId, members);
    tally.eligible += added.eligible;
    tally.excluded += added.excluded;
  }
  const next = start + SAVE_BATCH;
  if (next < leads.length) {
    return { next: "stage", stage: "saving", payload: { saveIndex: next, tally, createdIds: payload.createdIds ?? [], memberIds: payload.memberIds ?? [] }, progress: progressOf(payload, "saving", { saved: Math.min(next, leads.length), ...tally }) };
  }
  // The final counts are the audience's rows, so a step that ran twice cannot count anything twice.
  if (job.audienceId) Object.assign(tally, await memberCounts(job.audienceId));
  const findings = payload.findings ?? [];
  const discussions = findings.filter((item) => item.kind === "post" || item.kind === "comment").length;
  const searches = payload.searches ?? [];
  const credits = payload.sources.reduce((sum, item) => sum + item.credits, 0);
  const searchCosts = searches.map((search) => search.costUsd).filter((cost): cost is number => cost !== null);
  const notes: string[] = [];
  const searched = payload.sources.filter((item) => item.state === "searched");
  if (!searched.length) notes.push(`Nothing was searched: ${payload.sources.map((item) => `${PLATFORM_NAMES[item.platform]} — ${item.reason ?? "failed"}`).join("; ")}.`);
  else if (!leads.length) notes.push(`The ${searched.map((item) => PLATFORM_NAMES[item.platform]).join(", ")} research for “${payload.phrase}” found no discussions, profiles or pages. Try other words.`);
  for (const item of payload.sources) {
    if (item.state === "failed" || item.state === "not_searched") notes.push(`${PLATFORM_NAMES[item.platform]} ${item.state === "failed" ? "failed" : "was not searched"}: ${item.reason ?? "no reason recorded"}.`);
  }
  const notSearched = !searched.length && !findings.length;
  return {
    next: "done",
    progress: progressOf(payload, "done", { saved: leads.length, ...tally }),
    result: {
      audienceId: job.audienceId,
      phrase: payload.phrase,
      platforms: payload.criteria.platforms,
      found: leads.length,
      discussions,
      ...tally,
      sources: payload.sources.map((item) => ({ platform: item.platform, label: `${PLATFORM_NAMES[item.platform]} (Bright Data)`, state: item.state, reason: item.reason, queries: item.queries, urls: item.urls, found: item.found, credits: item.credits, notes: item.notes, limitation: PLATFORM_LIMITATIONS[item.platform] })),
      failures: payload.failures ?? [],
      searches,
      provider: "brightdata",
      urlFinder: payload.urlFinder,
      creditsUsed: credits,
      creditsEstimated: true,
      costUsd: Number((credits * BRIGHTDATA_USD_PER_CREDIT + searchCosts.reduce((sum, cost) => sum + cost, 0)).toFixed(6)),
      ...(notSearched ? { notSearched: true } : {}),
      note: notes.length ? notes.join(" ") : null,
    },
  };
}

export async function runSocialResearchStep(job: AssistantJob, heartbeat: () => Promise<void>): Promise<StepOutcome> {
  switch (job.stage) {
    case "queued":
      return stageQueued(job);
    case "searching":
      return stageSearching(job, heartbeat);
    case "collecting":
      return stageCollecting(job, heartbeat);
    case "reading":
      return stageReading(job, heartbeat);
    case "saving":
      return stageSaving(job, heartbeat);
    default:
      return { next: "failed", error: `Unknown social research stage ${job.stage}` };
  }
}

/** The finder's name for the chat ("TinyFish Search", "Bright Data SERP"). */
export function urlFinderName(finder: string | null): string {
  if (!finder) return "no web search";
  if (finder === "brightdata_serp") return "Bright Data SERP";
  return webSearchProviderName(finder as WebSearchProvider);
}
