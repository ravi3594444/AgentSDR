import "server-only";

import { BRAND } from "@/lib/brand";
import { publicAppUrl } from "@/lib/http/publicAppUrl";
import { parseNominatim, type GeoArea } from "./geocode";

/**
 * Turns the owner's "where" into a point and an area with OpenStreetMap's
 * Nominatim (free; usage policy: at most one request a second, an
 * identifying User-Agent — one request per lead search). GEOCODER_URL
 * points it at a self-hosted Nominatim; "off" disables geocoding, and
 * discovery then falls back to the scraper's place-page mode.
 */

const DEFAULT_URL = "https://nominatim.openstreetmap.org/search";
const cache = new Map<string, GeoArea | null>();
type Fetch = (input: URL, init: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (input, init) => fetch(input, init);

/** Test hook. */
export function setGeocoderFetch(impl: Fetch): void {
  fetchImpl = impl;
}

export function geocoderUrl(): string | null {
  const value = process.env.GEOCODER_URL?.trim();
  if (value === "off") return null;
  return value || DEFAULT_URL;
}

export async function geocodePlace(where: string, language: string): Promise<GeoArea | null> {
  const base = geocoderUrl();
  if (!base) return null;
  const key = `${language}:${where.trim().toLowerCase()}`;
  if (cache.has(key)) return cache.get(key)!;
  const url = new URL(base);
  url.searchParams.set("q", where);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("accept-language", language);
  const site = publicAppUrl();
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": `${BRAND.shortName}-lead-search/1.0${site ? ` (+${site})` : ""}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const area = parseNominatim(await response.json());
    cache.set(key, area);
    return area;
  } catch {
    return null;
  }
}
