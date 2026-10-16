import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { addAudienceMembers, createAudience, type NewMember } from "@/lib/assistant/audiences.server";
import { assistantJobs, type AudienceChannel, type ContactEvidence, type LeadSignal } from "@/lib/assistant/schema";
import type { AssistantJob, StepOutcome } from "@/lib/assistant/worker";
import { findOrCreateContactPerson } from "@/lib/calls/campaigns";
import { checkPhone } from "@/lib/calls/phone";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";
import { upsertPerson, withLeadTransaction } from "@/lib/leads/records";
import { people } from "@/lib/leads/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { apifyReadiness, pollTrackedRun, startTrackedRun } from "@/lib/apify/apify.server";
import { APIFY_ACTORS, APIFY_LIMITS, type ApifyActorKey } from "@/lib/apify/catalog";
import { hashtagsFor, mentionsPlace, placesFromMapsItems, postsFromHashtagItems, profilesFromItems, type InstagramPost } from "@/lib/apify/mapping";
import { needSignal } from "./webDiscovery";
import { cleanEmail, websiteDomain } from "./contacts";
import { geocodePlace } from "./geocode.server";
import { emailDomainCheck } from "./mailDomain.server";
import { searchTiles } from "./geocode";
import { cleanBusinessName, mapsSearchPhrase, parseMapsCsvDetailed, rankEmails, type MapsPlace } from "./mapsResults";
import { createMapsJob, downloadMapsResults, getMapsJobStatus, mapsScraperUrl, MapsScraperError } from "./mapsScraper.server";
import { collectWebsiteContacts, type PageFetchOptions } from "./websiteContacts.server";

/**
 * Lead discovery from public business listings: a Google Maps search on the
 * self-hosted scraper, each business's own website read for the contact
 * details it publishes, then every contact validated, deduplicated and saved
 * as People in an audience, with the page each detail came from. Businesses
 * with no usable contact are kept in the audience as excluded, with why.
 *
 * Runs as an assistant job (worker.ts) in stages:
 *   queued → searching (the scraper works; polled) → enriching (websites,
 *   a few per step) → saving (a batch per step) → done.
 *
 * With Apify discovery set up (src/lib/apify/: the feature on, a token, the
 * Actor approved, budget and account allowance left), the search runs on
 * Apify's Google Maps Scraper instead: queued → apify (the run polled by its
 * recorded id, so a restart picks it up) → enriching → saving. When Apify is
 * off, not set up, over budget or out of credit — or its run ends with
 * nothing — the same job falls back to the self-hosted scraper, and without
 * one to website search, keeping the customer type, the place and the
 * owner's request (contactAfter.requestId), so a plan made from the fallback
 * inherits that request's approval like any other. A run cut short (its
 * spending cap, a timeout) keeps what it already found ("partial").
 *
 * The same stages serve Instagram prospect discovery (job kind
 * apify_instagram): Apify's hashtag scraper finds accounts posting under
 * hashtags made from the customer type and place, its profile scraper reads
 * what they publish, and their websites are read like a listing's. Finding
 * someone on Instagram is not a way to contact them: AgentSDR starts no
 * Instagram chats, so a prospect without a published email or phone is kept
 * as excluded with that reason.
 *
 * What it cannot do, and says so: Google Maps lists businesses that have a
 * public listing. It does not list every potential customer, people's
 * personal details, or businesses that are not on Maps.
 */

export const DISCOVERY_SOURCE = "google_maps";
export const MAX_DISCOVERY_RESULTS = 200;
const POLL_MS = 15_000;
const ENRICH_BATCH = 8;
const ENRICH_CONCURRENCY = 4;
const SAVE_BATCH = 25;

export type DiscoveryCriteria = {
  /** What kind of business: "dental clinics", "logistics companies". */
  what: string;
  /** Where: "Pune, India". */
  where: string;
  maxResults: number;
  language: string;
};

/** Where a place came from when it is not a Google Maps listing: an Instagram account Apify found. */
type InstagramOrigin = {
  kind: "instagram";
  username: string;
  profileUrl: string;
  /** The post that matched, with its caption and time. */
  postUrl: string | null;
  caption: string | null;
  postedAt: string | null;
  hashtag: string | null;
  /** The post or profile names the requested place; otherwise its location is unknown. */
  placeNamed: boolean;
  biography: string | null;
  /** Contacts the profile itself publishes. */
  profileEmail: string | null;
  profilePhone: string | null;
};

type EnrichedPlace = MapsPlace & {
  websiteEmails: { value: string; sourceUrl: string }[];
  websitePhones: { value: string; sourceUrl: string }[];
  companyLinkedin: string | null;
  websiteError: string | null;
  origin?: InstagramOrigin;
};

