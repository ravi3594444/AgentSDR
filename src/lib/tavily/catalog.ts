import type { ResearchSource } from "@/lib/research/schema";

/**
 * Tavily (tavily.com) as the web search behind "Website and directory
 * search": a search API that returns real result pages (URL, title, a
 * snippet of the page) instead of a model's answer. An organization saves
 * its own key in Settings → Providers & features → Tavily; while one is saved,
 * website searches use it instead of the AI provider's web search.
 *
 * Protocol (docs.tavily.com, API reference read 2026-10-17): POST /search
 * with `Authorization: Bearer tvly-…`; a "basic" search is 1 API credit and
 * returns up to 20 results. GET /usage reports the key's and the plan's
 * credits without spending any. Errors: 401 bad key, 429 rate limit, 432
 * plan limit, 433 pay-as-you-go limit.
 *
 * Pure and client-safe: parsing and the daily cap, so each is unit-tested.
 * tavily.server.ts makes the calls.
 */

export const TAVILY_API_URL = "https://api.tavily.com";

export const TAVILY_LIMITS = {
  /** Searches the organization allows itself in 24 hours (one website search is 2–3 of them). */
  dailySearches: { default: 100, min: 1, max: 2_000 },
  /** Results asked for per search (Tavily's maximum). */
  resultsPerSearch: 20,
} as const;

/** What an owner sees and edits in Settings → Providers & features → Tavily (never the key). */
export type TavilySettingsView = {
  /** On the Included service: the platform's key; no key, hint or plan is shown. */
  included?: boolean;
  connected: boolean;
  keyHint: string | null;
  dailySearches: number;
  /** Tavily searches website searches used in the last 24 hours. */
  searchesToday: number;
  /** The Tavily plan's credits, as Tavily reported them (null when it could not be read). */
  plan: TavilyPlan | null;
};

export type TavilyPlan = { name: string | null; used: number | null; limit: number | null };

/** The result pages of a search, in Tavily's order: http(s) URLs only, each once. */
export function tavilySources(body: unknown, limit: number = TAVILY_LIMITS.resultsPerSearch): ResearchSource[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const seen = new Set<string>();
  const out: ResearchSource[] = [];
  for (const raw of results) {
    const row = (raw && typeof raw === "object" ? raw : {}) as { url?: unknown; title?: unknown; content?: unknown };
    if (typeof row.url !== "string") continue;
    let url: URL;
    try {
      url = new URL(row.url.trim());
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, max) : null);
    out.push({ url: url.href, title: text(row.title, 200), snippet: text(row.content, 500) });
    if (out.length >= limit) break;
  }
  return out;
}

/** The plan's credits from GET /usage (`account`), or null when the answer has none. */
export function tavilyPlanOf(body: unknown): TavilyPlan | null {
  const account = (body as { account?: unknown } | null)?.account;
  if (!account || typeof account !== "object") return null;
  const row = account as { current_plan?: unknown; plan_usage?: unknown; plan_limit?: unknown };
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return { name: typeof row.current_plan === "string" ? row.current_plan : null, used: number(row.plan_usage), limit: number(row.plan_limit) };
}

/** Why a website search needing `wanted` more Tavily searches may not start now, or null. */
export function tavilyCapProblem(usedToday: number, wanted: number, dailySearches: number): string | null {
  if (usedToday + wanted <= dailySearches) return null;
  const left = Math.max(0, dailySearches - usedToday);
  return `the daily Tavily cap (${dailySearches} searches, Settings → Providers & features → Tavily) leaves ${left} search${left === 1 ? "" : "es"} in the last 24 hours, and this website search needs ${wanted}`;
}
