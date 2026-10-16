import "server-only";

import { AIML_PROVIDER_KEY, AIML_PROVIDER_NAME } from "@/lib/ai/aimlapi-types";
import { getByokSettings } from "@/lib/ai/byok";
import { getAiConnection, type AiConnection } from "@/lib/ai/connections";
import { openRouterTokenLimit, type ByokSettings } from "@/lib/ai/openrouter-types";
import { planAiRuntime } from "@/lib/ai/runtimePlan";
import { isTransientOpenRouterError } from "@/lib/ai/server/openrouter-errors";
import { getAiRuntime } from "@/lib/ai/server/runtime";
import { responseCostUsd } from "@/lib/assistant/usage.server";
import { researchSources } from "@/lib/research/research";
import { askWithSearch, researchRuntime, type SearchCompletionsClient } from "@/lib/research/research.server";
import type { ResearchSource } from "@/lib/research/schema";

/**
 * One web search for website and directory discovery, through the
 * organization's own AI provider when it can search the web:
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

export type WebSearchProvider = "openrouter" | typeof AIML_PROVIDER_KEY;

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

const NO_PROVIDER = "Website and directory search needs an AI provider that searches the web: connect OpenRouter, or AI/ML API with a web research model, in Settings → AI provider.";

/**
 * Whether the organization's AI settings can run a web search, and with
 * what. Pure, so the assistant's setup snapshot can reuse settings it already
 * read. OpenRouter must pass the same gate as every model call
 * (runtimePlan.ts); AI/ML API needs its research model, because only its
 * search models (e.g. Perplexity Sonar) return sources.
 */
export function webSearchAvailabilityFrom(settings: ByokSettings, connection: Pick<AiConnection, "providerKey" | "verified"> | null): WebSearchAvailability {
  const unavailable = (reason: string): WebSearchAvailability => ({ available: false, provider: null, model: null, reason });
  if (!settings.connectionId || !connection) return unavailable(NO_PROVIDER);
  if (!connection.verified) return unavailable(`The AI connection in Settings → AI provider is not verified. ${NO_PROVIDER}`);
  if (connection.providerKey === "openrouter") {
    const planned = planAiRuntime(settings, connection);
    if (!planned.ok) return unavailable(`OpenRouter cannot search yet: ${planned.error}.`);
    return { available: true, provider: "openrouter", model: planned.plan.selection.modelId, reason: null };
  }
  if (connection.providerKey === AIML_PROVIDER_KEY) {
    if (!settings.researchModel) {
      return unavailable(`${AIML_PROVIDER_NAME} searches the web only with a web research model: choose one in Settings → AI provider (step 4), e.g. Perplexity Sonar.`);
    }
    return { available: true, provider: AIML_PROVIDER_KEY, model: settings.researchModel.modelId, reason: null };
  }
  return unavailable(NO_PROVIDER);
}

/** webSearchAvailabilityFrom for the organization in scope. */
export async function webSearchAvailability(): Promise<WebSearchAvailability> {
  const settings = await getByokSettings();
  const connection = settings.connectionId ? await getAiConnection(settings.connectionId) : null;
  return webSearchAvailabilityFrom(settings, connection);
}

/** What searchWeb needs from the provider; tests substitute a stand-in client. */
export type WebSearchRuntime = {
  provider: WebSearchProvider;
  model: string;
  client: SearchCompletionsClient;
  /** OpenRouter's strict provider routing; nothing for AI/ML API. */
  routing: Record<string, unknown>;
};

async function loadRuntime(): Promise<WebSearchRuntime> {
  const availability = await webSearchAvailability();
  if (!availability.available) throw new WebSearchUnavailableError(availability.reason ?? NO_PROVIDER);
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
 * has no web-searching provider, and the provider's error when the call
 * fails after its one retry.
 */
export async function searchWeb(
  query: string,
  dependencies: { runtime?: () => Promise<WebSearchRuntime>; sleep?: (ms: number) => Promise<void> } = {},
): Promise<WebSearchResult> {
  const question = query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
  if (!question) throw new Error("Nothing to search for.");
  const runtime = await (dependencies.runtime ?? loadRuntime)();
  let response: unknown;
  if (runtime.provider === AIML_PROVIDER_KEY) {
    response = await askWithSearch(runtime.client, runtime.model, question, { systemPrompt: WEB_SEARCH_SYSTEM_PROMPT, maxTokens: MAX_OUTPUT_TOKENS });
  } else {
    const request = openRouterSearchRequest(runtime.model, runtime.routing, question);
    const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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
