import "server-only";

import { TINYFISH_BROWSER_URL, TINYFISH_FETCH_URL, TINYFISH_SEARCH_URL, type TinyfishProduct } from "@/lib/tinyfish/catalog";
import { resetAt, retryAfterMs } from "@/lib/quota/quota";

/**
 * TinyFish's REST API (docs.tinyfish.ai), only the calls AgentSDR makes:
 * one search, one fetch of up to 10 URLs, and creating and ending a remote
 * browser session. The key is the organization's own
 * (lib/tinyfish/tinyfish.server.ts), sent as `X-API-Key`, never in a URL.
 * Nothing here tops up a Wallet or changes the account.
 *
 * Every call is made once: retries, waits and quota accounting belong to
 * the caller (lib/tinyfish/tinyfish.server.ts), which knows whether a lost
 * answer may have been billed.
 */

const TIMEOUTS: Record<"search" | "fetch" | "browserCreate" | "browserDelete", number> = {
  search: 30_000,
  // TinyFish times a URL out at 110 s and the batch at 120 s; wait past that to get its answer.
  fetch: 150_000,
  // Creating a session takes 10–30 s.
  browserCreate: 60_000,
  browserDelete: 20_000,
};

export class TinyfishError extends Error {
  constructor(
    readonly product: TinyfishProduct,
    readonly status: number | null,
    readonly code: string | null,
    message: string,
    readonly retryAfterMs: number | null = null,
    readonly resetAt: Date | null = null,
  ) {
    super(message);
    this.name = "TinyfishError";
  }

  /** True when TinyFish may have done (and billed) the work although no answer arrived. */
  get uncertain(): boolean {
    return this.status === null || this.status === 504;
  }
}

type Bases = { search: string; fetch: string; browser: string };
const DEFAULT_BASES: Bases = { search: TINYFISH_SEARCH_URL, fetch: TINYFISH_FETCH_URL, browser: TINYFISH_BROWSER_URL };
let bases: Bases = DEFAULT_BASES;

/** Test hook: the e2e checks point the three hosts at a stand-in. */
export function setTinyfishApiBase(next: Partial<Bases> | null): void {
  bases = next ? { ...DEFAULT_BASES, ...next } : DEFAULT_BASES;
}

const LABEL: Record<TinyfishProduct, string> = { search: "TinyFish Search", fetch: "TinyFish Fetch", browser: "TinyFish Browser" };

function errorOf(product: TinyfishProduct, response: Response, body: unknown): TinyfishError {
  const error = (body as { error?: unknown } | null)?.error;
  const detail = (error && typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown };
  const code = typeof detail.code === "string" ? detail.code : typeof error === "string" ? error : null;
  const said = typeof detail.message === "string" ? detail.message.slice(0, 200) : null;
  const now = new Date();
  const wait = retryAfterMs(response.headers.get("retry-after"), now);
  const reset = resetAt(response.headers.get("x-ratelimit-reset"));
  const status = response.status;
  const label = LABEL[product];
  const message =
    status === 401 ? `${label} rejected the key`
    : status === 402 ? `${label}'s free daily allowance is used up${code ? ` (${code})` : ""}; AgentSDR never tops up the Wallet`
    : status === 404 && product === "browser" ? "TinyFish Browser is not enabled for this account"
    : status === 429 ? `${label} is rate limiting this key`
    : status === 503 ? `${label} is temporarily busy`
    : `${label} answered HTTP ${status}${said ? `: ${said}` : ""}`;
  return new TinyfishError(product, status, code, message, wait, reset);
}

async function call(product: TinyfishProduct, key: string, url: string, init: { method: "GET" | "POST" | "DELETE"; body?: unknown; timeoutMs: number }): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: { "X-API-Key": key, Accept: "application/json", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs),
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    throw new TinyfishError(product, null, null, `${LABEL[product]} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) throw errorOf(product, response, json);
  return json;
}

export type TinyfishSearchInput = {
  query: string;
  /** Why the search is made; TinyFish uses it to rank results. */
  purpose?: string | null;
  /** ISO country code, e.g. IN. */
  location?: string | null;
  language?: string | null;
  page?: number | null;
};

/** One search (one request of the free allowance). */
export async function tinyfishSearch(key: string, input: TinyfishSearchInput): Promise<unknown> {
  const params = new URLSearchParams({ query: input.query });
  if (input.purpose) params.set("purpose", input.purpose.slice(0, 2000));
  if (input.location) params.set("location", input.location);
  if (input.language) params.set("language", input.language);
  if (input.page) params.set("page", String(input.page));
  return call("search", key, `${bases.search}?${params}`, { method: "GET", timeoutMs: TIMEOUTS.search });
}

/** Reads up to 10 URLs as Markdown with their links (one URL of the free allowance each, counted when read). */
export async function tinyfishFetch(key: string, urls: string[], options: { purpose?: string | null } = {}): Promise<unknown> {
  return call("fetch", key, bases.fetch, {
    method: "POST",
    body: { urls, format: "markdown", links: true, ...(options.purpose ? { purpose: options.purpose.slice(0, 2000) } : {}), per_url_timeout_ms: 45_000 },
    timeoutMs: TIMEOUTS.fetch,
  });
}

export type TinyfishBrowserSession = { sessionId: string; cdpUrl: string; baseUrl: string | null };

/** Starts a remote browser (metered from creation until it ends or idles out for `timeoutSeconds`). */
export async function createTinyfishBrowserSession(key: string, input: { url?: string | null; timeoutSeconds: number }): Promise<TinyfishBrowserSession> {
  const body = await call("browser", key, bases.browser, {
    method: "POST",
    body: { ...(input.url ? { url: input.url } : {}), timeout_seconds: input.timeoutSeconds },
    timeoutMs: TIMEOUTS.browserCreate,
  });
  const row = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof row.session_id !== "string" || typeof row.cdp_url !== "string" || !/^wss?:\/\//.test(row.cdp_url)) {
    throw new TinyfishError("browser", 201, "BAD_RESPONSE", "TinyFish Browser answered without a session to connect to");
  }
  return { sessionId: row.session_id, cdpUrl: row.cdp_url, baseUrl: typeof row.base_url === "string" ? row.base_url : null };
}

/** Ends a session at once; ending one that has already ended succeeds too. */
export async function deleteTinyfishBrowserSession(key: string, sessionId: string): Promise<void> {
  await call("browser", key, `${bases.browser}/${encodeURIComponent(sessionId)}`, { method: "DELETE", timeoutMs: TIMEOUTS.browserDelete });
}
