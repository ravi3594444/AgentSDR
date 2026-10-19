import { describe, expect, test } from "bun:test";
import {
  AI_SEARCH_ESTIMATE_USD,
  continuationNote,
  limitReached,
  isLeadFindingRequest,
  nextDriverStep,
  objectiveReportKey,
  objectiveReportText,
  outcomeOf,
  parseObjectiveControls,
  reasonText,
  requestSpendLine,
  spendFromLedgers,
  spendRoom,
  webSearchLedger,
  type Continuation,
  type DriverFacts,
} from "./objective";

describe("lead request detection for direct research tools", () => {
  test("recognizes lead requests without requiring a discovery tool", () => {
    for (const request of [
      "Find 20 qualified leads for solar installers in Patna",
      "Find dentists in Pune",
      "Research potential customers in India",
      "Source buyers for our wholesale business",
      "Search dentists in Patna",
      "I need new customers in Ranchi",
      "Find leads from this website",
    ]) expect(isLeadFindingRequest(request)).toBe(true);
  });

  test("keeps one-off page questions lightweight", () => {
    for (const request of ["Read this website", "Summarize this article", "What are the opening hours on this page?"]) {
      expect(isLeadFindingRequest(request)).toBe(false);
    }
  });
});

const DEFAULTS = { leadTarget: 25, hours: 4, spendUsd: 5 };
const NOW = new Date("2026-10-19T10:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe("controls: the owner's words, else the organization's defaults", () => {
  test("nothing named: the defaults, marked as defaults", () => {
    expect(parseObjectiveControls("find dentists in Pune and contact them", DEFAULTS)).toEqual({
      leadTarget: 25,
      timeLimitMinutes: 240,
      spendCapUsd: 5,
      named: { target: false, time: false, spend: false },
    });
  });

  test("a target, a time and a spend cap named in the request", () => {
    const controls = parseObjectiveControls("Find 40 real estate agents in Pune within 2 hours, spend up to $3", DEFAULTS);
    expect(controls).toEqual({ leadTarget: 40, timeLimitMinutes: 120, spendCapUsd: 3, named: { target: true, time: true, spend: true } });
  });

  test("other ways of saying them", () => {
    expect(parseObjectiveControls("I need 15 new leads, budget $12.50", DEFAULTS)).toMatchObject({ leadTarget: 15, spendCapUsd: 12.5 });
    expect(parseObjectiveControls("get me 60 salons in Mumbai in 30 minutes", DEFAULTS)).toMatchObject({ leadTarget: 60, timeLimitMinutes: 30 });
    expect(parseObjectiveControls("find gyms, search for an hour, free sources only", DEFAULTS)).toMatchObject({ timeLimitMinutes: 60, spendCapUsd: 0, named: { time: true, spend: true } });
    expect(parseObjectiveControls("find cafes for 2 days with a 10 dollar budget", DEFAULTS)).toMatchObject({ timeLimitMinutes: 2_880, spendCapUsd: 10 });
  });

  test("numbers that are not controls stay out: places, prices and counts of cities", () => {
    expect(parseObjectiveControls("find dentists in 3 cities of Maharashtra", DEFAULTS).named).toEqual({ target: false, time: false, spend: false });
    expect(parseObjectiveControls("find agencies that charge $500 a month for SEO", DEFAULTS).named.spend).toBe(false);
    expect(parseObjectiveControls("find clinics open 24 hours near MG Road", DEFAULTS).named.time).toBe(false);
  });

  test("named values are held inside hard bounds", () => {
    const wild = parseObjectiveControls("find 50000 leads within 900 hours, budget $9000", DEFAULTS);
    expect(wild.leadTarget).toBe(1_000);
    expect(wild.timeLimitMinutes).toBe(72 * 60);
    expect(wild.spendCapUsd).toBe(500);
    expect(parseObjectiveControls("find 20 leads within 1 minute", DEFAULTS).timeLimitMinutes).toBe(5);
  });
});