type DiscoveryPayload = {
  criteria: DiscoveryCriteria;
  phrase: string;
  deadline?: string;
  /** The scraper jobs of this search: one per tile in fast mode, one in place-page mode. */
  externalIds?: string[];
  mode?: "fast" | "place";
  areaLabel?: string | null;
  /** Rows the scraper returned without a name (it could not read their details). */
  nameless?: number;
  places?: EnrichedPlace[];
  enrichIndex?: number;
  saveIndex?: number;
  seenEmails?: string[];
  seenPhones?: string[];
  tally?: { eligible: number; excluded: number; duplicates: number; withEmail: number; withPhoneOnly: number };
  /** The owner asked to contact what is found: plan the outreach when the search is done. */
  contactAfter?: { channels: AudienceChannel[] | null; ownerRequest?: string; requestId?: string } | null;
  /** Google Maps businesses (default), or Instagram accounts (job kind apify_instagram). */
  target?: "maps" | "instagram";
  /** Who searched: Apify, or the self-hosted scraper. */
  provider?: "apify" | "scraper";
  /** The open Apify run, by its apify_runs row (which holds Apify's run id). */
  apify?: { runRowId: string; actor: ApifyActorKey; deadline: string } | null;
  /** Why Apify was not used, or what limited it — said with the result. */
  providerNotes?: string[];
  instagram?: { hashtags: string[]; posts?: InstagramPost[] };
};

type ContactAfter = { channels: AudienceChannel[] | null; ownerRequest?: string; requestId?: string } | null;

export class DiscoveryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryUnavailableError";
  }
}

/** Whether this server can run Google Maps discovery, and if not why. */
export function discoveryAvailability(): { available: boolean; reason: string | null } {
  return mapsScraperUrl()
    ? { available: true, reason: null }
    : { available: false, reason: "The Google Maps scraper is not set up on this server (GMAPS_SCRAPER_URL). Contact lists can still be uploaded." };
}

export function normalizeCriteria(input: { what?: unknown; where?: unknown; maxResults?: unknown; language?: unknown }, fallbackLanguage = "en"): DiscoveryCriteria | { error: string } {
  const what = typeof input.what === "string" ? input.what.trim().slice(0, 200) : "";
  const where = typeof input.where === "string" ? input.where.trim().slice(0, 200) : "";
  if (!what) return { error: "Say what kind of businesses to look for." };
  if (!where) return { error: "Say where to look (a city, region or country)." };
  const requested = Number(input.maxResults ?? 50);
  const maxResults = Number.isFinite(requested) ? Math.min(MAX_DISCOVERY_RESULTS, Math.max(5, Math.round(requested))) : 50;
  const language = typeof input.language === "string" && /^[a-z]{2}$/i.test(input.language) ? input.language.toLowerCase() : fallbackLanguage;
  return { what, where, maxResults, language };
}

export type StartedDiscovery = {
  jobId: string;
  audienceId: string;
  phrase: string;
  /** Who searches: Apify, the self-hosted scraper, or — neither available — website search. */
  provider: "apify" | "scraper" | "website";
  /** Why not Apify, or what the fallback covers less well; null when nothing to say. */
  note: string | null;
};

/**
 * Starts a discovery: an audience to fill and the job that fills it. The
 * provider is chosen here only to say so (the job chooses again when it
 * runs): Apify when it is set up with allowance left, else the scraper, else
 * — when neither is there — website search, which takes over the request
 * with the same customer type, place and request id.
 */
export async function startDiscovery(
  criteria: DiscoveryCriteria,
  context: { threadId: string | null; userId: string | null },
  options: { contactAfter?: ContactAfter } = {},
): Promise<StartedDiscovery> {
  const scraper = discoveryAvailability();
  const apify = await apifyReadiness("google_maps", criteria.maxResults);
  const apifyNote = apify.usable ? null : apifyFallbackNote(apify);
  if (!apify.usable && !scraper.available) {
    const fallback = await startWebsiteFallback(criteria, context, options.contactAfter ?? null);
    if (fallback) return { ...fallback, note: [apifyNote, fallback.note].filter(Boolean).join(" ") || null };
    throw new DiscoveryUnavailableError([scraper.reason, apifyNote].filter(Boolean).join(" "));
  }
  const phrase = mapsSearchPhrase(criteria.what, criteria.where);
  const audienceId = await createAudience({
    name: `${criteria.what} — ${criteria.where}`,
    source: "discovery",
    criteria: { ...criteria, source: DISCOVERY_SOURCE, phrase },
    threadId: context.threadId,
    userId: context.userId,
  });
  const payload: DiscoveryPayload = { criteria, phrase, contactAfter: options.contactAfter ?? null, target: "maps" };
  const [job] = await db.insert(assistantJobs).values({
    organizationId: currentOrganizationId(),
    kind: "discovery",
    threadId: context.threadId,
    audienceId,
    payload: payload as unknown as Record<string, unknown>,
    progress: { stage: "queued", found: 0 },
    createdBy: context.userId,
  }).returning({ id: assistantJobs.id });
  return { jobId: job!.id, audienceId, phrase, provider: apify.usable ? "apify" : "scraper", note: apifyNote };
}

/** What to tell the owner when Apify was set up but cannot be used now; nothing when it is simply off. */
function apifyFallbackNote(readiness: { exhausted: boolean; reason: string }): string | null {
  if (/is off for this organization/.test(readiness.reason)) return null;
  if (!readiness.exhausted) return `Apify was not used: ${readiness.reason}.`;
  return /never tops up/.test(readiness.reason)
    ? `Apify was not used: ${readiness.reason}; searching without it.`
    : `Apify was not used: ${readiness.reason}. AgentSDR never tops up or upgrades it; searching without it.`;
}

