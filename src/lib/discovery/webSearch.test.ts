import { describe, expect, test } from "bun:test";
import type { ByokSettings } from "@/lib/ai/openrouter-types";
import { openRouterSearchRequest, searchWeb, webSearchAvailabilityFrom, type WebSearchRuntime } from "./webSearch.server";

// Response shapes as the providers document them (trimmed): OpenRouter's web
// plugin returns url_citation annotations, Perplexity on AI/ML API returns
// citations and search_results. Every answer text below also names a URL the
// provider did not return; it must never become a source.
const openRouterAnswer = {
  id: "gen-1",
  choices: [{
    message: {
      role: "assistant",
      content: "Lotus Dental Care (https://lotus.example.in) and also https://invented-clinic.example.com which I remember.",
      annotations: [
        { type: "url_citation", url_citation: { url: "https://lotus.example.in/", title: "Lotus Dental Care | Baner", content: "Family dental clinic in Baner since 2004.", start_index: 0, end_index: 17 } },
        { type: "url_citation", url_citation: { url: "https://city.example.in/top-10-dentists-in-pune/", title: "Top 10 dentists in Pune", start_index: 20, end_index: 40 } },
        { type: "url_citation", url_citation: { url: "javascript:alert(1)", title: "bad" } },
      ],
    },
  }],
  usage: { prompt_tokens: 900, completion_tokens: 60, cost: 0.0213 },
};
const sonarAnswer = {
  choices: [{ message: { role: "assistant", content: "See https://made-up.example.org for more [1][2]." } }],
  citations: ["https://lotus.example.in/", "https://www.instagram.com/p/C9xYz12AbCd/"],
  search_results: [{ title: "Lotus Dental Care", url: "https://lotus.example.in/", snippet: "Dentist in Baner" }],
  meta: { usage: { usd_spent: 0.0061 } },
};
const memoryOnly = { choices: [{ message: { content: "Try https://lotus.example.in and https://smile.example.in" } }] };

type Sent = Record<string, unknown>;
function standIn(provider: WebSearchRuntime["provider"], answers: (() => unknown)[], sent: Sent[]): () => Promise<WebSearchRuntime> {
  let call = 0;
  return async () => ({
    provider,
    model: provider === "openrouter" ? "openai/gpt-5-mini" : "perplexity/sonar",
    routing: provider === "openrouter" ? { provider: { only: ["openai"], order: ["openai"], allow_fallbacks: false, require_parameters: true } } : {},
    client: {
      chat: {
        completions: {
          create: async (request: never) => {
            sent.push(request as Sent);
            return answers[Math.min(call++, answers.length - 1)]!();
          },
        },
      },
    },
  });
}

const rateLimited = () => {
  throw Object.assign(new Error("429 Rate limit exceeded"), { status: 429 });
};
const badRequest = () => {
  throw Object.assign(new Error("400 Unknown parameter"), { status: 400 });
};
const noSleep = async () => undefined;

