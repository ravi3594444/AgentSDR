import "server-only";

/**
 * Client for the self-hosted Google Maps scraper (gosom/google-maps-scraper
 * in `-web` mode, docker-compose service `gmaps-scraper`). Its REST API,
 * checked against the scraper's source (web/web.go, web/job.go, v1.18):
 *
 *   POST /api/v1/jobs          {name, keywords[], lang, depth, email, max_time (seconds), zoom, radius, lat, lon, fast_mode}
 *                              → 201 {id}; 422 {code, message} on a bad request
 *   GET  /api/v1/jobs/{id}     → {ID, Name, Date, Status: pending|working|ok|failed, Data}
 *   GET  /api/v1/jobs/{id}/download → the results CSV (404 until it exists)
 *   DELETE /api/v1/jobs/{id}
 *
 * Fast mode (`fast_mode` with lat/lon/radius/zoom) reads the search results'
 * own data instead of opening each place page. Checked live on 2026-10-15
 * against v1.18.1: the place-page mode returned every listing with empty
 * fields (Google now loads place details by a separate request the scraper
 * does not read), while fast mode returned names, phones, websites and
 * addresses — at most 20 places per search, so discovery tiles the area
 * (geocode.ts) and runs one fast search per tile.
 *
 * The scraper is infrastructure shared by every organization on this
 * server, like the database, so its address comes from GMAPS_SCRAPER_URL
 * (set by docker-compose to the sidecar), not from a per-organization
 * integration. It has no authentication of its own: keep it off the public
 * network (the compose service publishes no port).
 */

export type MapsJobStatus = "pending" | "working" | "ok" | "failed";

export class MapsScraperError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "MapsScraperError";
  }
}

/** The scraper's base URL, or null when this server has none configured. */
export function mapsScraperUrl(): string | null {
  const value = process.env.GMAPS_SCRAPER_URL?.trim().replace(/\/+$/, "");
  if (!value) return null;
  return /^https?:\/\/[^\s/]+/.test(value) ? value : null;
}

function requireUrl(): string {
  const url = mapsScraperUrl();
  if (!url) throw new MapsScraperError("Google Maps lead discovery is not set up on this server (GMAPS_SCRAPER_URL is empty). See docs/product/OWNER_SETUP.md.");
  return url;
}

async function call(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const base = requireUrl();
  try {
    return await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
  } catch (error) {
    throw new MapsScraperError(`The Google Maps scraper at ${base} did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function failure(response: Response, what: string): Promise<MapsScraperError> {
  const body = await response.text().catch(() => "");
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === "string") detail = parsed.message;
  } catch {
    // not JSON
  }
  return new MapsScraperError(`The Google Maps scraper refused to ${what} (HTTP ${response.status})${detail ? `: ${detail}` : ""}`, response.status);
}

export type MapsJobInput = {
  name: string;
  /** One search per keyword, e.g. "dentists in Pune". */
  keywords: string[];
  /** Two-letter language code for Google Maps. */
  lang: string;
  /** Scroll depth of each results list: about 20 places per step. */
  depth: number;
  /** Visit each business's website for email addresses. */
  email: boolean;
  /** Hard stop for the whole job, in seconds. */
  maxTimeSeconds: number;
  /** Fast mode around a point (needs lat/lon); radius in meters. */
  fast?: { lat: number; lon: number; radiusMeters: number; zoom: number } | null;
};

export async function createMapsJob(input: MapsJobInput): Promise<string> {
  const response = await call("/api/v1/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      keywords: input.keywords,
      lang: input.lang,
      depth: input.depth,
      email: input.email,
      max_time: input.maxTimeSeconds,
      zoom: input.fast?.zoom ?? 15,
      ...(input.fast
        ? { fast_mode: true, lat: input.fast.lat.toFixed(6), lon: input.fast.lon.toFixed(6), radius: Math.round(input.fast.radiusMeters) }
        : {}),
    }),
  });
  if (response.status !== 201 && !response.ok) throw await failure(response, "start the search");
  const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof body?.id !== "string" || !body.id) throw new MapsScraperError("The Google Maps scraper started a search but returned no job id");
  return body.id;
}

export async function getMapsJobStatus(id: string): Promise<MapsJobStatus> {
  const response = await call(`/api/v1/jobs/${encodeURIComponent(id)}`);
  if (!response.ok) throw await failure(response, "report the search");
  const body = (await response.json().catch(() => null)) as { Status?: unknown; status?: unknown } | null;
  const status = String(body?.Status ?? body?.status ?? "").toLowerCase();
  if (status === "pending" || status === "working" || status === "ok" || status === "failed") return status;
  throw new MapsScraperError(`The Google Maps scraper reported an unknown job status "${status}"`);
}

export async function downloadMapsResults(id: string): Promise<Uint8Array> {
  const response = await call(`/api/v1/jobs/${encodeURIComponent(id)}/download`, { timeoutMs: 120_000 });
  if (!response.ok) throw await failure(response, "hand over the results");
  return new Uint8Array(await response.arrayBuffer());
}

export async function deleteMapsJob(id: string): Promise<void> {
  await call(`/api/v1/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
}
