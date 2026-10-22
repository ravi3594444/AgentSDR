/**
 * Bright Data as an optional, metered research provider: the Scraper API
 * datasets AgentSDR knows how to use, what each needs and returns, and the
 * limits an owner sets. Pure and client-safe; the key and the owner's limits
 * live in brightdata_settings, every collection in provider_usage
 * (brightdata.server.ts). Off unless the organization turns on the "Bright
 * Data research" feature and saves a key.
 *
 * Dataset ids, inputs and output fields were checked against Bright Data's
 * scraper list (GET /datasets/v3/scrapers) and live records on 2026-10-21.
 * Only Reddit Posts discovers by keyword; every other dataset here needs a
 * URL, which a web search (or Bright Data's SERP API) supplies. A dataset
 * being listed here does not make it operational: the settings card shows,
 * per dataset, only what this organization's own collections returned.
 *
 * AgentSDR never tops up, upgrades or changes a Bright Data plan. Bright
 * Data's API does not report remaining credits, so usage is estimated from
 * the records each collection delivered (1 credit per record; failed inputs
 * count, as Bright Data bills them) against the owner's monthly limit here.
 */

export type BrightdataPlatform = "reddit" | "x" | "instagram" | "facebook";

export const BRIGHTDATA_PLATFORMS: readonly BrightdataPlatform[] = ["reddit", "x", "instagram", "facebook"];

export function isBrightdataPlatform(value: unknown): value is BrightdataPlatform {
  return typeof value === "string" && (BRIGHTDATA_PLATFORMS as readonly string[]).includes(value);
}

export const PLATFORM_NAMES: Record<BrightdataPlatform, string> = { reddit: "Reddit", x: "X", instagram: "Instagram", facebook: "Facebook" };

export type BrightdataDatasetKey =
  | "reddit_posts"
  | "reddit_profiles"
  | "x_posts"
  | "x_profiles"
  | "instagram_posts"
  | "instagram_profiles"
  | "facebook_pages"
  | "facebook_posts";

export type BrightdataDataset = {
  key: BrightdataDatasetKey;
  datasetId: string;
  platform: BrightdataPlatform;
  label: string;
  /** What a record is. */
  record: "post" | "profile" | "page";
  /** Discovery methods it supports (type=discover_new&discover_by=…), beyond collecting by URL. */
  discoverBy: readonly ("keyword" | "subreddit_url")[];
};

export const BRIGHTDATA_DATASETS: Record<BrightdataDatasetKey, BrightdataDataset> = {
  reddit_posts: { key: "reddit_posts", datasetId: "gd_lvz8ah06191smkebj4", platform: "reddit", label: "Reddit posts (with their comments)", record: "post", discoverBy: ["keyword", "subreddit_url"] },
  reddit_profiles: { key: "reddit_profiles", datasetId: "gd_mgnh0p8w16o65lmhp", platform: "reddit", label: "Reddit profiles", record: "profile", discoverBy: [] },
  x_posts: { key: "x_posts", datasetId: "gd_lwxkxvnf1cynvib9co", platform: "x", label: "X posts", record: "post", discoverBy: [] },
  x_profiles: { key: "x_profiles", datasetId: "gd_lwxmeb2u1cniijd7t4", platform: "x", label: "X profiles", record: "profile", discoverBy: [] },
  instagram_posts: { key: "instagram_posts", datasetId: "gd_lk5ns7kz21pck8jpis", platform: "instagram", label: "Instagram posts", record: "post", discoverBy: [] },
  instagram_profiles: { key: "instagram_profiles", datasetId: "gd_l1vikfch901nx3by4", platform: "instagram", label: "Instagram profiles", record: "profile", discoverBy: [] },
  facebook_pages: { key: "facebook_pages", datasetId: "gd_mf124a0511bauquyow", platform: "facebook", label: "Facebook pages", record: "page", discoverBy: [] },
  facebook_posts: { key: "facebook_posts", datasetId: "gd_lyclm1571iy3mv57zw", platform: "facebook", label: "Facebook posts", record: "post", discoverBy: [] },
};