describe("searchWeb", () => {
  test("OpenRouter: the web plugin is requested, and only the provider's citations are sources", async () => {
    const sent: Sent[] = [];
    const result = await searchWeb("dental clinics in Baner, Pune", { runtime: standIn("openrouter", [() => openRouterAnswer], sent), sleep: noSleep });
    expect(result.sources).toEqual([
      { url: "https://lotus.example.in/", title: "Lotus Dental Care | Baner", snippet: "Family dental clinic in Baner since 2004." },
      { url: "https://city.example.in/top-10-dentists-in-pune/", title: "Top 10 dentists in Pune", snippet: null },
    ]);
    expect(result.sources.some((source) => source.url.includes("invented-clinic"))).toBe(false);
    expect(result.costUsd).toBe(0.0213);
    expect(result.provider).toBe("openrouter");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.plugins).toEqual([{ id: "web", max_results: 10 }]);
    expect(sent[0]!.provider).toEqual({ only: ["openai"], order: ["openai"], allow_fallbacks: false, require_parameters: true });
    expect((sent[0]!.messages as { role: string; content: string }[])[1]).toEqual({ role: "user", content: "dental clinics in Baner, Pune" });
  });

  test("AI/ML API: the research model's web_search_options request, with citations and search results as sources", async () => {
    const sent: Sent[] = [];
    const result = await searchWeb("dental clinics in Baner", { runtime: standIn("aimlapi", [() => sonarAnswer], sent) });
    expect(result.sources.map((source) => source.url)).toEqual(["https://lotus.example.in/", "https://www.instagram.com/p/C9xYz12AbCd/"]);
    expect(result.sources[0]!.snippet).toBe("Dentist in Baner");
    expect(result.costUsd).toBe(0.0061);
    expect(sent[0]!.web_search_options).toEqual({ search_context_size: "low" });
    expect(sent[0]!.max_tokens).toBe(400);
    expect(sent[0]!.model).toBe("perplexity/sonar");
  });

  test("an answer without provider sources gives no sources, whatever URLs its text names", async () => {
    const result = await searchWeb("dentists", { runtime: standIn("openrouter", [() => memoryOnly], []), sleep: noSleep });
    expect(result.sources).toEqual([]);
    expect(result.costUsd).toBeNull();
  });

  test("one retry after a rate limit, none after a request the provider refuses", async () => {
    const sent: Sent[] = [];
    const retried = await searchWeb("dentists", { runtime: standIn("openrouter", [rateLimited, () => openRouterAnswer], sent), sleep: noSleep });
    expect(sent).toHaveLength(2);
    expect(retried.sources).toHaveLength(2);

    const twice: Sent[] = [];
    await expect(searchWeb("dentists", { runtime: standIn("openrouter", [rateLimited, rateLimited, () => openRouterAnswer], twice), sleep: noSleep })).rejects.toThrow("429");
    expect(twice).toHaveLength(2);

    const refused: Sent[] = [];
    await expect(searchWeb("dentists", { runtime: standIn("openrouter", [badRequest, () => openRouterAnswer], refused), sleep: noSleep })).rejects.toThrow("400");
    expect(refused).toHaveLength(1);
  });

  test("an empty query is not sent", async () => {
    const sent: Sent[] = [];
    await expect(searchWeb("   ", { runtime: standIn("openrouter", [() => openRouterAnswer], sent) })).rejects.toThrow("Nothing to search for");
    expect(sent).toHaveLength(0);
  });
});

describe("openRouterSearchRequest", () => {
  test("Google models search through Exa (their own grounding may answer without searching)", () => {
    expect(openRouterSearchRequest("google/gemini-3.5-flash", {}, "q").plugins).toEqual([{ id: "web", engine: "exa", max_results: 10 }]);
  });
});

describe("webSearchAvailabilityFrom", () => {
  const base: ByokSettings = {
    connectionId: "c1",
    providers: ["openai"],
    modelsByProvider: { openai: ["openai/gpt-5-mini"] },
    defaultModel: { provider: "openai", modelId: "openai/gpt-5-mini" },
    transcriptionModel: null,
    researchModel: null,
    researchDailyLimit: 25,
    byokOnlyConfirmed: true,
  };

  test("OpenRouter searches with the default model once the usual gate passes", () => {
    expect(webSearchAvailabilityFrom(base, { providerKey: "openrouter", verified: true })).toEqual({ available: true, provider: "openrouter", model: "openai/gpt-5-mini", reason: null });
    const unconfirmed = webSearchAvailabilityFrom({ ...base, byokOnlyConfirmed: false }, { providerKey: "openrouter", verified: true });
    expect(unconfirmed.available).toBe(false);
    expect(unconfirmed.reason).toContain("BYOK-only routing is not confirmed");
  });

  test("AI/ML API searches only with a research model", () => {
    const aiml: ByokSettings = { ...base, providers: ["aimlapi"], modelsByProvider: { aimlapi: ["openai/gpt-4o-mini", "perplexity/sonar"] }, defaultModel: { provider: "aimlapi", modelId: "openai/gpt-4o-mini" } };
    const without = webSearchAvailabilityFrom(aiml, { providerKey: "aimlapi", verified: true });
    expect(without.available).toBe(false);
    expect(without.reason).toContain("web research model");
    expect(webSearchAvailabilityFrom({ ...aiml, researchModel: { provider: "aimlapi", modelId: "perplexity/sonar" } }, { providerKey: "aimlapi", verified: true }))
      .toEqual({ available: true, provider: "aimlapi", model: "perplexity/sonar", reason: null });
  });

  test("no connection, or an unverified one, cannot search", () => {
    expect(webSearchAvailabilityFrom({ ...base, connectionId: null }, null).reason).toContain("needs an AI provider that searches the web");
    expect(webSearchAvailabilityFrom(base, { providerKey: "openrouter", verified: false }).available).toBe(false);
  });
});
