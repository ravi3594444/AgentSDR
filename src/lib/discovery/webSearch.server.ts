import "server-only";

import { AIML_PROVIDER_KEY, AIML_PROVIDER_NAME } from "@/lib/ai/aimlapi-types";
import { getByokSettings, isManagedAiConnectionId } from "@/lib/ai/byok";
import { getAiConnection, type AiConnection } from "@/lib/ai/connections";
import { openRouterTokenLimit, type ByokSettings } from "@/lib/ai/openrouter-types";
import { planAiRuntime } from "@/lib/ai/runtimePlan";
import { isTransientOpenRouterError } from "@/lib/ai/server/openrouter-errors";
import { getAiRuntime } from "@/lib/ai/server/runtime";
import { responseCostUsd } from "@/lib/assistant/usage.server";
import { researchSources } from "@/lib/research/research";
import { askWithSearch, researchRuntime, type SearchCompletionsClient } from "@/lib/research/research.server";
import type { ResearchSource } from "@/lib/research/schema";
import { TAVILY_LIMITS, tavilySources } from "@/lib/tavily/catalog";
import { tavilyConnection } from "@/lib/tavily/tavily.server";
import { tavilySearch, TavilyError } from "@/services/tavily";
import { searchWithTinyfish, tinyfishConnection } from "@/lib/tinyfish/tinyfish.server";
import { tavilyCapProblem } from "@/lib/tavily/catalog";
import { tavilySearchesToday } from "@/lib/tavily/tavily.server";
import { reserveQuota, settleQuota } from "@/lib/quota/quota.server";

/**
 * One web search for website and directory discovery:
 *
 * - TinyFish, whenever the organization saved a TinyFish key and keeps "Use
 *   TinyFish for web searches" on (Settings → Lead research → TinyFish): a
 *   search engine with a free daily allowance (lib/tinyfish/), given
 *   keywords plus the sentence as its purpose;
 * - Tavily, whenever the organization saved a Tavily key (Settings →
 *   Organization → Tavily): a search API returning real result pages, so
 *   it is preferred over a model's web search;
 *
 * otherwise through the organization's own AI provider when it can search
 * the web:
 *
 * - OpenRouter: the selected default model with OpenRouter's `web` plugin
 *   (Exa for Google models, as the table runner does — see webPlugins in
 *   src/lib/ai/server/openrouter-runner.ts), sources returned as
 *   `url_citation` annotations;
 * - AI/ML API: only when a web research model is chosen (Settings → AI
 *   provider), with the same runtime and request as company research
 *   (research.server.ts askWithSearch: `web_search_options`), sources
 *   returned as `citations` / `search_results`.
 *
 * An ordinary language model is not a search engine: only the URLs the
 * provider returned as sources are kept (researchSources); a URL written in
 * the model's answer text is never used. Bounded: a 60 s deadline, a short
 * answer, at most one retry and only for a rate limit or server error (never
 * after a timeout, which the provider may have billed). The cost the
 * provider reports is returned to the caller, which keeps it with the job.
 */

export type WebSearchProvider = "openrouter" | typeof AIML_PROVIDER_KEY | "tavily" | "tinyfish";

/** Tavily's searches, as a model name in reports. */
export const TAVILY_SEARCH_MODEL = "tavily-search-basic";
/** TinyFish's searches, as a model name in reports. */
export const TINYFISH_SEARCH_MODEL = "tinyfish-search";

/** The provider's name for the owner: never "AI/ML API" for a Tavily or TinyFish search. */
export function webSearchProviderName(provider: string | null | undefined): string {
  switch (provider) {
    case "tinyfish": return "TinyFish Search";
    case "tavily": return "Tavily";
    case "openrouter": return "OpenRouter web search";
    case AIML_PROVIDER_KEY: return `${AIML_PROVIDER_NAME} web research`;
    default: return "web search";
  }
}

export type WebSearchAvailability = {
  available: boolean;
  provider: WebSearchProvider | null;
  model: string | null;
  reason: string | null;
};

export type WebSearchResult = {
  query: string;
  /** Pages the provider's search returned, in its order; never a URL from the answer text. */
  sources: ResearchSource[];
  costUsd: number | null;
  provider: WebSearchProvider;
  model: string;
};

export class WebSearchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchUnavailableError";
  }
}

const WEB_SEARCH_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 400;
const MAX_QUERY_LENGTH = 400;
/** Results OpenRouter's web plugin fetches per search (its default is 5). */
const OPENROUTER_MAX_RESULTS = 10;
const RETRY_DELAY_MS = 2_000;

