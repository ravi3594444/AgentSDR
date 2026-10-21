import "server-only";

/**
 * Bright Data's Scraper API and SERP API (docs.brightdata.com), only the
 * calls AgentSDR makes: start a collection (POST /datasets/v3/trigger), read
 * its progress, download its snapshot, cancel it, list the scrapers of a
 * domain (to check a key; costs nothing), and one SERP request. Nothing here
 * changes billing, plans or zones. The key is the organization's own
 * (brightdata.server.ts), sent as a Bearer header, never in a URL.
 *
 * Bright Data blocks an IP after 25 rate-limit answers (HTTP 429) within 5
 * minutes, so nothing here retries: a 429 comes back as a BrightdataError
 * with the wait it asked for (Retry-After), and the job waits a step.
 */

const API = "https://api.brightdata.com";
const TIMEOUT_MS = 30_000;
/** A snapshot of a few hundred records with comments is a few MB; it gets longer than an ordinary call. */
const DOWNLOAD_TIMEOUT_MS = 90_000;
/** A SERP request answers synchronously, usually within seconds. */
const SERP_TIMEOUT_MS = 60_000;

export class BrightdataError extends Error {
  constructor(
    /** HTTP status; null when Bright Data could not be reached or did not answer. */
    readonly status: number | null,
    message: string,
    /** How long a 429 asked to wait, when it said. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "BrightdataError";
  }
}

/** Test hook: the e2e check points this at a stand-in. */
let apiBase = API;
export function setBrightdataApiBase(base: string | null): void {
  apiBase = base ?? API;
}

function retryAfter(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

async function call<T>(key: string, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    throw new BrightdataError(null, `Bright Data could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Read as text first: Bright Data answers some failures with plain text, not JSON.
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const detail = json && typeof json === "object"
      ? String((json as { error?: unknown; message?: unknown }).error ?? (json as { message?: unknown }).message ?? "")
      : text.slice(0, 200);
    throw new BrightdataError(response.status, `Bright Data answered HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`, response.status === 429 ? retryAfter(response) : null);
  }
  if (json === null && text.trim()) throw new BrightdataError(response.status, `Bright Data answered with something that is not JSON: ${text.slice(0, 200)}`);
  return json as T;
}

export type CollectionRequest = {
  datasetId: string;
  /** Discovery (type=discover_new) by this method, e.g. "keyword"; omitted: collect by URL. */
  discoverBy?: string | null;
  inputs: Record<string, unknown>[];
  /** At most this many records per input (discovery). */
  limitPerInput?: number | null;
};

/**
 * Starts a collection and returns its snapshot id at once (the records
 * arrive later: snapshotProgress, then downloadSnapshot). Bright Data bills
 * every record it delivers, including records for inputs that failed.
 */
export async function triggerCollection(key: string, request: CollectionRequest): Promise<{ snapshotId: string }> {
  const query = new URLSearchParams({ dataset_id: request.datasetId, include_errors: "true", format: "json" });
  if (request.discoverBy) {
    query.set("type", "discover_new");
    query.set("discover_by", request.discoverBy);
  }
  const body: Record<string, unknown> = { input: request.inputs };
  if (request.limitPerInput) body.limit_per_input = request.limitPerInput;
  const result = await call<{ snapshot_id?: unknown }>(key, "POST", `/datasets/v3/trigger?${query}`, body);
  if (typeof result?.snapshot_id !== "string" || !result.snapshot_id) throw new BrightdataError(200, "Bright Data answered without a snapshot id");
  return { snapshotId: result.snapshot_id };
}

export type SnapshotProgress = {
  /** starting | running | ready | failed (and canceled, which Bright Data may report for a cancelled one). */
  status: string;
  records: number | null;
  errors: number | null;
  errorCodes: Record<string, number>;
};

export async function snapshotProgress(key: string, snapshotId: string): Promise<SnapshotProgress> {
  const result = await call<Record<string, unknown>>(key, "GET", `/datasets/v3/progress/${encodeURIComponent(snapshotId)}`);
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const codes: Record<string, number> = {};
  if (result?.error_codes && typeof result.error_codes === "object") {
    for (const [code, count] of Object.entries(result.error_codes as Record<string, unknown>)) {
      if (typeof count === "number") codes[code] = count;
    }
  }
  return { status: typeof result?.status === "string" ? result.status : "unknown", records: number(result?.records), errors: number(result?.errors), errorCodes: codes };
}

/** A ready snapshot's records (and, with include_errors, one record per failed input). Downloading again costs nothing. */
export async function downloadSnapshot(key: string, snapshotId: string): Promise<unknown[]> {
  const result = await call<unknown>(key, "GET", `/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}?format=json`, undefined, DOWNLOAD_TIMEOUT_MS);
  return Array.isArray(result) ? result : [];
}

export async function cancelSnapshot(key: string, snapshotId: string): Promise<void> {
  await call(key, "POST", `/datasets/v3/snapshot/${encodeURIComponent(snapshotId)}/cancel`);
}

/** Checks a key before it is saved: the scrapers of one domain (free). */
export async function verifyBrightdataKey(key: string): Promise<{ scrapers: number }> {
  const result = await call<unknown>(key, "GET", "/datasets/v3/scrapers?domain=reddit.com");
  const list = Array.isArray(result) ? result : Array.isArray((result as { scrapers?: unknown })?.scrapers) ? (result as { scrapers: unknown[] }).scrapers : [];
  return { scrapers: list.length };
}

export type SerpResult = { url: string; title: string | null; snippet: string | null };

/**
 * One Google search through a SERP API zone the owner created in Bright
 * Data's control panel (one billed request). Parsed results only.
 */
export async function serpSearch(key: string, zone: string, query: string, options: { country?: string | null; num?: number } = {}): Promise<SerpResult[]> {
  const search = new URLSearchParams({ q: query, num: String(options.num ?? 20) });
  if (options.country) search.set("gl", options.country.toLowerCase());
  const result = await call<{ organic?: unknown }>(key, "POST", "/request", {
    zone,
    url: `https://www.google.com/search?${search}`,
    format: "raw",
    data_format: "parsed_light",
  }, SERP_TIMEOUT_MS);
  const organic = Array.isArray(result?.organic) ? (result.organic as Record<string, unknown>[]) : [];
  return organic.flatMap((item) => (typeof item.link === "string"
    ? [{ url: item.link, title: typeof item.title === "string" ? item.title : null, snippet: typeof item.description === "string" ? item.description : null }]
    : []));
}