describe("limits: the first of target, spend and time", () => {
  const base = { now: NOW, deadline: minutes(60), leadTarget: 25, leads: 10, spendCapUsd: 5, spentUsd: 1 };

  test("none reached", () => {
    expect(limitReached(base)).toBeNull();
  });

  test("the target", () => {
    expect(limitReached({ ...base, leads: 25 })).toMatchObject({ reason: "target_reached" });
  });

  test("the spend cap, counted from settled spend", () => {
    expect(limitReached({ ...base, spentUsd: 5 })).toMatchObject({ reason: "budget_spent" });
    expect(limitReached({ ...base, spentUsd: 4.99 })).toBeNull();
  });

  test("a $0 cap is free-only work, never spent", () => {
    expect(limitReached({ ...base, spendCapUsd: 0, spentUsd: 0 })).toBeNull();
  });

  test("the time limit", () => {
    expect(limitReached({ ...base, deadline: NOW })).toMatchObject({ reason: "time_limit" });
  });

  test("the target wins when several hold at once", () => {
    expect(limitReached({ ...base, leads: 30, spentUsd: 9, deadline: minutes(-5) })).toMatchObject({ reason: "target_reached" });
    expect(limitReached({ ...base, spentUsd: 9, deadline: minutes(-5) })).toMatchObject({ reason: "budget_spent" });
  });
});

describe("spend: reserve then settle, from the ledgers", () => {
  test("open Apify runs and Treg calls count at their reserved cap; finished ones at what was charged", () => {
    const spend = spendFromLedgers([
      { ledger: "apify", status: "running", usageUsd: null, maxChargeUsd: 2 },
      { ledger: "apify", status: "succeeded", usageUsd: 0.37, maxChargeUsd: 2 },
      { ledger: "apify", status: "refused", usageUsd: 0, maxChargeUsd: 2 },
      { ledger: "treg", status: "calling", costUsd: null, ceilingUsd: 0.05 },
      { ledger: "treg", status: "succeeded", costUsd: 0.01, ceilingUsd: 0.05 },
      // A lost answer keeps its ceiling counted (treg.server.ts writes it as the cost).
      { ledger: "treg", status: "failed", costUsd: 0.05, ceilingUsd: 0.05 },
    ]);
    expect(spend.apifyUsd).toBeCloseTo(2.37, 6);
    expect(spend.tregUsd).toBeCloseTo(0.11, 6);
    expect(spend.reservedUsd).toBeCloseTo(2.05, 6);
    expect(spend.totalUsd).toBeCloseTo(2.48, 6);
    expect(spend.settledUsd).toBeCloseTo(0.43, 6);
  });

  test("metered browser minutes: reserved and uncertain rows count in full, settled rows what was used; Tavily is credits, not dollars", () => {
    const spend = spendFromLedgers([
      { ledger: "usage", provider: "tinyfish", product: "browser", status: "reserved", units: 10, usedUnits: null },
      { ledger: "usage", provider: "tinyfish", product: "browser", status: "settled", units: 10, usedUnits: 3 },
      { ledger: "usage", provider: "tinyfish", product: "browser", status: "uncertain", units: 10, usedUnits: 10 },
      { ledger: "usage", provider: "tinyfish", product: "search", status: "settled", units: 1, usedUnits: 1 },
      { ledger: "usage", provider: "tavily", product: "search", status: "settled", units: 1, usedUnits: 1 },
      { ledger: "tavily_job", credits: 3 },
      { ledger: "ai_search", costUsd: 0.004 },
    ]);
    expect(spend.browserUsd).toBeCloseTo(0.046, 6);
    expect(spend.reservedUsd).toBeCloseTo(0.02, 6);
    expect(spend.uncertainUsd).toBeCloseTo(0.02, 6);
    expect(spend.tavilyCredits).toBe(4);
    expect(spend.aiSearchUsd).toBeCloseTo(0.004, 6);
    expect(spend.totalUsd).toBeCloseTo(0.05, 6);
  });

  test("room for paid work: the cap less what is settled and reserved", () => {
    expect(spendRoom({ capUsd: 5, settledUsd: 1, reservedUsd: 2, wantUsd: 0.01 })).toEqual({ ok: true, maxUsd: 2 });
  });

  test("used up: refused, not a wait", () => {
    expect(spendRoom({ capUsd: 5, settledUsd: 5, reservedUsd: 0, wantUsd: 0.01 })).toMatchObject({ ok: false, wait: false });
  });

  test("held by other open paid work: a wait until it settles", () => {
    expect(spendRoom({ capUsd: 5, settledUsd: 1, reservedUsd: 4, wantUsd: 0.01 })).toMatchObject({ ok: false, wait: true });
  });

  test("too little left for this call, nothing open: refused", () => {
    expect(spendRoom({ capUsd: 5, settledUsd: 4.98, reservedUsd: 0, wantUsd: 0.05 })).toMatchObject({ ok: false, wait: false });
  });

  test("a $0 cap allows no paid work", () => {
    const room = spendRoom({ capUsd: 0, settledUsd: 0, reservedUsd: 0, wantUsd: 0.01 });
    expect(room).toMatchObject({ ok: false, wait: false });
    expect(room.ok ? "" : room.reason).toMatch(/free sources/);
  });
});