export const WEB_SEARCH_SYSTEM_PROMPT = [
  "You find businesses on the public web for a small business's sales team, using web search.",
  "Search the web for the request and name the pages you found, one per line, with what each is. Use only the search results, never memory.",
  "Prefer each business's own website, local directories or lists of such businesses, and public Instagram profiles or posts only when the request asks for them.",
  "Do not write email addresses, phone numbers or personal details, and do not describe private individuals.",
].join("\n");

const NO_PROVIDER = "Website and directory search needs a web search: save a TinyFish key in Settings → Lead research → TinyFish (free searches), a Tavily key in Settings → Providers & features → Tavily, or connect an AI provider that searches the web (OpenRouter, or AI/ML API with a web research model) in Settings → AI provider.";

/**
 * Whether the organization's AI settings can run a web search, and with
 * what. Pure, so the assistant's setup snapshot can reuse settings it already
 * read. OpenRouter must pass the same gate as every model call
 * (runtimePlan.ts); AI/ML API needs its research model, because only its
 * search models (e.g. Perplexity Sonar) return sources.
 */
export function webSearchAvailabilityFrom(
  settings: ByokSettings,
  connection: Pick<AiConnection, "providerKey" | "verified"> | null,
  tavily: { connected: boolean } | null = null,
  tinyfish: { connected: boolean; useForWebSearch: boolean } | null = null,
): WebSearchAvailability {
  const unavailable = (reason: string): WebSearchAvailability => ({ available: false, provider: null, model: null, reason });
  if (tinyfish?.connected && tinyfish.useForWebSearch) return { available: true, provider: "tinyfish", model: TINYFISH_SEARCH_MODEL, reason: null };
  if (tavily?.connected) return { available: true, provider: "tavily", model: TAVILY_SEARCH_MODEL, reason: null };
  if (!settings.connectionId || !connection) return unavailable(NO_PROVIDER);
  // The Included AI engine searches like the same engine would, but its model is the platform's configuration: not named.
  const included = isManagedAiConnectionId(settings.connectionId);
  if (!connection.verified) return unavailable(included ? NO_PROVIDER : `The AI connection in Settings → AI provider is not verified. ${NO_PROVIDER}`);
  if (connection.providerKey === "openrouter") {
    const planned = planAiRuntime(settings, connection);
    if (!planned.ok) return unavailable(included ? NO_PROVIDER : `OpenRouter cannot search yet: ${planned.error}.`);
    return { available: true, provider: "openrouter", model: included ? "included AI" : planned.plan.selection.modelId, reason: null };
  }
  if (connection.providerKey === AIML_PROVIDER_KEY) {
    if (!settings.researchModel) {
      return unavailable(included ? NO_PROVIDER : `${AIML_PROVIDER_NAME} searches the web only with a web research model: choose one in Settings → AI provider (step 4), e.g. Perplexity Sonar.`);
    }
    return { available: true, provider: AIML_PROVIDER_KEY, model: included ? "included AI" : settings.researchModel.modelId, reason: null };
  }
  return unavailable(NO_PROVIDER);
}

/** webSearchAvailabilityFrom for the organization in scope. */
export async function webSearchAvailability(): Promise<WebSearchAvailability> {
  const settings = await getByokSettings();
  const connection = settings.connectionId ? await getAiConnection(settings.connectionId) : null;
  const tinyfish = await tinyfishConnection();
  return webSearchAvailabilityFrom(settings, connection, { connected: Boolean(await tavilyConnection()) }, tinyfish ? { connected: true, useForWebSearch: tinyfish.useForWebSearch } : null);
}

/** What searchWeb needs from the provider; tests substitute a stand-in client. */
export type WebSearchRuntime =
  | {
      provider: "openrouter" | typeof AIML_PROVIDER_KEY;
      model: string;
      client: SearchCompletionsClient;
      /** OpenRouter's strict provider routing; nothing for AI/ML API. */
      routing: Record<string, unknown>;
    }
  | { provider: "tavily"; model: string; key: string; source?: "managed" | "own" }
  | { provider: "tinyfish"; model: string };

