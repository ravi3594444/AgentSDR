import { readTextRecords } from "@/lib/spreadsheet/read";
import { checkPhone } from "@/lib/calls/phone";
import { cleanEmail, emailMatchesDomain, ownWebsite, websiteDomain } from "./contacts";

/**
 * Public business listings from the self-hosted Google Maps scraper
 * (github.com/gosom/google-maps-scraper, web mode): its job CSV parsed into
 * one record per place. Pure. Field names are the scraper's CSV headers
 * (gmaps/entry.go CsvHeaders, checked against v1.18): title, category,
 * address, website, phone, link, place_id, cid, complete_address (JSON),
 * review_count, review_rating, status, emails (comma-separated, read from the
 * business's own website when the job ran with email extraction).
 */

export type MapsPlace = {
  /** Google's place id (or cid) — the dedupe key across searches. */
  placeKey: string;
  name: string;
  category: string | null;
  address: string | null;
  city: string | null;
  /** ISO country code when the listing's address carries one. */
  country: string | null;
  /** The Maps listing itself: the source of the name, phone and website. */
  mapsUrl: string | null;
  website: string | null;
  domain: string | null;
  /** The phone as listed, normalized to E.164 when it can be. */
  phone: string | null;
  phoneProblem: string | null;
  emails: string[];
  rating: number | null;
  reviewCount: number | null;
  /** "permanently closed" and the like; null when open or unknown. */
  closed: string | null;
};

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function number(value: string | undefined): number | null {
  const parsed = Number(value?.trim());
  return Number.isFinite(parsed) && value?.trim() ? parsed : null;
}

function addressParts(raw: string | undefined): { city: string | null; country: string | null } {
  if (!raw?.trim()) return { city: null, country: null };
  try {
    const parsed = JSON.parse(raw) as { city?: unknown; country?: unknown };
    const country = typeof parsed.country === "string" && /^[A-Za-z]{2}$/.test(parsed.country.trim()) ? parsed.country.trim().toUpperCase() : null;
    return { city: typeof parsed.city === "string" && parsed.city.trim() ? parsed.city.trim() : null, country };
  } catch {
    return { city: null, country: null };
  }
}

const CLOSED = /closed/i;

/**
 * Every place in a scraper CSV. Rows without a name are dropped; repeats of
 * the same place (the scraper can return one twice across scroll pages) keep
 * the first. Emails are kept only when they are well-formed and not junk;
 * one on another domain than the listed website is kept too (many small
 * businesses use Gmail), since the scraper read it from that website.
 */
export function parseMapsCsv(csv: string | Uint8Array, defaultCountry?: string): MapsPlace[] {
  const bytes = typeof csv === "string" ? new TextEncoder().encode(csv) : csv;
  const { records } = readTextRecords(bytes);
  const seen = new Set<string>();
  const places: MapsPlace[] = [];
  for (const row of records) {
    const name = text(row.title);
    if (!name) continue;
    const placeKey = text(row.place_id) ?? text(row.cid) ?? text(row.data_id) ?? text(row.link) ?? `${name}|${text(row.address) ?? ""}`;
    if (seen.has(placeKey)) continue;
    seen.add(placeKey);

    const { city, country } = addressParts(row.complete_address);
    const website = ownWebsite(row.website);
    const rawPhone = text(row.phone);
    const phoneCheck = rawPhone ? checkPhone(rawPhone, country ?? defaultCountry) : null;
    const emails = [...new Set((row.emails ?? "").split(/[\s,;]+/).map((value) => cleanEmail(value)).filter((value): value is string => Boolean(value)))];
    const status = text(row.status);
    places.push({
      placeKey,
      name,
      category: text(row.category),
      address: text(row.address),
      city,
      country,
      mapsUrl: text(row.link),
      website,
      domain: websiteDomain(website),
      phone: phoneCheck?.ok ? phoneCheck.e164 : null,
      phoneProblem: rawPhone && phoneCheck && !phoneCheck.ok ? phoneCheck.reason : null,
      emails,
      rating: number(row.review_rating),
      reviewCount: number(row.review_count),
      closed: status && CLOSED.test(status) ? status : null,
    });
  }
  return places;
}

/** The emails of a place, its own-domain addresses first (they are the likeliest real inbox). */
export function rankEmails(emails: readonly string[], domain: string | null): string[] {
  return [...emails].sort((a, b) => Number(emailMatchesDomain(b, domain)) - Number(emailMatchesDomain(a, domain)));
}

/** The search phrase sent to the scraper: "dentists in Pune, India". */
export function mapsSearchPhrase(what: string, where: string | null | undefined): string {
  const subject = what.trim().replace(/\s+/g, " ");
  const place = where?.trim().replace(/\s+/g, " ");
  return place ? `${subject} in ${place}` : subject;
}