describe("a website search's spend: AI web research at its cost or estimate, Tavily in credits made", () => {
  const search = (provider: string | null, costUsd: number | null, extra: Record<string, unknown> = {}) => ({ query: "q", sources: 3, provider, model: "m", costUsd, error: null, ...extra });

  test("reported costs count as settled spend", () => {
    const spend = spendFromLedgers(webSearchLedger({ searchProvider: "openrouter", searches: [search("openrouter", 0.012), search("openrouter", 0.018)], searchIndex: 2 }));
    expect(spend.aiSearchUsd).toBe(0.03);
    expect(spend.settledUsd).toBe(0.03);
    expect(spend.reservedUsd).toBe(0);
  });

  test("a search under way is held at its estimate until it reports; one whose cost never came back counts at its estimate", () => {
    const underWay = spendFromLedgers(webSearchLedger({ searchProvider: "aimlapi", searches: [search("aimlapi", 0.01)], searchIndex: 1, searchStarted: 1, searchEstimateUsd: AI_SEARCH_ESTIMATE_USD }));
    expect(underWay.reservedUsd).toBe(AI_SEARCH_ESTIMATE_USD);
    expect(underWay.totalUsd).toBe(0.06);
    expect(underWay.settledUsd).toBe(0.01);
    const lost = spendFromLedgers(webSearchLedger({ searchProvider: "openrouter", searches: [search(null, null, { error: "interrupted", estimateUsd: 0.05 }), search("openrouter", null)], searchIndex: 2, searchStarted: 1 }));
    expect(lost.aiSearchUsd).toBe(0.1);
    expect(lost.uncertainUsd).toBe(0.1);
    expect(lost.reservedUsd).toBe(0);
  });

  test("Tavily counts one credit per search made (and one under way), not per query planned; TinyFish is free", () => {
    const tavily = spendFromLedgers(webSearchLedger({ searchProvider: "tavily", searches: [search("tavily", null), search(null, null, { error: "timeout" })], searchIndex: 2, searchStarted: 2 }));
    expect(tavily.tavilyCredits).toBe(3);
    expect(tavily.totalUsd).toBe(0);
    const notYet = spendFromLedgers(webSearchLedger({ searchProvider: "tavily", searches: [], searchIndex: 0 }));
    expect(notYet.tavilyCredits).toBe(0);
    const free = spendFromLedgers(webSearchLedger({ searchProvider: "tinyfish", searches: [search("tinyfish", 0), search("tinyfish", 0)], searchIndex: 2, searchStarted: 1 }));
    expect(free.totalUsd).toBe(0);
    expect(free.tavilyCredits).toBe(0);
  });

  test("a TinyFish wait (searchStarted -1) holds nothing", () => {
    expect(webSearchLedger({ searchProvider: "openrouter", searches: [], searchIndex: 0, searchStarted: -1 })).toEqual([]);
  });
});