/**
 * Website search in place of a Google Maps search (neither Apify nor the
 * scraper available): the same customer type and place, and the owner's
 * request with its id, so the plan it prepares inherits that request's
 * approval. Null when website search is off or not set up.
 */
async function startWebsiteFallback(
  criteria: DiscoveryCriteria,
  context: { threadId: string | null; userId: string | null },
  contactAfter: ContactAfter,
): Promise<Omit<StartedDiscovery, "note"> & { note: string } | null> {
  const web = await import("./webDiscovery.server");
  const webCriteria = web.normalizeWebCriteria({ customers: criteria.what, where: criteria.where, maxResults: Math.min(40, criteria.maxResults), language: criteria.language });
  if ("error" in webCriteria) return null;
  try {
    const started = await web.startWebDiscovery(webCriteria, context, { contactAfter });
    return {
      jobId: started.jobId,
      audienceId: started.audienceId,
      phrase: started.phrase,
      provider: "website",
      note: `Searching business websites and directories for “${criteria.what}” in ${criteria.where} instead of Google Maps listings: it covers businesses the web search finds, usually fewer than a Maps search.`,
    };
  } catch (error) {
    if (error instanceof web.WebDiscoveryUnavailableError) return null;
    throw error;
  }
}

/**
 * Instagram prospects through Apify (job kind apify_instagram): accounts
 * posting under hashtags made from the customer type and place (plus any the
 * owner named), their public profiles, and the websites those publish. Needs
 * the hashtag Actor approved with allowance left; without it, website search
 * takes the request when it is on (same request id), else this says why.
 */
export async function startInstagramProspects(
  input: { what: string; where: string; hashtags?: string[]; maxResults: number; language: string },
  context: { threadId: string | null; userId: string | null },
  options: { contactAfter?: ContactAfter } = {},
): Promise<StartedDiscovery> {
  const readiness = await apifyReadiness("instagram_hashtags", input.maxResults);
  if (!readiness.usable) {
    const note = apifyFallbackNote(readiness) ?? "Instagram prospect search needs Apify discovery (Settings → Organization), which is off.";
    const fallback = await startWebsiteFallback({ what: input.what, where: input.where, maxResults: input.maxResults, language: input.language }, context, options.contactAfter ?? null);
    if (fallback) return { ...fallback, note: `${note} ${fallback.note} Instagram accounts appear only when the web search returns their pages (and Instagram is connected).` };
    throw new DiscoveryUnavailableError(`${note} Instagram has no keyword or hashtag search of its own that AgentSDR can use, and website search is not on, so nothing was searched.`);
  }
  const hashtags = hashtagsFor(input.what, input.where, input.hashtags ?? []);
  if (!hashtags.length) throw new DiscoveryUnavailableError("Say what kind of accounts to look for, or which hashtags.");
  const criteria: DiscoveryCriteria = { what: input.what, where: input.where, maxResults: input.maxResults, language: input.language };
  const phrase = `#${hashtags.join(" #")}`;
  const audienceId = await createAudience({
    name: `Instagram: ${input.what} — ${input.where}`,
    source: "discovery",
    criteria: { ...criteria, source: "apify_instagram", phrase, hashtags },
    threadId: context.threadId,
    userId: context.userId,
  });
  const payload: DiscoveryPayload = { criteria, phrase, contactAfter: options.contactAfter ?? null, target: "instagram", instagram: { hashtags } };
  const [job] = await db.insert(assistantJobs).values({
    organizationId: currentOrganizationId(),
    kind: "apify_instagram",
    threadId: context.threadId,
    audienceId,
    payload: payload as unknown as Record<string, unknown>,
    progress: { stage: "queued", found: 0 },
    createdBy: context.userId,
  }).returning({ id: assistantJobs.id });
  return {
    jobId: job!.id,
    audienceId,
    phrase,
    provider: "apify",
    note: `${APIFY_ACTORS.instagram_hashtags.limitation}`,
  };
}

// ── DNS: does an email domain accept mail? (mailDomain.server.ts) ───────────

export { emailDomainCheck, mailDomainCheck, type MailDomainCheck } from "./mailDomain.server";

// ── Stages ──────────────────────────────────────────────────────────────────

function payloadOf(job: AssistantJob): DiscoveryPayload {
  return job.payload as unknown as DiscoveryPayload;
}

async function stageQueued(job: AssistantJob): Promise<StepOutcome> {
  const payload = payloadOf(job);
  const requestId = payload.contactAfter?.requestId ?? null;
  if (payload.target === "instagram") {
    const started = await startTrackedRun({
      actor: "instagram_hashtags",
      input: (maxItems) => ({ hashtags: payload.instagram?.hashtags ?? [], resultsLimit: maxItems, resultsType: "posts" }),
      wantedItems: payload.criteria.maxResults * 2,
      jobId: job.id,
      requestId,
    });
    if (started.started) return apifyStage(started.row.id, "instagram_hashtags", payload.providerNotes ?? []);
    // Allowance gone between the tool call and now: website search takes the request, if it can.
    return handOffToWebsite(job, [...(payload.providerNotes ?? []), apifyFallbackNote(started) ?? started.reason]);
  }
  if (payload.provider !== "scraper") {
    const started = await startTrackedRun({
      actor: "google_maps",
      input: (maxItems) => ({
        searchStringsArray: [payload.criteria.what],
        locationQuery: payload.criteria.where,
        maxCrawledPlacesPerSearch: maxItems,
        language: payload.criteria.language,
      }),
      wantedItems: payload.criteria.maxResults,
      jobId: job.id,
      requestId,
    });
    if (started.started) return apifyStage(started.row.id, "google_maps", payload.providerNotes ?? []);
    const note = apifyFallbackNote(started);
    return startScraperOrFallback(job, note ? [...(payload.providerNotes ?? []), note] : payload.providerNotes ?? []);
  }
  return startScraperOrFallback(job, payload.providerNotes ?? []);
}

