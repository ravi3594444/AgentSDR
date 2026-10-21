import { BROWSER_LIMITS } from "@/lib/browser/snapshot";
import type { ResearchSource } from "@/lib/research/schema";

/**
 * TinyFish (tinyfish.ai) as the organization's general web access: one API
 * key for Search (result pages), Fetch (a page's clean text and links) and
 * Browser (a remote Chromium driven over CDP). The owner saves the key in
 * Settings → Lead research → TinyFish; nothing reads it from the environment.
 *
 * Protocol (docs.tinyfish.ai reference pages, read 2026-10-18):
 * - Search: `GET https://api.search.tinyfish.ai?query=…` with `X-API-Key`;
 *   `{ query, results: [{ position, site_name, title, snippet, url, date? }],
 *   total_results, page }`. Pages 0–10.
 * - Fetch: `POST https://api.fetch.tinyfish.ai` `{ urls (1–10), format,
 *   links }` → `{ results: [{ url, final_url, title, description, language,
 *   published_date, text, links? }], errors: [{ url, error, status? }] }`.
 *   A failed URL is an `errors[]` entry in a 200, never an HTTP error.
 * - Browser: `POST https://api.browser.tinyfish.ai` `{ url?, timeout_seconds }`
 *   → 201 `{ session_id, cdp_url, base_url }` (10–30 s);
 *   `DELETE https://api.browser.tinyfish.ai/{session_id}` → 204, idempotent.
 * - Errors: 401 key, 402 `INSUFFICIENT_CREDITS` / `FREE_ALLOWANCE_EXHAUSTED`
 *   (the free daily allowance is used up), 429 rate limit (`Retry-After`,
 *   `x-ratelimit-reset` in epoch seconds), 503 busy.
 *
 * Free use, per API key (so two organizations sharing one key share it):
 * Search 30 requests a minute, 500 an hour and 12,000 a day; Fetch 150 URLs
 * a minute and 1,000 a day; the day resets at 00:00 UTC. Past the daily
 * allowance TinyFish draws from the account's Wallet, so AgentSDR stops at
 * the free line (FREE_LIMITS) and waits for the reset instead. Browser is
 * metered ($0.002 a minute) and runs only within the organization's own
 * browser allowance, which is 0 until an owner sets one.
 *
 * Pure and client-safe; services/tinyfish.ts makes the calls.
 */

export const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";
export const TINYFISH_FETCH_URL = "https://api.fetch.tinyfish.ai";
export const TINYFISH_BROWSER_URL = "https://api.browser.tinyfish.ai";

export type TinyfishProduct = "search" | "fetch" | "browser";

/** TinyFish's free allowance per API key, as its reference documents it (2026-10-18). */
export const TINYFISH_FREE_LIMITS = {
  search: { perMinute: 30, perHour: 500, perDay: 12_000 },
  fetch: { perMinute: 150, perDay: 1_000 },
} as const;

export const TINYFISH_LIMITS = {
  /** Browser minutes the organization allows itself in a day (UTC). 0 keeps the metered browser off. */
  browserMinutesPerDay: { default: 0, min: 0, max: 240 },
  /** TinyFish's Browser price, for the spend shown beside the allowance. */
  browserUsdPerMinute: 0.002,
  /** URLs one Fetch call may carry. */
  fetchUrlsPerCall: 10,
  /** Highest Search page TinyFish serves (pages start at 0). */
  maxSearchPage: 10,
  /** Characters kept from one fetched page for the assistant. */
  maxPageChars: 12_000,
  /** Links kept from one fetched page. */
  maxPageLinks: 80,
} as const;

/** What Settings → Lead research → TinyFish shows and edits (never the key). */
export type TinyfishSettingsView = {
  connected: boolean;
  keyHint: string | null;
  /** Web searches use TinyFish while connected; off sends them to Tavily or the AI provider instead. */
  useForWebSearch: boolean;
  browserMinutesPerDay: number;
  /** Today's (UTC) use of the key's free allowance, across every organization using the same key. */
  today: { searches: number; fetchedUrls: number; browserMinutes: number };
  /** Set while TinyFish has asked AgentSDR to wait (a rate limit or a used-up daily allowance). */
  waitingUntil: string | null;
  waitingReason: string | null;
};

export type TinyfishSearchHit = ResearchSource & { site: string | null; date: string | null };

export type TinyfishPage = {
  url: string;
  finalUrl: string;
  title: string | null;
  description: string | null;
  language: string | null;
  publishedDate: string | null;
  text: string;
  /** Public http(s) links on the page, absolute, each once. */
  links: string[];
  /** mailto: and tel: links on the page, for contact extraction. */
  contactLinks: string[];
};

export type TinyfishFetchFailure = { url: string; code: string; status: number | null };

function clean(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, max) : null;
}