describe("the driver: wait, continue or stop", () => {
  const facts = (over: Partial<DriverFacts> = {}): DriverFacts => ({
    status: "active",
    now: NOW,
    deadline: minutes(120),
    leadTarget: 25,
    leads: 10,
    spendCapUsd: 5,
    spentUsd: 0,
    openChildren: 0,
    followUpsPending: 0,
    threadBusy: false,
    continuation: null,
    newSearches: 0,
    waitRefusals: [],
    refusals: [],
    dry: 0,
    pausedAt: null,
    ...over,
  });
  const turn = (over: Partial<Continuation> = {}): Continuation => ({
    n: 1, attempt: 1, startedAt: minutes(-5).toISOString(), endedAt: minutes(-1).toISOString(), end: "done", leadsAtStart: 10, judged: null, waitUntil: null, ...over,
  });

  test("a turn the owner paused part way through is not a source exhausted: after the resume the request continues, and the paused turn is not counted as dry", () => {
    const paused = turn({ startedAt: minutes(-5).toISOString(), endedAt: minutes(-4).toISOString() });
    const refused = ["Not started: the research for this request is paused; it continues when the owner resumes it."];
    expect(nextDriverStep(facts({ continuation: paused, refusals: refused, pausedAt: minutes(-4.5).toISOString(), dry: 1 }))).toEqual({ kind: "continue", n: 2, attempt: 1, dry: 1 });
    // The model read the pause and started nothing at all: the same.
    expect(nextDriverStep(facts({ continuation: paused, pausedAt: minutes(-4.5).toISOString() }))).toEqual({ kind: "continue", n: 2, attempt: 1, dry: 0 });
    // A pause before the turn began says nothing about it.
    expect(nextDriverStep(facts({ continuation: paused, refusals: ["Not started: no source fits"], pausedAt: minutes(-30).toISOString() }))).toMatchObject({ kind: "stop", reason: "sources_exhausted" });
  });

  test("searches still running: wait", () => {
    expect(nextDriverStep(facts({ openChildren: 2 }))).toMatchObject({ kind: "wait" });
    expect(nextDriverStep(facts({ followUpsPending: 1 }))).toMatchObject({ kind: "wait" });
    expect(nextDriverStep(facts({ threadBusy: true }))).toMatchObject({ kind: "wait" });
  });

  test("the request's searches are done and the target is not met: the first continuation", () => {
    expect(nextDriverStep(facts())).toEqual({ kind: "continue", n: 1, attempt: 1, dry: 0 });
  });

  test("a limit stops it, even with searches running", () => {
    expect(nextDriverStep(facts({ leads: 25, openChildren: 1 }))).toMatchObject({ kind: "stop", reason: "target_reached" });
    expect(nextDriverStep(facts({ spentUsd: 5 }))).toMatchObject({ kind: "stop", reason: "budget_spent" });
    expect(nextDriverStep(facts({ deadline: minutes(-1) }))).toMatchObject({ kind: "stop", reason: "time_limit" });
  });

  test("paused: nothing new starts, but the time limit still ends it", () => {
    expect(nextDriverStep(facts({ status: "paused" }))).toMatchObject({ kind: "wait" });
    expect(nextDriverStep(facts({ status: "paused", deadline: minutes(-1) }))).toMatchObject({ kind: "stop", reason: "time_limit" });
  });

  test("a continuation turn still working: wait for it", () => {
    expect(nextDriverStep(facts({ threadBusy: true, continuation: turn({ endedAt: null, end: null }) }))).toMatchObject({ kind: "wait" });
  });

  test("a continuation turn whose process stopped: taken again, a bounded number of times", () => {
    expect(nextDriverStep(facts({ continuation: turn({ endedAt: null, end: null }) }))).toEqual({ kind: "continue", n: 1, attempt: 2, dry: 0 });
    expect(nextDriverStep(facts({ continuation: turn({ endedAt: null, end: null, attempt: 3 }) }))).toMatchObject({ kind: "stop", reason: "failed" });
  });

  test("a continuation the model could not answer: retried after a pause, then a recorded failure", () => {
    expect(nextDriverStep(facts({ continuation: turn({ end: "failed", endedAt: NOW.toISOString() }) }))).toMatchObject({ kind: "wait" });
    expect(nextDriverStep(facts({ continuation: turn({ end: "failed", endedAt: minutes(-10).toISOString() }) }))).toEqual({ kind: "continue", n: 1, attempt: 2, dry: 0 });
    expect(nextDriverStep(facts({ continuation: turn({ end: "no_ai", attempt: 3 }) }))).toMatchObject({ kind: "stop", reason: "failed" });
  });

  test("a continuation that started a search is productive: watch it", () => {
    expect(nextDriverStep(facts({ newSearches: 1, openChildren: 1, continuation: turn() }))).toEqual({ kind: "judge", judged: "productive", waitUntil: null });
  });

  test("a continuation that started nothing: the sources are exhausted, with the refusal it met", () => {
    const step = nextDriverStep(facts({ continuation: turn(), refusals: ["LinkedIn search is not available: no account"] }));
    expect(step).toMatchObject({ kind: "stop", reason: "sources_exhausted" });
    expect(step.kind === "stop" ? step.detail : "").toMatch(/LinkedIn search is not available/);
  });

  test("a continuation refused only for a full slot or a quota wait: wait and try again, not exhausted", () => {
    const step = nextDriverStep(facts({ continuation: turn(), waitRefusals: ["2 website searches are already running"] }));
    expect(step).toMatchObject({ kind: "judge", judged: "waiting" });
    const waiting = turn({ judged: "waiting", waitUntil: minutes(5).toISOString() });
    expect(nextDriverStep(facts({ continuation: waiting }))).toMatchObject({ kind: "wait" });
    expect(nextDriverStep(facts({ continuation: { ...waiting, waitUntil: minutes(-1).toISOString() } }))).toEqual({ kind: "continue", n: 2, attempt: 1, dry: 1 });
  });

  test("after a productive continuation: the next one, and two in a row without a new lead end it", () => {
    expect(nextDriverStep(facts({ leads: 14, continuation: turn({ judged: "productive" }) }))).toEqual({ kind: "continue", n: 2, attempt: 1, dry: 0 });
    expect(nextDriverStep(facts({ leads: 10, continuation: turn({ judged: "productive" }) }))).toEqual({ kind: "continue", n: 2, attempt: 1, dry: 1 });
    expect(nextDriverStep(facts({ leads: 10, dry: 1, continuation: turn({ judged: "productive" }) }))).toMatchObject({ kind: "stop", reason: "sources_exhausted" });
  });

  test("a wait never sleeps past the time limit", () => {
    const step = nextDriverStep(facts({ openChildren: 1, deadline: new Date(NOW.getTime() + 5_000) }));
    expect(step.kind === "wait" ? step.delayMs : 0).toBeLessThanOrEqual(6_000);
  });
});

