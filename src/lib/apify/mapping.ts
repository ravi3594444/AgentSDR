import { checkPhone } from "@/lib/calls/phone";
import { cleanEmail, ownWebsite, websiteDomain } from "@/lib/discovery/contacts";
import { cleanBusinessName, type MapsPlace } from "@/lib/discovery/mapsResults";
import { APIFY_LIMITS } from "./catalog";

/**
 * Pure parts of Apify discovery: whether a run may start (the owner's budget
 * and the account's allowance), what a failure means, and how an Actor's
 * dataset items become places and Instagram prospects. Nothing here invents
 * a value: a field the item does not carry stays empty, and every contact
 * keeps the page it was read from.
 */

// ── allowance ────────────────────────────────────────────────────────────────

export type ApifyAllowanceInput = {
  monthlyBudgetUsd: number;
  maxChargePerRunUsd: number;
  /** This organization's finished runs this month (UTC), in USD. */
  spentThisMonthUsd: number;
  /** What its open runs may still spend (their caps). */
  reservedUsd: number;
  openRuns: number;
  /** The Apify account's own monthly allowance, when it could be read. */
  account: { maxMonthlyUsageUsd: number | null; monthlyUsageUsd: number | null } | null;
};

export type ApifyAllowance = { ok: true; maxChargeUsd: number } | { ok: false; exhausted: boolean; reason: string };

/**
 * Whether one more run may start, and the most it may spend: the owner's
 * per-run cap, never more than what is left of the owner's monthly budget or
 * of the Apify account's monthly allowance. Fails closed when the allowance
 * cannot be read.
 */
export function apifyAllowance(input: ApifyAllowanceInput): ApifyAllowance {
  if (input.openRuns >= APIFY_LIMITS.openRuns) {
    return { ok: false, exhausted: false, reason: `${input.openRuns} Apify runs are still open for this organization` };
  }
  const budgetLeft = input.monthlyBudgetUsd - input.spentThisMonthUsd - input.reservedUsd;
  if (budgetLeft < 0.05) {
    return { ok: false, exhausted: true, reason: `this month's Apify budget ($${input.monthlyBudgetUsd.toFixed(2)}) is used up` };
  }
  if (!input.account) return { ok: false, exhausted: false, reason: "the Apify account's allowance could not be read" };
  const { maxMonthlyUsageUsd, monthlyUsageUsd } = input.account;
  const accountLeft = maxMonthlyUsageUsd === null || monthlyUsageUsd === null ? null : maxMonthlyUsageUsd - monthlyUsageUsd;
  if (accountLeft !== null && accountLeft < 0.05) {
    return { ok: false, exhausted: true, reason: "the Apify account's monthly usage limit is reached (AgentSDR never tops up or raises it)" };
  }
  const maxChargeUsd = Math.min(input.maxChargePerRunUsd, budgetLeft, accountLeft ?? Infinity);
  return { ok: true, maxChargeUsd: Math.floor(maxChargeUsd * 100) / 100 };
}

/** Whether an Apify error or run status means credits or limits ran out (rather than a fault). */
export function looksExhausted(input: { httpStatus?: number | null; type?: string | null; message?: string | null }): boolean {
  if (input.httpStatus === 402) return true;
  const text = `${input.type ?? ""} ${input.message ?? ""}`.toLowerCase();
  return /not-enough-usage|usage-limit|monthly-usage|payment|insufficient|credit|exceeded.*(?:limit|usage)|(?:limit|usage).*exceeded|max(?:imum)? ?total ?charge|platform-feature-disabled/.test(text);
}

/** A finished run's state: complete, or ended early with whatever it already wrote. */
export function runOutcome(status: string): "running" | "succeeded" | "ended_early" {
  if (status === "READY" || status === "RUNNING" || status === "TIMING-OUT" || status === "ABORTING") return "running";
  return status === "SUCCEEDED" ? "succeeded" : "ended_early";
}

// ── Google Maps Scraper items → places ──────────────────────────────────────

type Json = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The Google Maps Scraper's items as places, deduplicated by Google's place
 * id. Read defensively — the field names are the Actor's documented output
 * (title, placeId, categoryName, address, city, countryCode, phone, website,
 * url, totalScore, reviewsCount, permanentlyClosed / temporarilyClosed), not
 * verified against a live run here.
 */
