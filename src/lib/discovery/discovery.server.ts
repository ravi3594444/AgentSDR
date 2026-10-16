import "server-only";

import { resolve4, resolve6, resolveMx } from "node:dns/promises";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { addAudienceMembers, createAudience, type NewMember } from "@/lib/assistant/audiences.server";
import { assistantJobs, type AudienceChannel, type ContactEvidence } from "@/lib/assistant/schema";
import type { AssistantJob, StepOutcome } from "@/lib/assistant/worker";
import { findOrCreateContactPerson } from "@/lib/calls/campaigns";
import { checkPhone } from "@/lib/calls/phone";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";
import { upsertPerson, withLeadTransaction } from "@/lib/leads/records";
import { people } from "@/lib/leads/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { cleanEmail } from "./contacts";
import { geocodePlace } from "./geocode.server";
import { searchTiles } from "./geocode";
import { mapsSearchPhrase, parseMapsCsvDetailed, rankEmails, type MapsPlace } from "./mapsResults";
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

type EnrichedPlace = MapsPlace & {
  websiteEmails: { value: string; sourceUrl: string }[];
  websitePhones: { value: string; sourceUrl: string }[];
  companyLinkedin: string | null;
  websiteError: string | null;
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
};

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

/** Starts a discovery: an audience to fill and the job that fills it. */
export async function startDiscovery(
  criteria: DiscoveryCriteria,
  context: { threadId: string | null; userId: string | null },
  options: { contactAfter?: { channels: AudienceChannel[] | null; ownerRequest?: string; requestId?: string } | null } = {},
): Promise<{ jobId: string; audienceId: string; phrase: string }> {
  const availability = discoveryAvailability();
  if (!availability.available) throw new DiscoveryUnavailableError(availability.reason!);
  const phrase = mapsSearchPhrase(criteria.what, criteria.where);
  const audienceId = await createAudience({
    name: `${criteria.what} — ${criteria.where}`,
    source: "discovery",
    criteria: { ...criteria, source: DISCOVERY_SOURCE, phrase },
    threadId: context.threadId,
    userId: context.userId,
  });
  const payload: DiscoveryPayload = { criteria, phrase, contactAfter: options.contactAfter ?? null };
  const [job] = await db.insert(assistantJobs).values({
    organizationId: currentOrganizationId(),
    kind: "discovery",
    threadId: context.threadId,
    audienceId,
    payload: payload as unknown as Record<string, unknown>,
    progress: { stage: "queued", found: 0 },
    createdBy: context.userId,
  }).returning({ id: assistantJobs.id });
  return { jobId: job!.id, audienceId, phrase };
}

// ── DNS: does an email domain accept mail? ──────────────────────────────────

type DomainCheck = "accepts" | "rejects" | "unknown";
const domainCache = new Map<string, DomainCheck>();

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), ms))]);
}

/**
 * MX records, or an address record (implicit MX), mean the domain can
 * receive mail; a domain that does not exist cannot. A lookup that fails for
 * another reason (a timeout) is "unknown" and the address is kept.
 */
export async function emailDomainCheck(domain: string): Promise<DomainCheck> {
  if (process.env.DISCOVERY_DNS_CHECK === "off") return "unknown";
  const cached = domainCache.get(domain);
  if (cached) return cached;
  let result: DomainCheck = "unknown";
  try {
    const mx = await withTimeout(resolveMx(domain), 5_000);
    result = mx.some((record) => record.exchange && record.exchange !== ".") ? "accepts" : "rejects";
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      try {
        const addresses = [...(await withTimeout(resolve4(domain), 5_000).catch(() => [])), ...(await withTimeout(resolve6(domain), 5_000).catch(() => []))];
        result = addresses.length ? "accepts" : "rejects";
      } catch {
        result = code === "ENOTFOUND" ? "rejects" : "unknown";
      }
    }
  }
  domainCache.set(domain, result);
  return result;
}

// ── Stages ──────────────────────────────────────────────────────────────────

function payloadOf(job: AssistantJob): DiscoveryPayload {
  return job.payload as unknown as DiscoveryPayload;
}

async function stageQueued(job: AssistantJob): Promise<StepOutcome> {
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
        payload: { externalIds, mode: "fast", areaLabel: area.label, deadline: new Date(Date.now() + (300 * tiles.length + 900) * 1_000).toISOString() },
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
      payload: { externalIds: [externalId], mode: "place", areaLabel: null, deadline: new Date(Date.now() + (maxTimeSeconds + 600) * 1_000).toISOString() },
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
  const evidence: ContactEvidence[] = [];
  if (place.website) evidence.push({ kind: "website", value: place.website, sourceUrl: listing, source: "Google Maps listing" });
  if (place.phone) evidence.push({ kind: "phone", value: place.phone, sourceUrl: listing, source: "Google Maps listing" });
  const fromSite = new Map(place.websiteEmails.map((email) => [email.value, email.sourceUrl]));
  for (const email of rankEmails([...new Set([...place.emails, ...place.websiteEmails.map((e) => e.value)])], place.domain)) {
    evidence.push({ kind: "email", value: email, sourceUrl: fromSite.get(email) ?? place.website, source: "the business's website" });
  }
  for (const phone of place.websitePhones) {
    if (phone.value !== place.phone) evidence.push({ kind: "phone", value: phone.value, sourceUrl: phone.sourceUrl, source: "the business's website" });
  }
  if (place.companyLinkedin) evidence.push({ kind: "linkedin", value: place.companyLinkedin, sourceUrl: place.website, source: "the business's website" });
  return evidence;
}

async function savePlace(place: EnrichedPlace, payload: DiscoveryPayload): Promise<{ member: NewMember | null; outcome: "eligible" | "excluded" | "duplicate"; email: boolean }> {
  const evidence = placeEvidence(place);
  const facts = factsOf(place);
  const base = { source: DISCOVERY_SOURCE, sourceUrl: place.mapsUrl, evidence, facts };
  if (place.closed) return { member: { personId: null, name: place.displayName, reason: `listed on Google Maps as ${place.closed.toLowerCase()}`, ...base }, outcome: "excluded", email: false };

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
    discoveredVia: "Google Maps",
  };
  const person = await withLeadTransaction(async (tx) => {
    if (email) {
      return upsertPerson(tx, {
        email,
        phone,
        company: { name: place.displayName, domain: place.domain, linkedinUrl: place.companyLinkedin },
        raw,
        source: "discovery:google-maps",
      });
    }
    const created = await findOrCreateContactPerson(tx, {
      fullName: null,
      phone: phone!,
      companyName: place.displayName,
      companyDomain: place.domain,
      title: null,
      email: null,
    }, "discovery:google-maps");
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
