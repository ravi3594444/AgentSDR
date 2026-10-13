import { describe, expect, test } from "bun:test";
import { researchCostUsd, researchOutcome, researchPrompt, researchSources, utcDayStart } from "./research";

// Shapes as AI/ML API returned them on 2026-10-13 (trimmed).
const sonar = {
  choices: [{ message: { role: "assistant", content: "Stripe.com is operated by Stripe, LLC; its parent is Stripe Global Holdings Inc. [2][4]" } }],
  citations: ["https://en.wikipedia.org/wiki/Stripe,_Inc.", "https://stripe.com/legal/privacy-center", "not a url"],
  search_results: [
    { title: "Stripe - Wikipedia", url: "https://en.wikipedia.org/wiki/Stripe,_Inc.", snippet: "Stripe is an Irish-American financial services company…" },
    { title: "Privacy center", url: "https://stripe.com/legal/privacy-center", snippet: null },
  ],
  usage: { cost: { total_cost: 0.0032 } },
  meta: { usage: { usd_spent: 0.006576 } },
};
const memoryOnly = {
  choices: [{ message: { role: "assistant", content: "According to web search results, stripe.com is owned by Stripe, Inc. See https://stripe.com/about." } }],
  meta: { usage: { usd_spent: 0.000452 } },
};
const annotated = {
  choices: [{ message: { content: "Acme is owned by Globex [1].", annotations: [{ type: "url_citation", url_citation: { url: "https://globex.example/acme", title: "Globex acquires Acme", start_index: 0, end_index: 10 } }] } }],
};

describe("researchSources", () => {
  test("takes Perplexity citations and search results, merged by URL, in order", () => {
    expect(researchSources(sonar)).toEqual([
      { url: "https://en.wikipedia.org/wiki/Stripe,_Inc.", title: "Stripe - Wikipedia", snippet: "Stripe is an Irish-American financial services company…" },
      { url: "https://stripe.com/legal/privacy-center", title: "Privacy center", snippet: null },
    ]);
  });

  test("takes url_citation annotations", () => {
    expect(researchSources(annotated)).toEqual([{ url: "https://globex.example/acme", title: "Globex acquires Acme", snippet: null }]);
  });

  test("never takes a URL the model wrote in its answer", () => {
    expect(researchSources(memoryOnly)).toEqual([]);
  });
});

describe("researchOutcome", () => {
  test("an answer with provider sources is a finding", () => {
    const outcome = researchOutcome(sonar, "perplexity/sonar");
    expect(outcome.status).toBe("succeeded");
    expect(outcome.sources).toHaveLength(2);
  });

  test("an answer without sources fails instead of being saved as research", () => {
    const outcome = researchOutcome(memoryOnly, "openai/gpt-5.4-mini");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error).toContain("without returning any web sources");
  });

  test("NOT_FOUND is its own outcome, and an empty answer fails", () => {
    expect(researchOutcome({ choices: [{ message: { content: "NOT_FOUND" } }], citations: ["https://a.example"] }, "m").status).toBe("not_found");
    // Without a source, "not found" only means the model did not search.
    expect(researchOutcome({ choices: [{ message: { content: "NOT_FOUND" } }] }, "m").status).toBe("failed");
    expect(researchOutcome({ choices: [{ message: { content: "" } }] }, "m").status).toBe("failed");
  });
});

describe("researchPrompt", () => {
  const company = { name: "Acme", domain: "acme.example" };
  test("builds each kind of question about the company", () => {
    expect(researchPrompt("parent", company)).toEqual({ ok: true, question: "Is Acme (acme.example) owned by, or a subsidiary of, another company? Name the parent company and the ultimate owner, if any." });
    expect(researchPrompt("website", { name: null, domain: "acme.example" })).toEqual({ ok: true, question: "Who operates the website https://acme.example, and what does it offer?" });
  });

  test("a custom question must be given and short", () => {
    expect(researchPrompt("question", company, " ").ok).toBe(false);
    expect(researchPrompt("question", company, "x".repeat(301)).ok).toBe(false);
    expect(researchPrompt("question", company, "Do they sell in Germany?")).toEqual({ ok: true, question: "About the company Acme (acme.example): Do they sell in Germany?" });
  });
});

describe("researchCostUsd and utcDayStart", () => {
  test("reads AI/ML's spend, preferring meta.usage.usd_spent", () => {
    expect(researchCostUsd(sonar)).toBe(0.006576);
    expect(researchCostUsd({ usage: { cost: { total_cost: 0.0032 } } })).toBe(0.0032);
    expect(researchCostUsd({})).toBeNull();
  });

  test("the daily limit window starts at 00:00 UTC", () => {
    expect(utcDayStart(new Date("2026-10-13T18:45:00+05:30")).toISOString()).toBe("2026-10-13T00:00:00.000Z");
  });
});