function apifyStage(runRowId: string, actor: ApifyActorKey, notes: string[], extra: Partial<DiscoveryPayload> = {}): StepOutcome {
  const deadline = new Date(Date.now() + (APIFY_LIMITS.runTimeoutSeconds + 300) * 1_000).toISOString();
  return {
    next: "stage",
    stage: "apify",
    payload: { ...extra, provider: "apify", apify: { runRowId, actor, deadline }, providerNotes: notes },
    progress: { stage: "searching", provider: "Apify", actor: APIFY_ACTORS[actor].label, startedSearchAt: new Date().toISOString() },
  };
}

/** The scraper when it is set up; otherwise website search takes the request (same customer type, place and request id). */
async function startScraperOrFallback(job: AssistantJob, notes: string[]): Promise<StepOutcome> {
  if (discoveryAvailability().available) return startScraper(job, notes);
  return handOffToWebsite(job, notes);
}

async function handOffToWebsite(job: AssistantJob, notes: string[]): Promise<StepOutcome> {
  const payload = payloadOf(job);
  const fallback = await startWebsiteFallback(payload.criteria, { threadId: job.threadId, userId: job.createdBy }, payload.contactAfter ?? null);
  if (!fallback) {
    return { next: "failed", error: [...notes, "No other search for this is set up here: the Google Maps scraper is not configured and website search is not on."].join(" ") };
  }
  return {
    next: "done",
    progress: { stage: "done", handedTo: fallback.jobId },
    result: {
      audienceId: job.audienceId,
      phrase: payload.phrase,
      found: 0,
      eligible: 0,
      handedToJobId: fallback.jobId,
      note: [...notes, fallback.note, "Its results are announced when it finishes."].join(" "),
    },
  };
}

/**
 * An Apify run, polled by its recorded id. When it ends — complete or cut
 * short — what it found goes on; a run that found nothing hands the search
 * to the next provider.
 */
async function stageApify(job: AssistantJob): Promise<StepOutcome> {
  const payload = payloadOf(job);
  const open = payload.apify;
  if (!open) return { next: "failed", error: "The Apify run was lost before it was recorded; ask again." };
  const pastDeadline = Date.now() > new Date(open.deadline).getTime();
  const polled = await pollTrackedRun(open.runRowId, { stopWaiting: pastDeadline });
  if (polled.state === "running") {
    return { next: "wait", delayMs: POLL_MS, progress: { stage: "searching", provider: "Apify", actor: APIFY_ACTORS[open.actor].label } };
  }
  const notes = [...(payload.providerNotes ?? []), ...(polled.note ? [polled.note] : [])];
  if (polled.exhausted) notes.push("Apify's spending cap or credit ran out during the run (AgentSDR never tops up or upgrades it); ask again to search further and the other searches are used while Apify is unavailable.");
  const country = await organizationPhoneCountry();

  if (open.actor === "google_maps") {
    const { places } = placesFromMapsItems(polled.items, country);
    if (!places.length) return startScraperOrFallback(job, [...notes, "Apify's Google Maps run returned no businesses."]);
    const kept = places.slice(0, payload.criteria.maxResults);
    const enriched: EnrichedPlace[] = kept.map((place) => ({ ...place, websiteEmails: [], websitePhones: [], companyLinkedin: null, websiteError: null }));
    return {
      next: "stage",
      stage: "enriching",
      payload: { places: enriched, enrichIndex: 0, apify: null, providerNotes: notes },
      progress: { stage: "enriching", provider: "Apify", found: kept.length, websitesChecked: 0, websitesToCheck: kept.filter((place) => place.website).length, ...(polled.partial ? { partial: true } : {}) },
    };
  }

  if (open.actor === "instagram_hashtags") {
    const posts = postsFromHashtagItems(polled.items);
    const usernames = [...new Set(posts.map((post) => post.username))].slice(0, payload.criteria.maxResults);
    if (!usernames.length) {
      return doneWithNothing(job, [...notes, `Apify found no public Instagram posts under ${payload.phrase}.`]);
    }
    const profiles = await startTrackedRun({
      actor: "instagram_profiles",
      input: (maxItems) => ({ usernames: usernames.slice(0, maxItems) }),
      wantedItems: usernames.length,
      jobId: job.id,
      requestId: payload.contactAfter?.requestId ?? null,
    });
    if (profiles.started) return apifyStage(profiles.row.id, "instagram_profiles", notes, { instagram: { hashtags: payload.instagram?.hashtags ?? [], posts } });
    return instagramPlaces(job, posts, new Map(), [...notes, `Profiles were not read (${profiles.reason}), so only what the posts show is known.`]);
  }

  return instagramPlaces(job, payload.instagram?.posts ?? [], profilesFromItems(polled.items, country), notes);
}

