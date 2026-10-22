/**
 * Apify as an optional, paid discovery provider: the Actors AgentSDR knows
 * how to run, what each is for, and the default limits. Pure and
 * client-safe; the token and the organization's choices live in
 * apify_settings (settings.server.ts), every run in apify_runs
 * (runs.server.ts). Off unless the organization turns on the "Apify
 * discovery" feature, saves a token and approves at least one Actor.
 *
 * Only Actors listed here can ever run, and only the ones the owner approved
 * on the settings card. AgentSDR never tops up, upgrades or raises any Apify
 * limit: it reads the account's allowance (GET /v2/users/me/limits) and
 * stops using Apify when it, or the owner's own monthly budget here, is
 * spent — discovery then continues with Google Maps, LinkedIn or website
 * search as before.
 */

export type ApifyActorKey = "google_maps" | "instagram_hashtags" | "instagram_profiles" | "instagram_search" | "facebook_pages" | "linkedin_companies";

export type ApifyActorInfo = {
  key: ApifyActorKey;
  /** The Apify Actor, as the API names it (username~actor-name). */
  actorId: string;
  label: string;
  /** What it is used for, in one sentence. */
  purpose: string;
  /** What it cannot do, said to the owner whenever it is used. */
  limitation: string;
  storeUrl: string;
};

export const APIFY_ACTORS: Record<ApifyActorKey, ApifyActorInfo> = {
  google_maps: {
    key: "google_maps",
    actorId: "compass~crawler-google-places",
    label: "Google Maps Scraper (compass/crawler-google-places)",
    purpose: "Local businesses of a kind in a place, with their listed phone and website, for the assistant's lead search.",
    limitation: "Lists businesses with a public Google Maps listing only; emails come from reading each business's own website, not from Apify's paid contact add-on.",
    storeUrl: "https://apify.com/compass/crawler-google-places",
  },
  instagram_hashtags: {
    key: "instagram_hashtags",
    actorId: "apify~instagram-hashtag-scraper",
    label: "Instagram Hashtag Scraper (apify/instagram-hashtag-scraper)",
    purpose: "Public Instagram posts under hashtags made from the customer type and place, to find accounts that post about them.",
    limitation: "Hashtags do not filter by place: a post that does not name the place is kept with its location unknown. Instagram DMs require a connected Instagram sender and an approved outreach plan; delivery remains subject to recipient restrictions.",
    storeUrl: "https://apify.com/apify/instagram-hashtag-scraper",
  },
  instagram_profiles: {
    key: "instagram_profiles",
    actorId: "apify~instagram-profile-scraper",
    label: "Instagram Profile Scraper (apify/instagram-profile-scraper)",
    purpose: "The public profiles of the accounts the hashtag search found: their bio, category and the website or contact details they publish.",
    limitation: "Only what a profile publishes; a profile with no website, email or phone stays without a contact route.",
    storeUrl: "https://apify.com/apify/instagram-profile-scraper",
  },
  instagram_search: {
    key: "instagram_search",
    actorId: "apify~instagram-search-scraper",
    label: "Instagram Search Scraper (apify/instagram-search-scraper)",
    purpose: "Instagram accounts found by Instagram's own search for the customer type and place (not only hashtags); their profiles are then read with the Profile Scraper.",
    limitation: "Instagram's search ranks accounts by name and popularity, not by location: an account that does not name the place keeps its location unknown. Instagram DMs require a connected Instagram sender and an approved outreach plan; delivery remains subject to recipient restrictions.",
    storeUrl: "https://apify.com/apify/instagram-search-scraper",
  },
  facebook_pages: {
    key: "facebook_pages",
    actorId: "apify~facebook-search-scraper",
    label: "Facebook Search Scraper (apify/facebook-search-scraper)",
    purpose: "Facebook business pages found by keyword and place, with the phone, email, website and address each page publishes.",
    limitation: "Only what a page publishes publicly; AgentSDR cannot message anyone on Facebook, so a page is contacted by its email or phone only.",
    storeUrl: "https://apify.com/apify/facebook-search-scraper",
  },
  linkedin_companies: {
    key: "linkedin_companies",
    actorId: "harvestapi~linkedin-company-search",
    label: "LinkedIn Company Search (harvestapi/linkedin-company-search, no login)",
    purpose: "Companies found by LinkedIn's company search for a keyword and place, with their website; the contacts come from reading each company's own website.",
    limitation: "LinkedIn shows no emails or phones: only companies with a website that publishes contacts can be reached. A third-party Actor that reads LinkedIn without logging in; LinkedIn's User Agreement does not allow scraping, so approve it only if you accept that.",
    storeUrl: "https://apify.com/harvestapi/linkedin-company-search",
  },
};

export const APIFY_ACTOR_KEYS = Object.keys(APIFY_ACTORS) as ApifyActorKey[];

export function isApifyActorKey(value: unknown): value is ApifyActorKey {
  return typeof value === "string" && (APIFY_ACTOR_KEYS as string[]).includes(value);
}

/** Bounds an owner can set, and the defaults a new organization starts with. */
export const APIFY_LIMITS = {
  monthlyBudgetUsd: { default: 10, min: 0, max: 1_000 },
  maxChargePerRunUsd: { default: 2, min: 0.1, max: 50 },
  maxResultsPerRun: { default: 100, min: 5, max: 500 },
  /** Runs one organization may have open at once. */
  openRuns: 2,
  /** How long one run may take before AgentSDR stops waiting and reads what it has. */
  runTimeoutSeconds: 600,
  memoryMbytes: 1024,
} as const;

/** What the settings card shows and saves (never the token itself). */
export type ApifySettingsView = {
  /** On the Included service: the platform's token; the budget is the workspace's included allowance. */
  included?: boolean;
  connected: boolean;
  tokenHint: string | null;
  approvedActors: ApifyActorKey[];
  monthlyBudgetUsd: number;
  maxChargePerRunUsd: number;
  maxResultsPerRun: number;
  /** Spent this calendar month (UTC) on finished runs, plus what open runs may still spend. */
  spentThisMonthUsd: number;
  reservedUsd: number;
};
