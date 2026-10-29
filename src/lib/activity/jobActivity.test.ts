import { describe, expect, test } from "bun:test";
import { jobActivity, jobStep, jobTransport, toolTransport, transportLine, type JobActivityFacts } from "./jobActivity";

const now = new Date("2026-10-28T14:00:00Z");
const later = (seconds: number) => new Date(now.getTime() + seconds * 1_000);
const job = (facts: Partial<JobActivityFacts>): JobActivityFacts => ({ kind: "discovery", status: "queued", stage: "queued", runAfter: null, heartbeatAt: null, attempts: 0, progress: null, ...facts });

describe("an open search's state comes from its recorded facts", () => {
  test("a search not picked up yet is Queued, with nothing invented", () => {
    expect(jobActivity(job({}), now)).toEqual({ phase: "queued", label: "Queued", reason: null, nextCheckAt: null });
  });

  test("a running step is Searching or Reading pages by its stage", () => {
    expect(jobActivity(job({ status: "running", stage: "searching", heartbeatAt: now }), now)?.label).toBe("Searching");
    expect(jobActivity(job({ status: "running", stage: "enriching", heartbeatAt: now }), now)?.label).toBe("Reading pages");
    expect(jobActivity(job({ status: "running", stage: "reading", heartbeatAt: now }), now)?.label).toBe("Reading pages");
    // Saving and checking leads are steps of the search; the step line says which.
    expect(jobActivity(job({ status: "running", stage: "qualifying", heartbeatAt: now }), now)?.label).toBe("Searching");
  });

  test("between polls of the run it started at its provider it waits for the provider's results, with the next check", () => {
    const polled = jobActivity(job({ stage: "apify", runAfter: later(40), progress: { stage: "searching", provider: "Apify" }, providerRun: true }), now);
    expect(polled).toEqual({ phase: "waiting_provider", label: "Waiting for provider results", reason: null, nextCheckAt: later(40).toISOString() });
    expect(jobActivity(job({ kind: "linkedin_search", stage: "searching", runAfter: later(20) }), now)?.label).toBe("Waiting for provider results");
  });

  test("a step due now is the work itself, not a wait", () => {
    expect(jobActivity(job({ stage: "enriching", runAfter: later(1) }), now)).toEqual({ phase: "reading", label: "Reading pages", reason: null, nextCheckAt: null });
  });

  test("a slot or allowance wait is Queued with the recorded reason and when it is checked again, never a warning state", () => {
    const slot = jobActivity(job({ runAfter: later(60), progress: { waiting: { kind: "slot", provider: "apify", reason: "both of your Apify runs are in use; it starts when one finishes" } } }), now);
    expect(slot).toEqual({ phase: "queued", label: "Queued", reason: "waiting for a free Apify run slot: both of your Apify runs are in use; it starts when one finishes", nextCheckAt: later(60).toISOString() });
    const quota = jobActivity(job({ stage: "searching", runAfter: later(90), progress: { waiting: { kind: "quota", provider: "tinyfish", until: later(30).toISOString(), reason: "TinyFish allows 30 searches a minute" } } }), now);
    expect(quota).toMatchObject({ label: "Queued", nextCheckAt: later(30).toISOString() });
    expect(quota?.reason).toContain("TinyFish's limit");
  });

  test("a failed step that runs again is Retrying, with the error's first sentence and the next try", () => {
    const retry = jobActivity(job({ stage: "searching", attempts: 2, runAfter: later(30), progress: { lastError: "TinyFish answered 503 Service Unavailable. Body: <html>…" } }), now);
    expect(retry).toEqual({ phase: "retrying", label: "Retrying", reason: "TinyFish answered 503 Service Unavailable", nextCheckAt: later(30).toISOString() });
  });

  test("a running step whose worker stopped reporting is retried, not shown as working", () => {
    expect(jobActivity(job({ status: "running", stage: "searching", heartbeatAt: new Date(now.getTime() - 4 * 60_000) }), now)?.label).toBe("Retrying");
  });

  test("only the owner's pause is Needs you; a spend-cap hold is an ordinary queue", () => {
    expect(jobActivity(job({ stage: "qualifying", runAfter: later(60), progress: { waiting: { kind: "paused", reason: "the owner paused this request's research; its leads are judged when resumed" } } }), now)?.label).toBe("Needs you");
    expect(jobActivity(job({ stage: "searching", runAfter: later(60), progress: { waiting: { kind: "paused", reason: "the next search waits: this request's other paid work holds $1.00 of its $2.00 spend cap until it settles" } } }), now)?.label).toBe("Queued");
  });

  test("a request's driver following its searches is searching, with what it waits for", () => {
    expect(jobActivity(job({ kind: "objective", stage: "watching", runAfter: later(60), progress: { waiting: { kind: "objective", reason: "5 searches still running" } } }), now))
      .toMatchObject({ label: "Searching", reason: "5 searches still running" });
  });

  test("a finished job has no live state", () => {
    expect(jobActivity(job({ status: "succeeded" }), now)).toBeNull();
    expect(jobActivity(job({ status: "failed" }), now)).toBeNull();
  });
});

