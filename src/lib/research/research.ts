import type { ResearchKind, ResearchSource } from "./schema";

/**
 * Web research about one imported company: a question answered by a model
 * that searches the web (AI/ML API's search models, e.g. Perplexity Sonar),
 * saved with the source URLs the provider returned. It is not lead
 * discovery and not social-media scraping: it answers a question about a
 * company already in the lead database, from public web pages, and nothing
 * more. Pure helpers here; the call is in research.server.ts.
 */

export const RESEARCH_KIND_LABELS: Record<ResearchKind, string> = {
  company: "Company overview",
  website: "Website",
  parent: "Parent company",
  question: "Your question",
};

export const MAX_CUSTOM_QUESTION_LENGTH = 300;

/** The answer a model gives when the search results do not answer the question. */
export const NOT_FOUND_MARKER = "NOT_FOUND";

export const RESEARCH_SYSTEM_PROMPT = [
  "You research companies for a B2B sales team using web search.",
  "Answer only from the web search results for this request, never from memory. If the results do not answer the question, reply with exactly NOT_FOUND and nothing else.",
  "Be factual and brief: at most six sentences. Mark each fact with its source number, like [1].",
  "Do not guess people's personal contact details and do not describe private individuals.",
].join("\n");

export type ResearchSubject = { name: string | null; domain: string };

/** The question sent for a kind of research, or why it cannot be asked. */
export function researchPrompt(
  kind: ResearchKind,
  company: ResearchSubject,
  customQuestion?: string | null,
): { ok: true; question: string } | { ok: false; error: string } {
  const label = company.name?.trim() ? `${company.name.trim()} (${company.domain})` : company.domain;
  switch (kind) {
    case "company":
      return { ok: true, question: `What does the company ${label} do? Summarize its business, main products or services, customers, size and headquarters.` };
    case "website":
      return { ok: true, question: `Who operates the website https://${company.domain}, and what does it offer?` };
    case "parent":
      return { ok: true, question: `Is ${label} owned by, or a subsidiary of, another company? Name the parent company and the ultimate owner, if any.` };
    case "question": {
      const text = customQuestion?.trim() ?? "";
      if (!text) return { ok: false, error: "Write the question to research." };
      if (text.length > MAX_CUSTOM_QUESTION_LENGTH) return { ok: false, error: `Keep the question under ${MAX_CUSTOM_QUESTION_LENGTH} characters.` };
      return { ok: true, question: `About the company ${label}: ${text}` };
    }
  }
}

const MAX_SOURCES = 20;

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const text = (value: unknown, limit: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null);

/**
 * The sources a chat-completions response carries, in the provider's order:
 * Perplexity's top-level `citations` (the [n] in its answer index into it)
 * and `search_results`, and OpenAI-style `url_citation` annotations (with
 * the page excerpt OpenRouter's web plugin puts in `content`, when given).
 * Only what the provider returned counts: URLs written inside the answer
 * text are ignored, so a model answering from memory cannot invent its
 * citations.
 */
export function researchSources(response: unknown): ResearchSource[] {
  const body = (response && typeof response === "object" ? response : {}) as Record<string, unknown>;
  const byUrl = new Map<string, ResearchSource>();
  const add = (url: string | null, title: string | null, snippet: string | null) => {
    if (!url) return;
    const existing = byUrl.get(url);
    if (existing) {
      existing.title ??= title;
      existing.snippet ??= snippet;
    } else if (byUrl.size < MAX_SOURCES) {
      byUrl.set(url, { url, title, snippet });
    }
  };

  if (Array.isArray(body.citations)) {
    for (const citation of body.citations) add(httpUrl(citation), null, null);
  }
  if (Array.isArray(body.search_results)) {
    for (const result of body.search_results as Array<Record<string, unknown>>) {
      add(httpUrl(result?.url), text(result?.title, 300), text(result?.snippet, 500));
    }
  }
  const choices = Array.isArray(body.choices) ? body.choices as Array<Record<string, unknown>> : [];
  const message = (choices[0]?.message ?? {}) as Record<string, unknown>;
  if (Array.isArray(message.annotations)) {
    for (const annotation of message.annotations as Array<Record<string, unknown>>) {
      const citation = (annotation?.url_citation ?? {}) as Record<string, unknown>;
      add(httpUrl(citation.url), text(citation.title, 300), text(citation.content, 500));
    }
  }
  return [...byUrl.values()];
}

/** The answer text of a chat-completions response, trimmed; "" when there is none. */
export function researchAnswer(response: unknown): string {
  const choices = (response as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : "";
}

/** What AI/ML API says the call cost, in US dollars, when it says. */
export function researchCostUsd(response: unknown): number | null {
  const body = response as { meta?: { usage?: { usd_spent?: unknown } }; usage?: { cost?: { total_cost?: unknown } } } | null;
  const spent = body?.meta?.usage?.usd_spent ?? body?.usage?.cost?.total_cost;
  return typeof spent === "number" && Number.isFinite(spent) && spent >= 0 ? spent : null;
}

export type ResearchOutcome =
  | { status: "succeeded"; answer: string; sources: ResearchSource[] }
  | { status: "not_found"; answer: null; sources: ResearchSource[] }
  | { status: "failed"; error: string; sources: ResearchSource[] };

/**
 * What a response amounts to. An answer with no provider-returned source is
 * a failure, never a finding: it means the model did not search (or the
 * search found nothing), and its text would be model memory dressed up as
 * research.
 */
export function researchOutcome(response: unknown, model: string): ResearchOutcome {
  const sources = researchSources(response);
  const answer = researchAnswer(response);
  const notFound = answer === NOT_FOUND_MARKER || answer.replace(/[.\s]/g, "") === NOT_FOUND_MARKER;
  if (!answer) return { status: "failed", error: `${model} returned no answer. Nothing was saved as a finding.`, sources };
  if (!sources.length) {
    // "Not found" without a single source means no search ran, not that the web has no answer.
    return {
      status: "failed",
      error: `${model} ${notFound ? "reported nothing found" : "answered"} without returning any web sources, so it did not search the web and nothing was saved as a finding. Choose a model that searches the web (Perplexity Sonar was verified) in Settings → AI provider.`,
      sources,
    };
  }
  if (notFound) return { status: "not_found", answer: null, sources };
  return { status: "succeeded", answer, sources };
}

/** Today's window (UTC) for the daily research limit. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