export const BRIGHTDATA_DATASET_KEYS = Object.keys(BRIGHTDATA_DATASETS) as BrightdataDatasetKey[];

export function isBrightdataDatasetKey(value: unknown): value is BrightdataDatasetKey {
  return typeof value === "string" && (BRIGHTDATA_DATASET_KEYS as string[]).includes(value);
}

/** What each platform can and cannot do here, said to the owner and the model wherever it is used. */
export const PLATFORM_LIMITATIONS: Record<BrightdataPlatform, string> = {
  reddit:
    "Searched by keyword (and subreddit) directly. Each post comes with the comments Bright Data returns, not always every comment. AgentSDR cannot message anyone on Reddit: a poster becomes a lead only when their own Reddit profile links a website or Instagram account that gives a contact route.",
  x:
    "Bright Data has no keyword search for X: posts are found by a web search (or Bright Data's SERP API) and then read. AgentSDR cannot message anyone on X: an author becomes a lead only through the website or email their own profile publishes.",
  instagram:
    "Profiles and posts are found by a web search and then read. A profile's published email, its website and its username (for an Instagram DM through a connected Instagram sender after the plan is approved) are its contact routes.",
  facebook:
    "Pages and posts are found by a web search and then read. AgentSDR cannot message anyone on Facebook: a page is contacted by the email, phone or website it publishes.",
};

/** One credit per delivered record; the list price beyond the free allowance, used to count requests' spend. */
export const BRIGHTDATA_USD_PER_CREDIT = 0.0015;
/** Bright Data's free tier: credits shared across its Web Unlocker, SERP, Scraper API and Scraper Studio, reset monthly. */
export const BRIGHTDATA_FREE_MONTHLY_CREDITS = 5_000;

/** Bounds an owner can set, the defaults a new organization starts with, and fixed limits. */
export const BRIGHTDATA_LIMITS = {
  /** Credits AgentSDR may use in a calendar month (UTC); 0 stops it. */
  monthlyCredits: { default: 1_000, min: 0, max: 100_000 },
  /** The most records one research job may collect, across its sources and profile reads. */
  maxRecordsPerSearch: { default: 60, min: 5, max: 300 },
  /** Collections one organization may have open at once. */
  openCollections: 3,
  /** Times one collection is sent after Bright Data refused it outright (a rate limit); a lost answer is never sent again. */
  triggerRetries: 3,
  /** How long AgentSDR waits for a collection before it stops waiting and keeps what it has. */
  collectionTimeoutMinutes: 45,
  /** A settled collection with the same inputs is downloaded again (free) rather than paid for, within this many days (Bright Data keeps snapshots 30). */
  reuseDays: 7,
} as const;

/** What the settings card shows and saves (never the key itself). */
export type BrightdataSettingsView = {
  connected: boolean;
  keyHint: string | null;
  monthlyCredits: number;
  maxRecordsPerSearch: number;
  /** The SERP API zone the owner created in Bright Data's control panel, for finding X, Instagram and Facebook URLs when no web search is set up. */
  serpZone: string | null;
  /** Reddit research is off until the owner turns it on (Reddit's terms restrict automated collection). */
  redditEnabled: boolean;
  /** Credits used this month by finished collections, and held by open ones: an estimate from delivered records. */
  usedThisMonth: number;
  reservedThisMonth: number;
  /** Per dataset, what this organization's own collections showed: never "works" because it is listed. */
  datasets: { key: BrightdataDatasetKey; label: string; state: "verified" | "failed" | "unused"; at: string | null; detail: string | null }[];
};

/** "1,234 of 5,000 credits used this month (estimated)". */
export function creditsLine(used: number, reserved: number, monthly: number): string {
  const total = used + reserved;
  return `${total.toLocaleString("en-US")} of ${monthly.toLocaleString("en-US")} credits used this month${reserved ? ` (${reserved.toLocaleString("en-US")} held by collections still open)` : ""} — estimated from the records Bright Data delivered`;
}
