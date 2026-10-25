import { describe, expect, test } from "bun:test";
import { researchHeadline, researchRow, researchSummary, researchTitle, type ResearchJob, type ResearchMessage } from "./researchView";

const message = (over: Partial<ResearchMessage> = {}): ResearchMessage => ({
  id: "m1",
  tool: "find_leads",
  status: "ok",
  content: "Lead search started",
  toolInput: { what: "real estate agencies", where: "Miami, FL" },
  toolResult: { display: "Searching Google Maps", data: { jobId: "j1", phrase: "real estate agencies in Miami, FL" } },
  ...over,
});

const job = (over: Partial<ResearchJob> = {}): ResearchJob => ({
  id: "j1",
  kind: "discovery",
  status: "running",
  stage: "searching",
  progress: { source: "Google Maps through the built-in scraper" },
  result: null,
  error: null,
  audienceId: null,
  ...over,
});

describe("a search's row in the research card", () => {
  test("names what was searched and where, without the scraper's name", () => {
    const row = researchRow(message(), job(), "UTC");
    expect(row.title).toBe("real estate agencies in Miami, FL");
    expect(row.source).toBe("Google Maps");
    expect(row.icon).toBe("maps");
    expect(row.state).toBe("running");
    expect(row.step).toBe("Searching");
    expect(row.progress).toBeNull();
  });

  test("a live step with both counts carries its fraction", () => {
    const row = researchRow(message(), job({ stage: "enriching", progress: { websitesChecked: 12, websitesToCheck: 20 } }), "UTC");
    expect(row.step).toBe("Reading websites for contacts");
    expect(row.progress).toEqual({ done: 12, total: 20 });
  });

  test("a step without a total shows no made-up fraction", () => {
    expect(researchRow(message(), job({ stage: "enriching", progress: { websitesChecked: 3 } }), "UTC").progress).toBeNull();
  });

  test("a provider's wait is shown as waiting, with its reason", () => {
    const row = researchRow(message(), job({ progress: { waiting: { reason: "Google Maps asked to slow down" } } }), "UTC");
    expect(row.state).toBe("waiting");
    expect(row.step).toContain("Google Maps asked to slow down");
  });

  test("a finished search shows found, contactable and match, and keeps every other recorded fact", () => {
    const row = researchRow(message(), job({
      status: "succeeded",
      stage: "done",
      audienceId: "a1",
      result: { found: 23, eligible: 14, excluded: 9, duplicates: 1, alreadyKnown: 2, withEmail: 11, withPhoneOnly: 3, withInstagram: 2, fit: { contactable: 14, qualified: 9, notMatching: 3, unconfirmed: 2, pending: 0 }, note: "One area had no listings.", fitNote: "Judged by the website.", providerNote: "Apify was over budget." },
    }), "UTC");
    expect(row.state).toBe("done");
    expect(row.stats).toEqual([{ label: "found", value: 23 }, { label: "contactable", value: 14 }, { label: "match", value: 9 }]);
    expect(row.details).toEqual([
      "Reachable: 11 by email, 3 by phone only, 2 with Instagram profiles",
      "9 match your request, 3 do not, 2 unconfirmed",
      "9 left out with reasons",
      "1 duplicate skipped",
      "2 already in your leads (not duplicated)",
      "One area had no listings.",
      "Judged by the website.",
      "Apify was over budget.",
    ]);
    expect(row.audienceId).toBe("a1");
    expect(row.contactable).toBe(14);
    expect(row.excluded).toBe(9);
  });

  test("no match figure before any lead was judged", () => {
    const row = researchRow(message(), job({ status: "succeeded", result: { found: 5, eligible: 0 } }), "UTC");
    expect(row.stats.map((stat) => stat.label)).toEqual(["found", "contactable"]);
  });

  test("a failed job says it failed, with the job's own error", () => {
    const row = researchRow(message(), job({ status: "failed", error: "Google Maps did not answer within 10 minutes." }), "UTC");
    expect(row.state).toBe("failed");
    expect(row.error).toBe("Google Maps did not answer within 10 minutes.");
  });

  test("a refused call is a row that did not start, with the refusal", () => {
    const row = researchRow(message({ status: "error", toolResult: { display: "Not run: say which place" } }), undefined, "UTC");
    expect(row.state).toBe("failed");
    expect(row.step).toBe("Not started");
    expect(row.error).toBe("Not run: say which place");
  });

  test("a source that was not searched says so, with its note", () => {
    const row = researchRow(message(), job({ status: "succeeded", result: { notSearched: true, note: "Apify is not set up." } }), "UTC");
    expect(row.state).toBe("skipped");
    expect(row.details).toEqual(["Apify is not set up."]);
  });

  test("Apify and Bright Data searches name their platform and provider", () => {
    expect(researchRow(message({ tool: "find_social_leads", toolInput: { platform: "facebook", what: "agencies", where: "Miami" } }), job({ progress: { provider: "Apify" } }), "UTC").source).toBe("Facebook pages via Apify");
    expect(researchRow(message(), job({ progress: { source: "Google Maps", provider: "Apify" } }), "UTC").source).toBe("Google Maps via Apify");
    const social = researchRow(message({ tool: "research_social_sources", toolInput: { platforms: ["reddit", "x"], customers: "realtors" }, toolResult: { data: { jobId: "j1", phrase: "struggling to get leads" } } }), job({ kind: "social_research", status: "succeeded", result: { found: 12, eligible: 4, discussions: 31, needSignals: 6, creditsUsed: 47 } }), "UTC");
    expect(social.source).toBe("Reddit, X via Bright Data");
    expect(social.title).toBe("realtors: struggling to get leads");
    expect(social.stats[0]).toEqual({ label: "people or businesses", value: 12 });
    expect(social.details).toContain("31 relevant posts and comments read");
    expect(social.details).toContain("Bright Data credits used: 47 (estimated)");
  });

  test("a title falls back to the arguments, then to a plain name", () => {
    expect(researchTitle(message({ toolResult: { data: {} } }))).toBe("real estate agencies in Miami, FL");
    expect(researchTitle(message({ toolInput: {}, toolResult: null }))).toBe("Lead search");
  });
});

describe("the research card's header", () => {
  const running = researchRow(message(), job(), "UTC");
  const done = researchRow(message({ id: "m2" }), job({ status: "succeeded", result: { found: 10, eligible: 4, fit: { contactable: 4, qualified: 3 } } }), "UTC");
  const failed = researchRow(message({ id: "m3" }), job({ status: "failed", error: "x" }), "UTC");

  test("while searches run it says how many are where", () => {
    const summary = researchSummary([running, done, failed]);
    expect(summary).toMatchObject({ total: 3, running: 1, done: 1, failed: 1 });
    expect(researchHeadline(summary)).toEqual({ title: "Researching 3 sources", detail: "1 done, 1 failed, 1 still going" });
  });

  test("when they end it adds up what they found", () => {
    expect(researchHeadline(researchSummary([done, failed]))).toEqual({ title: "Searches finished, 1 failed", detail: "10 found · 4 contactable · 3 match" });
  });

  test("when every search failed it reports a search failure", () => {
    expect(researchHeadline(researchSummary([failed])).title).toBe("Search failed");
  });
});

test("a refused source is not labelled completed research", () => {
  const skipped = researchRow(message(), job({ status: "succeeded", stage: "done", result: { notSearched: true, note: "Handed to an available source" } }), "UTC");
  expect(researchHeadline(researchSummary([skipped])).title).toBe("Source not searched");
});
