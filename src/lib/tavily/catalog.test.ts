import { describe, expect, test } from "bun:test";
import { tavilyCapProblem, tavilyPlanOf, tavilySources } from "./catalog";

// The shape POST https://api.tavily.com/search documents (API reference read 2026-10-17), trimmed.
const SEARCH = {
  query: "dental clinics Baner Pune",
  answer: null,
  images: [],
  results: [
    { title: "Lotus Dental Care — Baner", url: "https://lotus.example.in/", content: "Dentist   in Baner,\nPune. Call us.", score: 0.81 },
    { title: "Same page again", url: "https://lotus.example.in/", content: "duplicate", score: 0.5 },
    { title: "Not a web page", url: "javascript:alert(1)", content: "x" },
    { title: "Broken", url: "not a url", content: "x" },
    { title: null, url: "https://directory.example.com/pune/dentists", content: "" },
  ],
  response_time: 1.67,
  usage: { credits: 1 },
};

describe("search results", () => {
  test("become the result pages, in Tavily's order: web URLs only, each once, tidy text", () => {
    expect(tavilySources(SEARCH)).toEqual([
      { url: "https://lotus.example.in/", title: "Lotus Dental Care — Baner", snippet: "Dentist in Baner, Pune. Call us." },
      { url: "https://directory.example.com/pune/dentists", title: null, snippet: null },
    ]);
    expect(tavilySources(SEARCH, 1)).toHaveLength(1);
    expect(tavilySources({ detail: { error: "Unauthorized" } })).toEqual([]);
    expect(tavilySources(null)).toEqual([]);
  });
});

describe("the plan and the daily cap", () => {
  test("the plan's credits are read from GET /usage", () => {
    expect(tavilyPlanOf({ key: { usage: 12 }, account: { current_plan: "Researcher", plan_usage: 120, plan_limit: 1000 } })).toEqual({ name: "Researcher", used: 120, limit: 1000 });
    expect(tavilyPlanOf({ key: { usage: 12 } })).toBeNull();
  });
  test("a website search starts only when all its searches fit in the day's cap", () => {
    expect(tavilyCapProblem(97, 3, 100)).toBeNull();
    expect(tavilyCapProblem(98, 3, 100)).toContain("leaves 2 searches");
    expect(tavilyCapProblem(100, 2, 100)).toContain("leaves 0 searches");
  });
});