function doneWithNothing(job: AssistantJob, notes: string[]): StepOutcome {
  const payload = payloadOf(job);
  return { next: "done", progress: { stage: "done" }, result: { audienceId: job.audienceId, phrase: payload.phrase, found: 0, eligible: 0, note: notes.join(" ") } };
}

/** Instagram accounts as places to read and save: one per account, the post that matched it as evidence. */
function instagramPlaces(job: AssistantJob, posts: InstagramPost[], profiles: Map<string, ReturnType<typeof profilesFromItems> extends Map<string, infer P> ? P : never>, notes: string[]): StepOutcome {
  const payload = payloadOf(job);
  const byUser = new Map<string, InstagramPost>();
  for (const post of posts) if (!byUser.has(post.username)) byUser.set(post.username, post);
  const places: EnrichedPlace[] = [...byUser.values()].slice(0, payload.criteria.maxResults).map((post) => {
    const profile = profiles.get(post.username) ?? null;
    const profileUrl = profile?.profileUrl ?? `https://www.instagram.com/${post.username}/`;
    const name = profile?.fullName ?? `@${post.username}`;
    const placeNamed = mentionsPlace(payload.criteria.where, post.locationName, post.caption, profile?.biography);
    return {
      placeKey: `instagram:${post.username}`,
      name,
      displayName: cleanBusinessName(name),
      category: profile?.category ?? null,
      address: null,
      city: placeNamed ? (payload.criteria.where.split(",")[0] ?? "").trim() || null : null,
      country: null,
      mapsUrl: profileUrl,
      website: profile?.website ?? null,
      domain: websiteDomain(profile?.website ?? null),
      phone: profile?.phone ?? null,
      phoneProblem: null,
      emails: profile?.email ? [profile.email] : [],
      rating: null,
      reviewCount: null,
      closed: profile?.isPrivate ? "a private account" : null,
      websiteEmails: [],
      websitePhones: [],
      companyLinkedin: null,
      websiteError: null,
      origin: {
        kind: "instagram",
        username: post.username,
        profileUrl,
        postUrl: post.url,
        caption: post.caption,
        postedAt: post.timestamp,
        hashtag: post.hashtag,
        placeNamed,
        biography: profile?.biography ?? null,
        profileEmail: profile?.email ?? null,
        profilePhone: profile?.phone ?? null,
      },
    };
  });
  if (!places.length) return doneWithNothing(job, [...notes, "No Instagram accounts were found."]);
  const unknownPlace = places.filter((place) => !place.origin?.placeNamed).length;
  if (unknownPlace) notes.push(`${unknownPlace} of ${places.length} accounts do not name ${payload.criteria.where} in the post or profile: their location is unknown (hashtags do not filter by place).`);
  return {
    next: "stage",
    stage: "enriching",
    payload: { places, enrichIndex: 0, apify: null, providerNotes: notes },
    progress: { stage: "enriching", provider: "Apify", found: places.length, websitesChecked: 0, websitesToCheck: places.filter((place) => place.website).length },
  };
}

/** The self-hosted scraper's search (the search before Apify existed). */
async function startScraper(job: AssistantJob, notes: string[]): Promise<StepOutcome> {
  const { criteria, phrase } = payloadOf(job);
  const name = `${job.organizationId.slice(0, 8)} ${phrase}`.slice(0, 120);
  try {
    // Fast mode around the geocoded place, tiled (at most 20 places per search).
    const area = await geocodePlace(criteria.where, criteria.language);
    if (area) {
      const tiles = searchTiles(area, criteria.maxResults);
      const externalIds: string[] = [];
      for (const tile of tiles) {
        externalIds.push(await createMapsJob({ name, keywords: [criteria.what], lang: criteria.language, depth: 1, email: false, maxTimeSeconds: 300, fast: tile }));
      }
      return {
        next: "stage",
        stage: "searching",
        externalId: externalIds[0]!,
        payload: { provider: "scraper", providerNotes: notes, apify: null, externalIds, mode: "fast", areaLabel: area.label, deadline: new Date(Date.now() + (300 * tiles.length + 900) * 1_000).toISOString() },
        progress: { stage: "searching", searches: tiles.length, area: area.label, startedSearchAt: new Date().toISOString() },
      };
    }
    // No coordinates: the scraper's place-page mode with the phrase.
    const depth = Math.max(1, Math.min(10, Math.ceil(criteria.maxResults / 20)));
    const maxTimeSeconds = Math.max(300, Math.min(1_800, 180 + criteria.maxResults * 6));
    const externalId = await createMapsJob({ name, keywords: [phrase], lang: criteria.language, depth, email: true, maxTimeSeconds });
    return {
      next: "stage",
      stage: "searching",
      externalId,
      payload: { provider: "scraper", providerNotes: notes, apify: null, externalIds: [externalId], mode: "place", areaLabel: null, deadline: new Date(Date.now() + (maxTimeSeconds + 600) * 1_000).toISOString() },
      progress: { stage: "searching", searches: 1, startedSearchAt: new Date().toISOString() },
    };
  } catch (error) {
    if (error instanceof MapsScraperError) return { next: "failed", error: error.message };
    throw error;
  }
}