/** An http(s) URL in its normalised form, or null. */
export function webUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Search results in TinyFish's order: http(s) URLs only, each once. */
export function tinyfishSearchHits(body: unknown, limit = 20): TinyfishSearchHit[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const seen = new Set<string>();
  const hits: TinyfishSearchHit[] = [];
  for (const raw of results) {
    const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const url = webUrl(row.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    hits.push({ url, title: clean(row.title, 200), snippet: clean(row.snippet, 500), site: clean(row.site_name, 120), date: clean(row.date, 40) });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** A Fetch answer: the pages that were read and why the others were not. */
export function tinyfishFetchResult(body: unknown): { pages: TinyfishPage[]; failures: TinyfishFetchFailure[] } {
  const row = (body && typeof body === "object" ? body : {}) as { results?: unknown; errors?: unknown };
  const pages: TinyfishPage[] = [];
  for (const raw of Array.isArray(row.results) ? row.results : []) {
    const page = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const url = webUrl(page.url);
    if (!url) continue;
    const rawLinks = Array.isArray(page.links) ? page.links.filter((link): link is string => typeof link === "string") : [];
    const links = [...new Set(rawLinks.map(webUrl).filter((link): link is string => Boolean(link)))].slice(0, TINYFISH_LIMITS.maxPageLinks);
    const contactLinks = [...new Set(rawLinks.map((link) => link.trim()).filter((link) => /^(?:mailto|tel):/i.test(link)))].slice(0, 40);
    pages.push({
      url,
      finalUrl: webUrl(page.final_url) ?? url,
      title: clean(page.title, 300),
      description: clean(page.description, 500),
      language: clean(page.language, 20),
      publishedDate: clean(page.published_date, 40),
      text: typeof page.text === "string" ? page.text.slice(0, TINYFISH_LIMITS.maxPageChars) : "",
      links,
      contactLinks,
    });
  }
  const failures: TinyfishFetchFailure[] = [];
  for (const raw of Array.isArray(row.errors) ? row.errors : []) {
    const error = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (typeof error.url !== "string") continue;
    failures.push({ url: error.url, code: typeof error.error === "string" ? error.error : "unknown", status: typeof error.status === "number" ? error.status : null });
  }
  return { pages, failures };
}

/** Why TinyFish could not read a URL, in an owner's words. */
export function fetchFailureText(failure: Pick<TinyfishFetchFailure, "code" | "status">): string {
  switch (failure.code) {
    case "page_not_found": return "the page does not exist";
    case "target_http_error": return `the site answered HTTP ${failure.status ?? "error"}`;
    case "target_unreachable": return "the site could not be reached";
    case "timeout": return "the page took too long to load";
    case "bot_blocked": return "the site blocks automated reading";
    case "empty_content": return "the page has no readable text";
    case "login_required": return "the page needs a login";
    case "content_too_large": return "the page is too large";
    case "invalid_url":
    case "invalid_redirect_url": return "the address is not a public web page";
    default: return `TinyFish could not read it (${failure.code})`;
  }
}

/** The masked form of a key shown after saving it. */
export function keyHint(key: string): string {
  return `…${key.slice(-4)}`;
}

/**
 * Why a browser-minutes allowance cannot be saved, or null: a whole number
 * within TINYFISH_LIMITS, and 0 (off) or at least one session's length —
 * each session reserves its full length up front, so fewer minutes could
 * never open one. The settings card shows it as typed; the server refuses it.
 */
export function browserMinutesProblem(value: number): string | null {
  const { min, max } = TINYFISH_LIMITS.browserMinutesPerDay;
  if (!Number.isInteger(value) || value < min || value > max) return `Browser minutes a day must be a whole number from ${min} to ${max}`;
  if (value > 0 && value < BROWSER_LIMITS.maxSessionMinutes) return `Browser minutes a day must be 0 (off) or at least ${BROWSER_LIMITS.maxSessionMinutes}, one session's length`;
  return null;
}

/** The line under the settings card's browser-minutes field, for what is typed: the rule while it cannot be saved, else what it allows. */
export function browserMinutesHint(typed: string): { problem: boolean; text: string } {
  const minutes = Number(typed);
  const problem = browserMinutesProblem(minutes);
  if (problem) return { problem: true, text: `${problem}.` };
  if (minutes === 0) return { problem: false, text: "The assistant cannot open a browser." };
  return { problem: false, text: `Up to about $${(minutes * TINYFISH_LIMITS.browserUsdPerMinute).toFixed(2)} a day at TinyFish's $${TINYFISH_LIMITS.browserUsdPerMinute}/minute; one browser at a time.` };
}

/** A key that cannot be a TinyFish API key, or null. */
export function keyProblem(key: string): string | null {
  if (key.length < 16 || key.length > 300 || /\s/.test(key)) return "That does not look like a TinyFish API key.";
  return null;
}