/** The runtime of the provider a search must use: the one its website search started with, when given. */
async function loadRuntime(expected?: WebSearchProvider | null): Promise<WebSearchRuntime> {
  const availability = await webSearchAvailability();
  if (!availability.available) throw new WebSearchUnavailableError(availability.reason ?? NO_PROVIDER);
  if (expected && availability.provider !== expected) {
    // Never switch providers inside one search: its limits were checked against the one it started with.
    throw new WebSearchUnavailableError(`The web search provider changed since this website search started (${expected} → ${availability.provider}); ask again to search with the new one.`);
  }
  if (availability.provider === "tinyfish") return { provider: "tinyfish", model: TINYFISH_SEARCH_MODEL };
  if (availability.provider === "tavily") {
    const tavily = await tavilyConnection();
    if (!tavily) throw new WebSearchUnavailableError(NO_PROVIDER);
    return { provider: "tavily", model: TAVILY_SEARCH_MODEL, key: tavily.key, source: tavily.source };
  }
  if (availability.provider === "openrouter") {
    const runtime = await getAiRuntime(undefined, WEB_SEARCH_TIMEOUT_MS);
    return { provider: "openrouter", model: runtime.selection.modelId, client: runtime.client, routing: runtime.routing };
  }
  const runtime = await researchRuntime(WEB_SEARCH_TIMEOUT_MS);
  return { provider: AIML_PROVIDER_KEY, model: runtime.model, client: runtime.client, routing: {} };
}

/** OpenRouter's chat request with its web plugin; Exa for Google models (their own grounding may not search). */
export function openRouterSearchRequest(model: string, routing: Record<string, unknown>, query: string): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: "system", content: WEB_SEARCH_SYSTEM_PROMPT },
      { role: "user", content: query },
    ],
    ...openRouterTokenLimit(model, MAX_OUTPUT_TOKENS),
    ...routing,
    plugins: [model.startsWith("google/")
      ? { id: "web", engine: "exa", max_results: OPENROUTER_MAX_RESULTS }
      : { id: "web", max_results: OPENROUTER_MAX_RESULTS }],
  };
}

/**
 * Runs one search. Throws WebSearchUnavailableError when the organization
 * has no web-searching provider, TinyfishWaitError while TinyFish's free
 * allowance asks to wait (nothing was called or charged), and the provider's
 * error when the call fails after its one retry.
 */
