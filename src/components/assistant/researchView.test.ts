import { describe, expect, test } from "bun:test";
import { requestFigures, researchHeadline, researchRow, researchSummary, researchTitle, type ResearchJob, type ResearchMessage } from "./researchView";

const now = new Date("2026-10-28T14:00:00Z");

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
    const row = researchRow(message(), job(), now);
    expect(row.title).toBe("real estate agencies in Miami, FL");
    expect(row.source).toBe("Google Maps · Maps scraper");
    expect(row.icon).toBe("maps");
    expect(row.state).toBe("open");
    expect(row.label).toBe("Searching");
    expect(row.step).toBeNull();
    expect(row.progress).toBeNull();
  });

  test("a live step with both counts carries its fraction", () => {
    const row = researchRow(message(), job({ stage: "enriching", progress: { websitesChecked: 12, websitesToCheck: 20 } }), now);
    expect(row.label).toBe("Reading pages");
    expect(row.step).toBe("Reading websites for contacts");
    expect(row.progress).toEqual({ done: 12, total: 20 });
  });

  test("a step without a total shows no made-up fraction", () => {
    expect(researchRow(message(), job({ stage: "enriching", progress: { websitesChecked: 3 } }), now).progress).toBeNull();
  });

  test("a wait before its next step is Queued with the recorded reason and next check, not a warning or \"Scheduled\"", () => {
    const next = new Date(now.getTime() + 60_000).toISOString();
    const row = researchRow(message(), job({ status: "queued", stage: "queued", runAfter: next, progress: { waiting: { kind: "slot", provider: "apify", reason: "both Apify runs are in use" } } }), now);
    expect(row).toMatchObject({ state: "open", phase: "queued", label: "Queued", reason: "waiting for a free Apify run slot: both Apify runs are in use", nextCheckAt: next });
  });

  test("between polls of its provider run it waits for the provider's results; a failed step is retried with its error", () => {
    const next = new Date(now.getTime() + 40_000).toISOString();
    expect(researchRow(message(), job({ status: "queued", stage: "apify", runAfter: next, providerRun: true, provider: "apify" }), now)).toMatchObject({ label: "Waiting for provider results", source: "Google Maps · Apify", nextCheckAt: next });
    expect(researchRow(message(), job({ status: "queued", stage: "searching", runAfter: next, attempts: 2, progress: { lastError: "TinyFish answered 503" } }), now)).toMatchObject({ label: "Retrying", reason: "TinyFish answered 503", nextCheckAt: next });
  });

  test("a finished search shows found, contactable and match, and keeps every other recorded fact", () => {
    const row = researchRow(message(), job({
      status: "succeeded",
      stage: "done",
      audienceId: "a1",
      result: { found: 23, eligible: 14, excluded: 9, duplicates: 1, alreadyKnown: 2, withEmail: 11, withPhoneOnly: 3, withInstagram: 2, fit: { contactable: 14, qualified: 9, notMatching: 3, unconfirmed: 2, pending: 0 }, note: "One area had no listings.", fitNote: "Judged by the website.", providerNote: "Apify was over budget." },
    }), now);
    expect(row.state).toBe("done");
    expect(row.stats).toEqual([{ label: "Found", value: 23 }, { label: "Contactable", value: 14 }, { label: "Matching", value: 9 }]);
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
    const row = researchRow(message(), job({ status: "succeeded", result: { found: 5, eligible: 0 } }), now);
    expect(row.stats.map((stat) => stat.label)).toEqual(["Found", "Contactable"]);
  });

  test("a failed job says it failed, with the job's own error", () => {
    const row = researchRow(message(), job({ status: "failed", error: "Google Maps did not answer within 10 minutes." }), now);
    expect(row.state).toBe("failed");
    expect(row.error).toBe("Google Maps did not answer within 10 minutes.");
  });

  test("a refused call is a row that did not start, with the refusal", () => {
    const row = researchRow(message({ status: "error", toolResult: { display: "Not run: say which place" } }), undefined, now);
    expect(row.state).toBe("failed");
    expect(row.label).toBe("Not started");
    expect(row.error).toBe("Not run: say which place");
  });

  test("a source that was not searched says so, with its note", () => {
    const row = researchRow(message(), job({ status: "succeeded", result: { notSearched: true, note: "Apify is not set up." } }), now);
    expect(row.state).toBe("skipped");
    expect(row.details).toEqual(["Apify is not set up."]);
  });

  test("Apify and Bright Data searches name their platform and provider", () => {
    expect(researchRow(message({ tool: "find_social_leads", toolInput: { platform: "facebook", what: "agencies", where: "Miami" } }), job({ progress: { provider: "Apify" } }), now).source).toBe("Facebook pages · Apify");
    expect(researchRow(message(), job({ progress: { source: "Google Maps", provider: "Apify" } }), now).source).toBe("Google Maps · Apify");
    const social = researchRow(message({ tool: "research_social_sources", toolInput: { platforms: ["reddit", "x"], customers: "realtors" }, toolResult: { data: { jobId: "j1", phrase: "struggling to get leads" } } }), job({ kind: "social_research", status: "succeeded", result: { found: 12, eligible: 4, discussions: 31, needSignals: 6, creditsUsed: 47 } }), now);
    expect(social.source).toBe("Reddit, X · Bright Data");
    expect(social.title).toBe("realtors: struggling to get leads");
    expect(social.stats[0]).toEqual({ label: "Found", value: 12 });
    expect(social.details).toContain("Found: 12 people or businesses");
    expect(social.details).toContain("31 relevant posts and comments read");
    expect(social.details).toContain("Bright Data credits used: 47 (estimated)");
  });

  test("a title falls back to the arguments, then to a plain name", () => {
    expect(researchTitle(message({ toolResult: { data: {} } }))).toBe("real estate agencies in Miami, FL");
    expect(researchTitle(message({ toolInput: {}, toolResult: null }))).toBe("Lead search");
  });
});