async function stageSearching(job: AssistantJob): Promise<StepOutcome> {
  const payload = payloadOf(job);
  const ids = payload.externalIds?.length ? payload.externalIds : job.externalId ? [job.externalId] : [];
  if (!ids.length) return { next: "failed", error: "The search was lost before it started; ask again." };
  const statuses: { id: string; status: string }[] = [];
  for (const id of ids) {
    try {
      statuses.push({ id, status: await getMapsJobStatus(id) });
    } catch (error) {
      if (error instanceof MapsScraperError && error.status === 404) statuses.push({ id, status: "lost" });
      else throw error;
    }
  }
  const done = statuses.filter((entry) => entry.status === "ok");
  const open = statuses.filter((entry) => entry.status === "pending" || entry.status === "working");
  const pastDeadline = Boolean(payload.deadline && Date.now() > new Date(payload.deadline).getTime());
  if (open.length && !pastDeadline) {
    return { next: "wait", delayMs: POLL_MS, progress: { stage: "searching", searches: ids.length, searchesDone: ids.length - open.length } };
  }
  if (!done.length) {
    if (statuses.every((entry) => entry.status === "lost")) return { next: "failed", error: "The Google Maps scraper no longer has this search (it may have restarted). Ask again." };
    return { next: "failed", error: pastDeadline ? "The Google Maps search took too long and was stopped." : "The Google Maps scraper could not complete this search. Google may have blocked it; try again later or with fewer results." };
  }
  const country = await organizationPhoneCountry();
  const byKey = new Map<string, MapsPlace>();
  let nameless = 0;
  for (const entry of done) {
    const parsed = parseMapsCsvDetailed(await downloadMapsResults(entry.id), country);
    nameless += parsed.nameless;
    for (const place of parsed.places) if (!byKey.has(place.placeKey)) byKey.set(place.placeKey, place);
  }
  const places = [...byKey.values()].slice(0, payload.criteria.maxResults);
  const enriched: EnrichedPlace[] = places.map((place) => ({ ...place, websiteEmails: [], websitePhones: [], companyLinkedin: null, websiteError: null }));
  return {
    next: "stage",
    stage: "enriching",
    payload: { places: enriched, enrichIndex: 0, nameless },
    progress: { stage: "enriching", found: places.length, websitesChecked: 0, websitesToCheck: places.filter((place) => place.website).length, ...(open.length ? { searchesUnfinished: open.length } : {}) },
  };
}

/** Test hook: website reads go through this (fixtures point it at a local server). */
let pageOptions: PageFetchOptions = {};
export function setDiscoveryPageOptions(options: PageFetchOptions): void {
  pageOptions = options;
}
/** The same options for website and directory discovery (webDiscovery.server.ts). */
export function discoveryPageOptions(): PageFetchOptions {
  return pageOptions;
}