describe("a live step and its fraction", () => {
  test("counts both recorded, never a made-up total", () => {
    expect(jobStep({ kind: "social_research", stage: "reading", progress: { read: 12, websites: 30 } })).toEqual({ step: "Reading pages for contacts", progress: { done: 12, total: 30 } });
    expect(jobStep({ kind: "discovery", stage: "enriching", progress: { websitesChecked: 3 } }).progress).toBeNull();
    expect(jobStep({ kind: "linkedin_search", stage: "searching", progress: { found: 37 } }).step).toBe("37 profiles so far");
  });
});

describe("what a search ran through", () => {
  test("from the job's kind, its payload's provider and what it recorded", () => {
    const line = (facts: Parameters<typeof jobTransport>[0]) => transportLine(jobTransport(facts));
    expect(line({ kind: "discovery", progress: { source: "Google Maps through the built-in scraper" }, result: null, provider: "scraper" })).toBe("Google Maps · Maps scraper");
    expect(line({ kind: "discovery", progress: { provider: "Apify" }, result: null, target: "facebook", provider: "apify" })).toBe("Facebook pages · Apify");
    expect(line({ kind: "discovery", progress: null, result: { provider: "apify" } })).toBe("Google Maps · Apify");
    expect(line({ kind: "linkedin_search", progress: null, result: null })).toBe("LinkedIn · Unipile");
    expect(line({ kind: "apify_instagram", progress: null, result: null })).toBe("Instagram · Apify");
    expect(line({ kind: "web_discovery", progress: null, result: null, searchProvider: "tinyfish" })).toBe("Websites and directories · TinyFish Search");
    // What the searches recorded wins over the provider the job was started with.
    expect(line({ kind: "web_discovery", progress: null, result: { searches: [{ provider: "tavily" }, { provider: "tavily" }] }, searchProvider: "tinyfish" })).toBe("Websites and directories · Tavily");
    expect(line({ kind: "social_research", progress: { sources: [{ platform: "reddit", state: "searched" }] }, result: null })).toBe("Reddit · Bright Data");
    expect(line({ kind: "outreach_start", progress: null, result: null })).toBeNull();
  });

  test("tools without a job name their own transport; checking the browser connection is not using it", () => {
    expect(toolTransport("exa_search", null)).toBe("Exa");
    expect(toolTransport("web_search", { data: { provider: "tavily" } })).toBe("Tavily");
    expect(toolTransport("web_search", null)).toBe("Web search");
    expect(toolTransport("browser_tab_read", null)).toBe("Your Chrome");
    expect(toolTransport("browser_read", null)).toBe("TinyFish browser");
    expect(toolTransport("browser_connection", null)).toBeNull();
    expect(toolTransport("set_brief", null)).toBeNull();
  });
});