describe("the research card's header", () => {
  const running = researchRow(message(), job(), now);
  const done = researchRow(message({ id: "m2" }), job({ status: "succeeded", result: { found: 10, eligible: 4, fit: { contactable: 4, qualified: 3 } } }), now);
  const failed = researchRow(message({ id: "m3" }), job({ status: "failed", error: "x" }), now);

  test("while searches run it says how many are where", () => {
    const summary = researchSummary([running, done, failed]);
    expect(summary).toMatchObject({ total: 3, open: 1, done: 1, failed: 1 });
    expect(researchHeadline(summary)).toEqual({ title: "Researching", detail: "1 of 3 searches still going · 1 failed" });
  });

  test("when they end it adds up what they found", () => {
    expect(researchSummary([done, failed])).toMatchObject({ found: 10, contactable: 4, matching: 3 });
    expect(researchHeadline(researchSummary([done, failed]))).toEqual({ title: "Searches finished", detail: "2 searches, 1 failed" });
  });

  test("when every search failed it reports a search failure", () => {
    expect(researchHeadline(researchSummary([failed])).title).toBe("Search failed");
  });
});

test("a refused source is not labelled completed research", () => {
  const skipped = researchRow(message(), job({ status: "succeeded", stage: "done", result: { notSearched: true, note: "Handed to an available source" } }), now);
  expect(researchHeadline(researchSummary([skipped])).title).toBe("Source not searched");
});

describe("the request card's figures", () => {
  const rows = { total: 2, open: 0, done: 2, skipped: 0, failed: 0, retrying: 0, needsYou: 0, found: 70, contactable: 43, matching: 24 };
  const numbers = { found: 68, contactable: 41, matching: 24, contacted: 0, replied: 0, interested: 0 };

  test("named the same everywhere, from the request's own numbers when it has them", () => {
    expect(requestFigures({ numbers, target: null, rows, outreach: false })).toEqual([
      { label: "Found", value: "68" }, { label: "Contactable", value: "41" }, { label: "Matching", value: "24" },
    ]);
  });

  test("an unnamed default target is never shown as wanted; a named one is", () => {
    expect(requestFigures({ numbers, target: null, rows, outreach: false }).find((figure) => figure.label === "Matching")?.value).toBe("24");
    expect(requestFigures({ numbers, target: 30, rows, outreach: false }).find((figure) => figure.label === "Matching")?.value).toBe("24 of 30");
  });

  test("outreach figures appear only once outreach is relevant", () => {
    expect(requestFigures({ numbers, target: null, rows, outreach: false }).map((figure) => figure.label)).not.toContain("Contacted");
    expect(requestFigures({ numbers: { ...numbers, contacted: 3, replied: 1 }, target: null, rows, outreach: true }).slice(3)).toEqual([
      { label: "Contacted", value: "3" }, { label: "Replied", value: "1" }, { label: "Interested", value: "0" },
    ]);
  });

  test("while loading nothing is guessed; without a request the finished searches are added up", () => {
    expect(requestFigures({ numbers: undefined, target: null, rows, outreach: false }).map((figure) => figure.value)).toEqual(["—", "—", "—"]);
    expect(requestFigures({ numbers: null, target: null, rows, outreach: false }).map((figure) => figure.value)).toEqual(["70", "43", "24"]);
    expect(requestFigures({ numbers: null, target: null, rows: { ...rows, matching: null }, outreach: false }).map((figure) => figure.label)).toEqual(["Found", "Contactable"]);
  });
});
