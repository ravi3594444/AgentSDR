import { BRIGHTDATA_DATASETS, BRIGHTDATA_LIMITS, BRIGHTDATA_PLATFORMS, isBrightdataPlatform, type BrightdataDatasetKey, type BrightdataPlatform } from "@/lib/brightdata/catalog";
import { datasetForUrl } from "@/lib/brightdata/urls";

/**
 * Social research through Bright Data, the pure half (the job is in
 * socialResearch.server.ts): what a research_social_sources call asks for,
 * checked and filled in, and the search phrases each platform gets. The
 * model chooses the platforms, the words and the links; the owner's
 * records-per-search setting bounds every job (and is its default).
 */

/** Exact search phrases, and subreddits, one call may give. */
export const MAX_SOCIAL_KEYWORDS = 6;
export const MAX_SUBREDDITS = 6;
/** Links the model found itself that one call reads directly. */
export const MAX_SOCIAL_URLS = 50;
/** Keyword searches per platform (each is a web search, or one Reddit discovery input). */
export const MAX_QUERIES_PER_PLATFORM = 4;

/** Bright Data's Reddit keyword discovery date filter, by the argument's values. */
export const REDDIT_PERIODS = { past_week: "Past week", past_month: "Past month", past_year: "Past year", all_time: "All time" } as const;
export type RedditPeriod = keyof typeof REDDIT_PERIODS;
export const DEFAULT_REDDIT_PERIOD: RedditPeriod = "past_year";

/** A profile, page or post the model gave, in the form Bright Data is sent it. */
export type GivenSocialUrl = { url: string; dataset: BrightdataDatasetKey; platform: BrightdataPlatform };

export type SocialResearchCriteria = {
  platforms: BrightdataPlatform[];
  /** Who to find, e.g. "real estate agents"; empty when only a need, keywords or links were given. */
  customers: string;
  /** What they would be asking about or complaining of, in plain words; the search terms come from it. */
  need: string | null;
  where: string | null;
  /** Subreddits to search, without r/. */
  subreddits: string[];
  /** Exact search phrases, used as they are. */
  keywords: string[];
  /** Profiles, pages and posts read directly (absent on jobs started before links could be given). */
  urls?: GivenSocialUrl[];
  /** Links given that are not a post, profile or page Bright Data reads: reported, never sent (each would be a billed failure). */
  unreadableUrls?: string[];
  /** How far back Reddit's keyword search looks (absent: the past year). */
  since?: RedditPeriod;
  /** At most this many records across the job (posts, comments do not count, profiles, pages). */
  maxResults: number;
  language: string;
};

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function list(value: unknown, limit: number, each: number): string[] {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => text(item, each)).filter(Boolean))].slice(0, limit);
}

function redditPeriod(value: unknown): RedditPeriod | null {
  const key = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (key in REDDIT_PERIODS) return key as RedditPeriod;
  const short: Record<string, RedditPeriod> = { week: "past_week", month: "past_month", year: "past_year", all: "all_time", alltime: "all_time" };
  return short[key] ?? null;
}

/**
 * A research_social_sources call's arguments, checked: every platform when
 * none is named (Reddit still skips itself while the owner's switch is off),
 * who to find optional when a need, keywords or links say it, and the
 * owner's records-per-search as the default and the most.
 */