describe("wording", () => {
  const sources = [
    { label: "Google Maps through the built-in scraper", searches: 2, found: 31, eligible: 12, notSearched: 0, failed: 0, open: 0, notes: [] },
    { label: "Instagram through Apify", searches: 1, found: 0, eligible: 0, notSearched: 1, failed: 0, open: 0, notes: ["no Apify run slot came free within 6 hours"] },
  ];
  const spend = spendFromLedgers([{ ledger: "apify", status: "succeeded", usageUsd: 0.42, maxChargeUsd: 2 }]);

  test("the continuation note gives found vs target, spend and time left, and each source's yield", () => {
    const note = continuationNote({ request: "find dentists in Pune", n: 2, leads: 12, leadTarget: 25, spend, spendCapUsd: 5, msLeft: 130 * 60_000, sources, web: { searches: 3, pagesRead: 4 } });
    expect(note).toMatch(/12 of 25/);
    expect(note).toMatch(/\$0\.42 of \$5\.00/);
    expect(note).toMatch(/2 h 10 min/);
    expect(note).toMatch(/Google Maps through the built-in scraper: 2 searches, 31 found, 12 can be contacted/);
    expect(note).toMatch(/Instagram through Apify: 1 not searched \(no Apify run slot/);
    expect(note).toMatch(/3 web searches, 4 pages read/);
  });

  test("the report: sources, leads and routes, spend, the remaining target and the exact stop reason", () => {
    const text = objectiveReportText({
      request: "find dentists in Pune",
      reason: "time_limit",
      detail: "the 4 h time limit passed",
      leads: 12,
      leadTarget: 25,
      routes: { email: 9, whatsapp: 5, linkedin: 0, instagram: 1 },
      spend,
      spendCapUsd: 5,
      sources,
      web: null,
      stillRunning: 1,
    });
    expect(text).toMatch(/^Research stopped: the 4 h time limit passed/);
    expect(text).toMatch(/12 qualified leads of the 25 wanted; 13 still to find/);
    expect(text).toMatch(/9 by email, 5 by WhatsApp or phone, 1 on Instagram/);
    expect(text).toMatch(/Recorded spend: \$0\.42 of the \$5\.00 cap \(Apify \$0\.42\)/);
    expect(text).toMatch(/1 search still running when it stopped/);
    expect(text).toMatch(/kept/);
  });

  test("a reached target says so, and nothing is left to find", () => {
    const text = objectiveReportText({ request: "x", reason: "target_reached", detail: "", leads: 26, leadTarget: 25, routes: { email: 26, whatsapp: 0, linkedin: 0, instagram: 0 }, spend: spendFromLedgers([]), spendCapUsd: 5, sources, web: null, stillRunning: 0 });
    expect(text).toMatch(/^Research finished: the target was reached/);
    expect(text).toMatch(/26 qualified leads of the 25 wanted\./);
    expect(text).toMatch(/Recorded spend: \$0\.00/);
  });

  test("the report says what the cap counts, keeps Tavily in credits, and never claims nothing was spent when something was", () => {
    const tavily = spendFromLedgers([{ ledger: "tavily_job", credits: 4 }, { ledger: "ai_search", costUsd: 0.05, state: "uncertain" }]);
    const text = objectiveReportText({ request: "x", reason: "sources_exhausted", detail: "", leads: 3, leadTarget: 25, routes: { email: 3, whatsapp: 0, linkedin: 0, instagram: 0 }, spend: tavily, spendCapUsd: 5, sources, web: null, stillRunning: 0 });
    expect(text).toMatch(/\$0\.05 of the \$5\.00 cap \(AI web research \$0\.05, \$0\.05 counted at an estimate because the provider did not report the cost\); 4 Tavily credits, limited by your daily Tavily cap/);
    expect(text).toMatch(/AI model's own use for chat and writing is not in this figure/);
    const freeOnly = objectiveReportText({ request: "x", reason: "sources_exhausted", detail: "", leads: 0, leadTarget: 25, routes: { email: 0, whatsapp: 0, linkedin: 0, instagram: 0 }, spend: spendFromLedgers([]), spendCapUsd: 0, sources, web: null, stillRunning: 0 });
    expect(freeOnly).toMatch(/Recorded spend: nothing \(free sources only\)/);
    const note = continuationNote({ request: "x", n: 1, leads: 0, leadTarget: 25, spend: spendFromLedgers([{ ledger: "treg", status: "succeeded", costUsd: 0.02, ceilingUsd: 0.5 }]), spendCapUsd: 0, msLeft: 60_000, sources, web: null });
    expect(note).toMatch(/Spent \$0\.02 \(free sources only/);
    expect(note).not.toMatch(/Spent nothing/);
  });

  test("Activity's request spend line", () => {
    expect(requestSpendLine(1.2, 5)).toBe("$1.20 of $5.00 spent");
    expect(requestSpendLine(0, 0)).toBe("free sources only, nothing spent");
  });

  test("a source's recorded reason is said once, and cut at a word", () => {
    expect(reasonText("Facebook was not searched: Apify was not used: an earlier attempt to start this Apify run lost its answer.")).toBe("Apify was not used: an earlier attempt to start this Apify run lost its answer");
    const long = reasonText(`Not searched: ${"a very long reason ".repeat(20)}`, 60);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long).not.toMatch(/ …$/);
  });

  test("outcomes and report keys", () => {
    expect(outcomeOf("target_reached")).toBe("completed");
    expect(outcomeOf("time_limit")).toBe("partial");
    expect(outcomeOf("cancelled")).toBe("cancelled");
    expect(outcomeOf("failed")).toBe("failed");
    expect(objectiveReportKey("abc", "budget_spent")).toBe("assistant_objective:abc:budget_spent");
  });
});
