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

export type ApifyActorKey = "google_maps" | "instagram_hashtags" | "instagram_profiles";

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
    limitation: "Hashtags do not filter by place: a post that does not name the place is kept with its location unknown. Finding someone on Instagram does not give a way to contact them — AgentSDR cannot start Instagram chats.",
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