export function normalizeSocialCriteria(
  input: { platforms?: unknown; customers?: unknown; need?: unknown; where?: unknown; subreddits?: unknown; keywords?: unknown; urls?: unknown; since?: unknown; maxResults?: unknown; language?: unknown },
  limits: { maxRecordsPerSearch: number },
  fallbackLanguage = "en",
): SocialResearchCriteria | { error: string } {
  const named = Array.isArray(input.platforms) ? input.platforms : [];
  const explicit = [...new Set(named.filter(isBrightdataPlatform))];
  if (named.length && !explicit.length) return { error: "platforms may list reddit, x, instagram or facebook (leave it out for all of them)" };
  const customers = text(input.customers, 200);
  const need = text(input.need, 300) || null;
  const where = text(input.where, 200) || null;
  const subreddits = list(input.subreddits, MAX_SUBREDDITS, 40).map((name) => name.replace(/^\/?r\//i, "").replace(/\/$/, "")).filter((name) => /^[A-Za-z0-9_]{2,21}$/.test(name));
  const keywords = list(input.keywords, MAX_SOCIAL_KEYWORDS, 120);
  if (input.urls !== undefined && input.urls !== null && !Array.isArray(input.urls)) return { error: "urls must be an array of links" };
  const given = list(input.urls, 500, 500);
  const urls: GivenSocialUrl[] = [];
  const unreadableUrls: string[] = [];
  for (const raw of given) {
    const target = datasetForUrl(raw);
    if (!target) unreadableUrls.push(raw.slice(0, 300));
    else if (urls.length >= MAX_SOCIAL_URLS) unreadableUrls.push(`${raw.slice(0, 300)} (at most ${MAX_SOCIAL_URLS} links are read in one call)`);
    else if (!urls.some((item) => item.url === target.url)) urls.push({ url: target.url, dataset: target.dataset, platform: BRIGHTDATA_DATASETS[target.dataset].platform });
  }
  const searches = Boolean(customers || need || keywords.length);
  if (!searches && !urls.length) {
    return {
      error: unreadableUrls.length
        ? `none of the links is a post, profile or page Bright Data reads (${unreadableUrls.slice(0, 3).join(", ")}); give readable links, or say who to find (customers), what they would ask about (need) or keywords`
        : "say who to find (customers), what they would ask about (need), keywords, or links to read (urls)",
    };
  }
  let since: RedditPeriod = DEFAULT_REDDIT_PERIOD;
  if (input.since !== undefined && input.since !== null && input.since !== "") {
    const period = redditPeriod(input.since);
    if (!period) return { error: `since must be one of ${Object.keys(REDDIT_PERIODS).join(", ")}` };
    since = period;
  }
  // The platforms named (or, with search terms, every platform; with links only, theirs), and always those of the links given.
  const linked = [...new Set(urls.map((item) => item.platform))];
  const base = explicit.length ? explicit : searches ? [...BRIGHTDATA_PLATFORMS] : linked;
  const platforms = [...new Set([...base, ...linked])];
  const cap = Math.min(limits.maxRecordsPerSearch, BRIGHTDATA_LIMITS.maxRecordsPerSearch.max);
  const requested = Number(input.maxResults ?? cap);
  const maxResults = Number.isFinite(requested) ? Math.min(cap, Math.max(5, Math.round(requested))) : cap;
  const language = typeof input.language === "string" && /^[a-z]{2}$/i.test(input.language) ? input.language.toLowerCase() : fallbackLanguage;
  return { platforms, customers, need, where, subreddits, keywords, urls, unreadableUrls, since, maxResults, language };
}

/** The search phrases for a platform: the given keywords, else the need (and who has it), else who to find, with the place when one is named; none with links only. */
export function socialQueries(criteria: SocialResearchCriteria, platform: BrightdataPlatform): string[] {
  const base = criteria.keywords.length
    ? criteria.keywords
    : [criteria.need ?? criteria.customers, criteria.need && criteria.customers ? `${criteria.customers} ${criteria.need}` : null].filter((item): item is string => Boolean(item));
  const placed = criteria.where && platform !== "reddit" ? base.map((query) => `${query} ${criteria.where}`) : base;
  const site = platform === "reddit" ? null : platform === "x" ? "site:x.com" : platform === "instagram" ? "site:instagram.com" : "site:facebook.com";
  return [...new Set(placed.map((query) => (site ? `${site} ${query}` : query).replace(/\s+/g, " ").trim()))].slice(0, MAX_QUERIES_PER_PLATFORM);
}

/** What the research is about, for the chat and the list's name. */
export function socialPhrase(criteria: SocialResearchCriteria): string {
  const subject = criteria.need ?? (criteria.customers || criteria.keywords[0] || null);
  const links = criteria.urls?.length ?? 0;
  const about = subject ?? `${links} given link${links === 1 ? "" : "s"}`;
  return [about, criteria.where ? `in ${criteria.where}` : null].filter(Boolean).join(" ");
}

/** The links given for one platform. */
export function givenUrlsFor(criteria: Pick<SocialResearchCriteria, "urls">, platform: BrightdataPlatform): GivenSocialUrl[] {
  return (criteria.urls ?? []).filter((item) => item.platform === platform);
}