async function enrichPlace(place: EnrichedPlace, country: string | undefined): Promise<EnrichedPlace> {
  if (!place.website) return place;
  const result = await collectWebsiteContacts(place.website, pageOptions);
  const emails = result.contacts.filter((contact) => contact.kind === "email").map((contact) => ({ value: contact.value, sourceUrl: contact.sourceUrl }));
  const phones = result.contacts
    .filter((contact) => contact.kind === "phone")
    .flatMap((contact) => {
      const checked = checkPhone(contact.value, place.country ?? country);
      return checked.ok ? [{ value: checked.e164, sourceUrl: contact.sourceUrl }] : [];
    });
  const linkedin = result.contacts.find((contact) => contact.kind === "linkedin" && /\/company\//.test(contact.value))?.value ?? null;
  return { ...place, websiteEmails: emails, websitePhones: phones, companyLinkedin: linkedin, websiteError: result.error };
}

async function stageEnriching(job: AssistantJob, heartbeat: () => Promise<void>): Promise<StepOutcome> {
  const payload = payloadOf(job);
  const places = payload.places ?? [];
  const start = payload.enrichIndex ?? 0;
  const country = await organizationPhoneCountry();
  const batch = places.slice(start, start + ENRICH_BATCH);
  const out = [...places];
  for (let index = 0; index < batch.length; index += ENRICH_CONCURRENCY) {
    const chunk = batch.slice(index, index + ENRICH_CONCURRENCY);
    const results = await Promise.all(chunk.map((place) => enrichPlace(place, country).catch((error) => ({ ...place, websiteError: error instanceof Error ? error.message : String(error) }))));
    results.forEach((place, offset) => {
      out[start + index + offset] = place;
    });
    await heartbeat();
  }
  const next = start + batch.length;
  const progress = { stage: "enriching", websitesChecked: out.slice(0, next).filter((place) => place.website).length };
  if (next < places.length) return { next: "stage", stage: "enriching", payload: { places: out, enrichIndex: next }, progress };
  return { next: "stage", stage: "saving", payload: { places: out, saveIndex: 0, seenEmails: [], seenPhones: [] }, progress: { ...progress, stage: "saving" } };
}

function factsOf(place: EnrichedPlace): Record<string, string> {
  const facts: Record<string, string> = { businessName: place.displayName };
  if (place.origin) {
    facts.instagram = `@${place.origin.username}`;
    facts.foundVia = "Instagram (Apify)";
    if (place.origin.hashtag) facts.hashtag = `#${place.origin.hashtag}`;
    if (place.origin.postedAt) facts.postedAt = place.origin.postedAt;
    if (!place.origin.placeNamed) facts.location = "Unknown (the post and profile do not name the place)";
    facts.contactRoute = place.origin.profileEmail || place.origin.profilePhone || place.website ? "what the profile or its website publishes" : "none supported: AgentSDR cannot start Instagram chats";
  }
  if (place.displayName !== place.name) facts.listingName = place.name;
  if (place.category) facts.category = place.category;
  if (place.city) facts.city = place.city;
  if (place.address) facts.address = place.address;
  if (place.website) facts.website = place.website;
  if (place.rating !== null) facts.rating = String(place.rating);
  if (place.reviewCount !== null) facts.reviewCount = String(place.reviewCount);
  return facts;
}

/** The contact details of a place with where each came from, best first. */
export function placeEvidence(place: EnrichedPlace): ContactEvidence[] {
  const listing = place.mapsUrl;
  const listingLabel = place.origin ? "Instagram profile" : "Google Maps listing";
  const evidence: ContactEvidence[] = [];
  if (place.website) evidence.push({ kind: "website", value: place.website, sourceUrl: listing, source: listingLabel });
  if (place.phone) evidence.push({ kind: "phone", value: place.phone, sourceUrl: listing, source: listingLabel });
  const fromSite = new Map(place.websiteEmails.map((email) => [email.value, email.sourceUrl]));
  for (const email of rankEmails([...new Set([...place.emails, ...place.websiteEmails.map((e) => e.value)])], place.domain)) {
    // An Instagram profile's own published email is sourced to the profile, not a website.
    const fromProfile = place.origin && place.origin.profileEmail === email && !fromSite.has(email);
    evidence.push(fromProfile
      ? { kind: "email", value: email, sourceUrl: listing, source: listingLabel }
      : { kind: "email", value: email, sourceUrl: fromSite.get(email) ?? place.website, source: "the business's website" });
  }
  for (const phone of place.websitePhones) {
    if (phone.value !== place.phone) evidence.push({ kind: "phone", value: phone.value, sourceUrl: phone.sourceUrl, source: "the business's website" });
  }
  if (place.companyLinkedin) evidence.push({ kind: "linkedin", value: place.companyLinkedin, sourceUrl: place.website, source: "the business's website" });
  return evidence;
}

/** The post that matched an Instagram account, as their own words: a need only when it asks for something. */
function instagramSignals(place: EnrichedPlace): LeadSignal[] {
  const origin = place.origin;
  if (!origin?.caption) return [];
  return [{ kind: needSignal(origin.caption), text: origin.caption, sourceUrl: origin.postUrl, source: "Instagram post", at: origin.postedAt }];
}

function matchReasonOf(place: EnrichedPlace, payload: DiscoveryPayload): string {
  if (!place.origin) return `Listed on Google Maps for “${payload.phrase}”${payload.provider === "apify" ? " (found through Apify)" : ""}.`;
  const where = place.origin.placeNamed ? `names ${payload.criteria.where}` : `does not name ${payload.criteria.where} (location unknown)`;
  return `Posted on Instagram under ${place.origin.hashtag ? `#${place.origin.hashtag}` : payload.phrase}${place.origin.postedAt ? ` on ${place.origin.postedAt.slice(0, 10)}` : ""}; the post or profile ${where}. A post is a potential match, not interest.`;
}

async function savePlace(place: EnrichedPlace, payload: DiscoveryPayload): Promise<{ member: NewMember | null; outcome: "eligible" | "excluded" | "duplicate"; email: boolean }> {
  const evidence = placeEvidence(place);
  const facts = factsOf(place);
  const base = { source: place.origin ? "apify_instagram" : DISCOVERY_SOURCE, sourceUrl: place.mapsUrl, evidence, facts, matchReason: matchReasonOf(place, payload), signals: instagramSignals(place) };
  if (place.closed) {
    const reason = place.origin ? `found on Instagram (@${place.origin.username}), ${place.closed}: nothing it publishes can be read` : `listed on Google Maps as ${place.closed.toLowerCase()}`;
    return { member: { personId: null, name: place.displayName, reason, ...base }, outcome: "excluded", email: false };
  }

  let email: string | null = null;
  let emailRejected = false;
  for (const candidate of evidence.filter((item) => item.kind === "email").map((item) => cleanEmail(item.value)).filter((value): value is string => Boolean(value))) {
    const check = await emailDomainCheck(candidate.split("@")[1]!);
    if (check === "rejects") {
      emailRejected = true;
      continue;
    }
    email = candidate;
    break;
  }
  const phone = place.phone ?? place.websitePhones[0]?.value ?? null;
  if (!email && !phone && place.origin) {
    // Discovered is not contactable: no published email or phone, and AgentSDR starts no Instagram chats.
    const reason = `found on Instagram (@${place.origin.username}) but no supported channel to contact them: no email or phone on the profile${place.website ? place.websiteError ? ` (its website could not be read: ${place.websiteError})` : " or its website" : ""}, and AgentSDR cannot start Instagram chats — open the profile to message them yourself`;
    return { member: { personId: null, name: place.displayName, reason, ...base }, outcome: "excluded", email: false };
  }
  if (!email && !phone) {
    const reason = emailRejected
      ? "its published email's domain does not receive mail, and it lists no phone"
      : place.website
        ? place.websiteError
          ? `no email or phone on its Google Maps listing, and its website could not be read (${place.websiteError})`
          : "no email or phone on its Google Maps listing or website"
        : "no email or phone on its Google Maps listing, and no website";
    return { member: { personId: null, name: place.displayName, reason, ...base }, outcome: "excluded", email: false };
  }
  const seenEmails = new Set(payload.seenEmails ?? []);
  const seenPhones = new Set(payload.seenPhones ?? []);
  if ((email && seenEmails.has(email)) || (!email && phone && seenPhones.has(phone))) return { member: null, outcome: "duplicate", email: false };
  if (email) payload.seenEmails = [...seenEmails, email];
  if (phone) payload.seenPhones = [...seenPhones, phone];

  const raw = {
    businessName: place.displayName,
    ...(place.displayName !== place.name ? { listingName: place.name } : {}),
    ...(place.category ? { category: place.category } : {}),
    ...(place.city ? { city: place.city } : {}),
    ...(place.address ? { address: place.address } : {}),
    ...(place.mapsUrl ? { googleMapsUrl: place.mapsUrl } : {}),
    ...(place.website ? { website: place.website } : {}),
    ...(place.rating !== null ? { rating: String(place.rating) } : {}),
    ...(place.origin ? { instagram: { username: place.origin.username, profileUrl: place.origin.profileUrl } } : {}),
    discoveredVia: place.origin ? "Instagram (Apify)" : payload.provider === "apify" ? "Google Maps (Apify)" : "Google Maps",
  };
  const personSource = place.origin ? "discovery:apify-instagram" : payload.provider === "apify" ? "discovery:apify-google-maps" : "discovery:google-maps";
  const person = await withLeadTransaction(async (tx) => {
    if (email) {
      return upsertPerson(tx, {
        email,
        phone,
        company: { name: place.displayName, domain: place.domain, linkedinUrl: place.companyLinkedin },
        raw,
        source: personSource,
      });
    }
    const created = await findOrCreateContactPerson(tx, {
      fullName: null,
      phone: phone!,
      companyName: place.displayName,
      companyDomain: place.domain,
      title: null,
      email: null,
    }, personSource);
    await tx.update(people)
      .set({ raw: sql`coalesce(${people.raw}, '{}'::jsonb) || ${JSON.stringify(raw)}::jsonb`, updatedAt: new Date() })
      .where(and(inOrg(people), eq(people.id, created.id)));
    return created;
  });
  return { member: { personId: person.id, ...base }, outcome: "eligible", email: Boolean(email) };
}

async function stageSaving(job: AssistantJob, heartbeat: () => Promise<void>): Promise<StepOutcome> {
  const payload = payloadOf(job);
  const places = payload.places ?? [];
  const start = payload.saveIndex ?? 0;
  const tally = payload.tally ?? { eligible: 0, excluded: 0, duplicates: 0, withEmail: 0, withPhoneOnly: 0 };
  const members: NewMember[] = [];
  for (const place of places.slice(start, start + SAVE_BATCH)) {
    const saved = await savePlace(place, payload);
    if (saved.outcome === "duplicate") tally.duplicates += 1;
    if (saved.member) members.push(saved.member);
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
  const progress = { stage: "saving", saved: Math.min(next, places.length), ...tally };
  if (next < places.length) {
    return { next: "stage", stage: "saving", payload: { saveIndex: next, seenEmails: payload.seenEmails, seenPhones: payload.seenPhones, tally }, progress };
  }
  return {
    next: "done",
    progress: { ...progress, stage: "done" },
    result: {
      audienceId: job.audienceId,
      phrase: payload.phrase,
      found: places.length,
      ...tally,
      provider: payload.provider ?? "scraper",
      target: payload.target ?? "maps",
      instagramOnly: places.filter((place) => place.origin && !place.origin.profileEmail && !place.origin.profilePhone && !place.website).length,
      providerNote: (payload.providerNotes ?? []).join(" ") || null,
      note: places.length
        ? null
        : payload.nameless
          ? `The Google Maps scraper found ${payload.nameless} listings for “${payload.phrase}” but could not read their details (Google may have changed its pages). Try again later; uploaded lists still work.`
          : `Google Maps returned no listings for “${payload.phrase}”. It only covers businesses with a public Maps listing; try other words or a wider area.`,
    },
  };
}

export async function runDiscoveryStep(job: AssistantJob, heartbeat: () => Promise<void>): Promise<StepOutcome> {
  switch (job.stage) {
    case "queued":
      return stageQueued(job);
    case "apify":
      return stageApify(job);
    case "searching":
      return stageSearching(job);
    case "enriching":
      return stageEnriching(job, heartbeat);
    case "saving":
      return stageSaving(job, heartbeat);
    default:
      return { next: "failed", error: `Unknown discovery stage ${job.stage}` };
  }
}