export function placesFromMapsItems(items: readonly unknown[], defaultCountry?: string): { places: MapsPlace[]; skipped: number } {
  const seen = new Set<string>();
  const places: MapsPlace[] = [];
  let skipped = 0;
  for (const raw of items) {
    const item = raw && typeof raw === "object" ? (raw as Json) : null;
    const name = item ? text(item.title) : null;
    if (!item || !name) {
      skipped += 1;
      continue;
    }
    const placeKey = text(item.placeId) ?? text(item.cid) ?? text(item.url) ?? `${name}|${text(item.address) ?? ""}`;
    if (seen.has(placeKey)) continue;
    seen.add(placeKey);
    const country = text(item.countryCode)?.toUpperCase() ?? null;
    const website = ownWebsite(text(item.website) ?? undefined);
    const rawPhone = text(item.phone) ?? text(item.phoneUnformatted);
    const phoneCheck = rawPhone ? checkPhone(rawPhone, country ?? defaultCountry) : null;
    const emails = Array.isArray(item.emails) ? [...new Set(item.emails.map((value) => cleanEmail(String(value))).filter((value): value is string => Boolean(value)))] : [];
    places.push({
      placeKey,
      name,
      displayName: cleanBusinessName(name),
      category: text(item.categoryName),
      address: text(item.address),
      city: text(item.city),
      country,
      mapsUrl: text(item.url),
      website,
      domain: websiteDomain(website),
      phone: phoneCheck?.ok ? phoneCheck.e164 : null,
      phoneProblem: rawPhone && phoneCheck && !phoneCheck.ok ? phoneCheck.reason : null,
      emails,
      rating: num(item.totalScore),
      reviewCount: num(item.reviewsCount),
      closed: item.permanentlyClosed === true ? "permanently closed" : item.temporarilyClosed === true ? "temporarily closed" : null,
    });
  }
  return { places, skipped };
}

// ── Instagram ────────────────────────────────────────────────────────────────

/**
 * Hashtags for a customer type in a place: "dentist" + "Pune" →
 * punedentist, dentistpune, dentist. Letters and digits only, at most 5.
 */
export function hashtagsFor(what: string, where: string, extra: readonly string[] = []): string[] {
  const slug = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");
  const kind = slug(what.replace(/\b(?:clinics?|shops?|stores?|companies|company|businesses|business)\b/gi, "").trim() || what).replace(/s$/, "");
  const place = slug(where.split(",")[0] ?? where);
  const tags = [...extra.map((tag) => slug(tag.replace(/^#/, ""))), place && `${place}${kind}`, place && `${kind}${place}`, kind];
  return [...new Set(tags.filter((tag): tag is string => Boolean(tag) && tag.length >= 3 && tag.length <= 60))].slice(0, 5);
}

export type InstagramPost = { username: string; url: string | null; caption: string | null; timestamp: string | null; locationName: string | null; hashtag: string | null };

/** The hashtag scraper's posts, with their author's username (posts without one are skipped). */
export function postsFromHashtagItems(items: readonly unknown[]): InstagramPost[] {
  const out: InstagramPost[] = [];
  for (const raw of items) {
    const item = raw && typeof raw === "object" ? (raw as Json) : null;
    const username = item ? text(item.ownerUsername) ?? text((item.owner as Json | undefined)?.username) : null;
    if (!item || !username || !/^[A-Za-z0-9._]{1,30}$/.test(username)) continue;
    out.push({
      username: username.toLowerCase(),
      url: text(item.url),
      caption: text(item.caption)?.slice(0, 600) ?? null,
      timestamp: text(item.timestamp),
      locationName: text(item.locationName),
      hashtag: text(item.inputUrl)?.split("/tags/")[1]?.replace(/\/.*$/, "") ?? null,
    });
  }
  return out;
}

export type InstagramProfile = {
  username: string;
  fullName: string | null;
  biography: string | null;
  category: string | null;
  profileUrl: string;
  website: string | null;
  /** Contacts the profile itself publishes (business email / phone fields), when the Actor returns them. */
  email: string | null;
  phone: string | null;
  isPrivate: boolean;
};

/** The profile scraper's items, keyed by username. Field names read defensively; none is guessed. */
export function profilesFromItems(items: readonly unknown[], defaultCountry?: string): Map<string, InstagramProfile> {
  const out = new Map<string, InstagramProfile>();
  for (const raw of items) {
    const item = raw && typeof raw === "object" ? (raw as Json) : null;
    const username = item ? text(item.username)?.toLowerCase() : null;
    if (!item || !username) continue;
    const email = cleanEmail(text(item.businessEmail) ?? text(item.publicEmail) ?? text(item.email) ?? "") ?? null;
    const rawPhone = text(item.businessPhoneNumber) ?? text(item.publicPhoneNumber) ?? text(item.contactPhoneNumber);
    const phoneCheck = rawPhone ? checkPhone(rawPhone, defaultCountry) : null;
    out.set(username, {
      username,
      fullName: text(item.fullName),
      biography: text(item.biography)?.slice(0, 400) ?? null,
      category: text(item.businessCategoryName) ?? text(item.categoryName),
      profileUrl: text(item.url) ?? `https://www.instagram.com/${username}/`,
      website: ownWebsite(text(item.externalUrl) ?? undefined),
      email,
      phone: phoneCheck?.ok ? phoneCheck.e164 : null,
      isPrivate: item.private === true || item.isPrivate === true,
    });
  }
  return out;
}

/** Whether a post or profile names the place (city word, case-insensitive): otherwise its location stays unknown. */
export function mentionsPlace(where: string, ...texts: (string | null | undefined)[]): boolean {
  const city = (where.split(",")[0] ?? where).trim().toLowerCase();
  if (city.length < 3) return false;
  return texts.some((value) => Boolean(value && value.toLowerCase().includes(city)));
}