export async function searchWeb(
  query: string,
  dependencies: {
    runtime?: () => Promise<WebSearchRuntime>;
    sleep?: (ms: number) => Promise<void>;
    provider?: WebSearchProvider | null;
    /** The same search as keywords, for a search engine; the sentence goes along as its purpose. */
    keywords?: string | null;
    jobId?: string | null;
  } = {},
): Promise<WebSearchResult> {
  const question = query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
  if (!question) throw new Error("Nothing to search for.");
  const runtime = await (dependencies.runtime ?? (() => loadRuntime(dependencies.provider)))();
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (runtime.provider === "tinyfish") {
    const keywords = dependencies.keywords?.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH) || question;
    const hits = await searchWithTinyfish({ query: keywords, purpose: keywords === question ? null : question }, { jobId: dependencies.jobId ?? null });
    // Free within the allowance, and never past it.
    return { query: keywords, sources: hits.map(({ url, title, snippet }) => ({ url, title, snippet })), costUsd: 0, provider: "tinyfish", model: runtime.model };
  }
  if (runtime.provider === "tavily") {
    // On the platform's key (an Included service) every search is reserved against the
    // workspace's allowance first; the website-search job already counted it in the daily cap,
    // so it is recorded under its own product ("website_search") that the cap does not read.
    const reservation = runtime.source === "managed"
      ? await reserveQuota({ provider: "tavily", product: "website_search", scopeKey: null, units: 1, limits: {}, label: "Tavily", jobId: dependencies.jobId ?? null, detail: { query: question.slice(0, 200) }, credentialSource: "managed", managed: { allowance: "tavily_search", amount: 1 } })
      : null;
    if (reservation && !reservation.ok) throw new WebSearchUnavailableError(reservation.reason);
    let body: unknown;
    try {
      try {
        body = await tavilySearch(runtime.key, question, TAVILY_LIMITS.resultsPerSearch);
      } catch (error) {
        // One retry, only when Tavily said it is busy (a rate limit is not billed).
        if (!(error instanceof TavilyError && error.status === 429)) throw error;
        await sleep(RETRY_DELAY_MS);
        body = await tavilySearch(runtime.key, question, TAVILY_LIMITS.resultsPerSearch);
      }
    } catch (error) {
      if (reservation?.ok) await settleQuota(reservation.usageId, { status: error instanceof TavilyError && error.status !== null ? "failed" : "uncertain", usedUnits: 1, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    if (reservation?.ok) await settleQuota(reservation.usageId, { status: "settled", usedUnits: 1 });
    // The price depends on the Tavily plan (free credits first), so it is not guessed here.
    return { query: question, sources: tavilySources(body), costUsd: null, provider: "tavily", model: runtime.model };
  }
  let response: unknown;
  if (runtime.provider === AIML_PROVIDER_KEY) {
    response = await askWithSearch(runtime.client, runtime.model, question, { systemPrompt: WEB_SEARCH_SYSTEM_PROMPT, maxTokens: MAX_OUTPUT_TOKENS });
  } else {
    const request = openRouterSearchRequest(runtime.model, runtime.routing, question);
    try {
      response = await runtime.client.chat.completions.create(request as never);
    } catch (error) {
      if (!isTransientOpenRouterError(error)) throw error;
      await sleep(RETRY_DELAY_MS);
      response = await runtime.client.chat.completions.create(request as never);
    }
  }
  return { query: question, sources: researchSources(response), costUsd: responseCostUsd(response), provider: runtime.provider, model: runtime.model };
}

// ── The assistant's general web search (the web_search tool) ────────────────

export type GeneralSearchRoute =
  | { provider: "tinyfish" }
  | { provider: "tavily"; key: string; dailySearches: number; source: "managed" | "own" }
  | { provider: null; reason: string };

/**
 * Which provider the assistant's own web search uses: TinyFish (free within
 * its allowance) while connected and on for web search; otherwise Tavily
 * when the organization saved a key for it (paid credits, within the owner's
 * daily cap); never an AI model's search, which costs per call. A saved key
 * alone does not choose what to search for: the assistant does.
 */
export async function generalSearchRoute(): Promise<GeneralSearchRoute> {
  const tinyfish = await tinyfishConnection();
  if (tinyfish?.useForWebSearch) return { provider: "tinyfish" };
  const tavily = await tavilyConnection();
  if (tavily) return { provider: "tavily", key: tavily.key, dailySearches: tavily.dailySearches, source: tavily.source };
  return {
    provider: null,
    reason: tinyfish
      ? "TinyFish is connected but turned off for web searches (Settings → Lead research → TinyFish), and no Tavily key is saved"
      : "no web search is connected: an owner or admin saves a TinyFish key in Settings → Lead research → TinyFish (free searches)",
  };
}

export type GeneralSearchInput = { query: string; country?: string | null; page?: number | null; purpose?: string | null };

/** One search for the assistant; throws TinyfishWaitError while TinyFish asks to wait, and a plain Error with the reason otherwise. */
export async function generalWebSearch(input: GeneralSearchInput, context: { threadId?: string | null; requestId?: string | null; freeOnly?: boolean } = {}): Promise<{ provider: "tinyfish" | "tavily"; hits: (ResearchSource & { site?: string | null; date?: string | null })[] }> {
  const route = await generalSearchRoute();
  if (route.provider === null) throw new WebSearchUnavailableError(route.reason);
  // A request limited to free sources ($0 spend cap) never uses Tavily's paid credits.
  if (route.provider === "tavily" && context.freeOnly) {
    throw new WebSearchUnavailableError("this request is limited to free sources (its spend cap is $0); web search here would use Tavily's paid credits, and TinyFish's free search is not connected or is off for web search (Settings → Lead research → TinyFish)");
  }
  const query = input.query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
  if (route.provider === "tinyfish") {
    const hits = await searchWithTinyfish({ query, location: input.country ?? null, page: input.page ?? null, purpose: input.purpose ?? null }, { threadId: context.threadId ?? null, ...(context.requestId ? { detail: { requestId: context.requestId } } : {}) });
    return { provider: "tinyfish", hits };
  }
  const problem = tavilyCapProblem(await tavilySearchesToday(), 1, route.dailySearches);
  if (problem) throw new WebSearchUnavailableError(`Tavily: ${problem}`);
  const reservation = await reserveQuota({
    provider: "tavily", product: "search", scopeKey: null, units: 1, limits: {}, label: "Tavily", threadId: context.threadId ?? null,
    detail: { query: query.slice(0, 200), ...(context.requestId ? { requestId: context.requestId } : {}) },
    credentialSource: route.source,
    ...(route.source === "managed" ? { managed: { allowance: "tavily_search" as const, amount: 1 } } : {}),
  });
  if (!reservation.ok) throw new WebSearchUnavailableError(reservation.reason);
  try {
    const body = await tavilySearch(route.key, query, 10);
    const hits = tavilySources(body, 10);
    await settleQuota(reservation.usageId, { status: "settled", usedUnits: 1, detail: { results: hits.length } });
    return { provider: "tavily", hits };
  } catch (error) {
    await settleQuota(reservation.usageId, { status: error instanceof TavilyError && error.status !== null ? "failed" : "uncertain", usedUnits: 1, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
