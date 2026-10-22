/**
 * Organization feature defaults and saved choices. Research agent v2 is on
 * by default; owners and admins can turn it off in Providers & features.
 * Other optional features start off. Saved choices override these defaults.
 * Pure and client-safe; overrides live in organization_features.
 */

export const FEATURE_KEYS = ["instagram", "web_discovery", "inquiry_intake", "apify_discovery", "treg", "brightdata", "research_agent_v2"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type FeatureInfo = {
  label: string;
  description: string;
  /** What it needs before it can do anything, in a sentence. */
  requires: string;
};

export const FEATURES: Record<FeatureKey, FeatureInfo> = {
  instagram: {
    label: "Instagram messages",
    description:
      "Link Instagram accounts through Unipile, send one initial DM per lead in an approved outreach plan, and handle replies in the inbox under the run's reply mode.",
    requires: "Unipile connected, and an Instagram account linked in it.",
  },
  web_discovery: {
    label: "Website and directory search",
    description:
      "When you ask the assistant to find customers, it can also search the web for businesses and directories that match your customer description, then read their published contact details.",
    requires: "A web search: a Tavily key (set on this page once the feature is on), or an AI provider that searches the web (OpenRouter, or AI/ML API with a web research model).",
  },
  inquiry_intake: {
    label: "Inquiry intake",
    description:
      "Receive inquiries from your website forms (through an authenticated webhook you add to your form tool) and, with Instagram on, new Instagram messages from people you have not talked to before.",
    requires: "A one-time setup in your form tool; see the setup steps on the Inquiries page.",
  },
  apify_discovery: {
    label: "Apify discovery (paid)",
    description:
      "Lead searches can use Apify Actors you approve — Google Maps listings, Instagram hashtags and profiles — within a monthly budget you set. When Apify is not set up, over budget or out of credit, searches continue with Google Maps, LinkedIn or website search as before. AgentSDR never tops up or upgrades your Apify account.",
    requires: "An Apify account and API token, at least one approved Actor, and a monthly budget (set on this page once the feature is on).",
  },
  treg: {
    label: "Treg tools (beta, paid)",
    description:
      "The assistant can use Treg's catalog of paid data tools with your Treg key — find and verify work emails, enrich people and companies, Google Maps and web search, public social profiles — within a daily spend cap you set. Each call is billed by Treg to your prepaid Treg balance; AgentSDR never tops it up.",
    requires: "A Treg account (treg.to) and its API key, and a daily spend cap (set on this page once the feature is on).",
  },
  brightdata: {
    label: "Bright Data research (metered)",
    description:
      "The assistant can research social sources through Bright Data with your key: Reddit discussions found by keyword (once you turn Reddit on), and X, Instagram and Facebook posts, profiles and pages a web search finds. Each finding keeps its link, the words quoted and when it was read; someone becomes a lead only when their own profile, page or website publishes a contact route. Usage is counted against a monthly credit limit you set; AgentSDR never tops up or upgrades your Bright Data account, and never messages anyone on Reddit, X or Facebook.",
    requires: "A Bright Data account and API key, and a monthly credit limit (set on this page once the feature is on). X, Instagram and Facebook also need a web search, or a SERP API zone in Bright Data.",
  },
  research_agent_v2: {
    label: "Research agent v2 (beta)",
    description:
      "The assistant plans a lead request itself: it writes down what you asked (how many, where, which channels, budget, time), chooses the sources, reviews each lead's evidence, and decides when the request is done. Outreach still waits for your Start (or runs within Autonomous mode's daily caps); spend caps, Do Not Contact and sending limits are enforced as before.",
    requires: "An AI provider. A strong model (for example Claude Sonnet) works best.",
  },
};

export function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === "string" && (FEATURE_KEYS as readonly string[]).includes(value);
}

export type FeatureState = Record<FeatureKey, boolean>;

/** Existing and new organizations use v2 unless they have saved an override. */
export function defaultFeatureState(): FeatureState {
  return {
    ...Object.fromEntries(FEATURE_KEYS.map((key) => [key, false])),
    research_agent_v2: true,
  } as FeatureState;
}

/** Stored On and Off choices both win; unknown feature keys are ignored. */
export function featureStateFromRows(rows: readonly { key: string; enabled: boolean }[]): FeatureState {
  const state = defaultFeatureState();
  for (const row of rows) if (isFeatureKey(row.key)) state[row.key] = row.enabled;
  return state;
}
