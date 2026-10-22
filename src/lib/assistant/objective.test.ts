import { describe, expect, test } from "bun:test";
import {
  AI_SEARCH_ESTIMATE_USD,
  continuationNote,
  judgeRequestText,
  waitsForOwner,
  limitReached,
  MAX_CONTINUATION_ATTEMPTS,
  MAX_QUALIFY_ATTEMPTS,
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
    pendingMembers: 0,
    qualifyFailures: 0,
    ...over,
  });
  const turn = (over: Partial<Continuation> = {}): Continuation => ({
    n: 1, attempt: 1, startedAt: minutes(-5).toISOString(), endedAt: minutes(-1).toISOString(), end: "done", leadsAtStart: 10, judged: null, waitUntil: null, ...over,
  });

  test("leads not yet judged against the request are judged before the count decides anything", () => {
    expect(nextDriverStep(facts({ pendingMembers: 30 }))).toEqual({ kind: "qualify" });
    // A finished turn that only added a list is judged first, not taken as a source exhausted.
    expect(nextDriverStep(facts({ pendingMembers: 4, continuation: turn() }))).toEqual({ kind: "qualify" });
    // Searches still running judge their own leads.
    expect(nextDriverStep(facts({ pendingMembers: 30, openChildren: 1 })).kind).toBe("wait");
    // After the attempts are used, those leads stay uncounted and the request goes on.
    expect(nextDriverStep(facts({ pendingMembers: 30, qualifyFailures: MAX_QUALIFY_ATTEMPTS })).kind).toBe("continue");
    // A target already met stops first; a paused request waits.
    expect(nextDriverStep(facts({ pendingMembers: 30, leads: 25 })).kind).toBe("stop");
    expect(nextDriverStep(facts({ pendingMembers: 30, status: "paused" })).kind).toBe("wait");
  });

  test("50 contactable profiles of which 3 match do not complete a target of 25", () => {
    expect(limitReached({ now: NOW, deadline: minutes(120), leadTarget: 25, leads: 3, spendCapUsd: 5, spentUsd: 0 })).toBeNull();
    expect(nextDriverStep(facts({ leads: 3, continuation: turn({ leadsAtStart: 3 }), newSearches: 1 }))).toEqual({ kind: "judge", judged: "productive", waitUntil: null });
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

  test("research agent v2: a limit wakes the assistant once (to plan from what matched and finish), then the request stops", () => {
    const v2 = { wakeAtLimit: true, leadTarget: 5, leads: 5 };
    expect(nextDriverStep(facts(v2))).toEqual({ kind: "continue", n: 1, attempt: 1, dry: 0, final: "target_reached", finalDetail: "5 qualified leads found, the target was 5" });
    expect(nextDriverStep(facts({ ...v2, threadBusy: true })).kind).toBe("wait");
    // That turn running, then ended: it stops at the limit.
    expect(nextDriverStep(facts({ ...v2, threadBusy: true, continuation: turn({ final: "target_reached", endedAt: null, end: null }) }))).toMatchObject({ kind: "wait", delayMs: 15_000 });
    expect(nextDriverStep(facts({ ...v2, continuation: turn({ final: "target_reached" }) }))).toMatchObject({ kind: "stop", reason: "target_reached" });
    // An earlier turn that did not start at a limit does not count as that turn.
    expect(nextDriverStep(facts({ ...v2, continuation: turn({ n: 2, leadsAtStart: 3 }) }))).toMatchObject({ kind: "continue", n: 3, attempt: 1, dry: 0, final: "target_reached" });
    // Interrupted: taken again, a bounded number of times.
    expect(nextDriverStep(facts({ ...v2, continuation: turn({ final: "target_reached", endedAt: null, end: null }) }))).toMatchObject({ kind: "continue", n: 1, attempt: 2, dry: 0, final: "target_reached" });
    expect(nextDriverStep(facts({ ...v2, continuation: turn({ final: "target_reached", endedAt: null, end: null, attempt: MAX_CONTINUATION_ATTEMPTS }) }))).toMatchObject({ kind: "stop", reason: "target_reached" });
    // The spend cap and the time limit wake it the same way: six of ten matched still get their plan.
    const short = { wakeAtLimit: true, leadTarget: 10, leads: 6 };
    expect(nextDriverStep(facts({ ...short, spentUsd: 5 }))).toMatchObject({ kind: "continue", n: 1, attempt: 1, dry: 0, final: "budget_spent" });
    expect(nextDriverStep(facts({ ...short, deadline: minutes(-1), continuation: turn({ n: 3, leadsAtStart: 6 }) }))).toMatchObject({ kind: "continue", n: 4, attempt: 1, dry: 0, final: "time_limit" });
    expect(nextDriverStep(facts({ ...short, deadline: minutes(-1), continuation: turn({ n: 4, final: "time_limit" }) }))).toMatchObject({ kind: "stop", reason: "time_limit" });
    // Without v2 every limit stops at once.
    expect(nextDriverStep(facts({ leadTarget: 10, leads: 6, spentUsd: 5 }))).toMatchObject({ kind: "stop", reason: "budget_spent" });
  });

  test("research agent v2: a request that runs out of sources gets the same last turn, then stops with the reason it ran out", () => {
    // c6 of the eval: 4 of 10 Miami salons matched, the model's turn ended saying it would check more and starting nothing.
    const idle = { wakeAtLimit: true, leadTarget: 10, leads: 4, continuation: turn({ n: 2, leadsAtStart: 4 }) };
    expect(nextDriverStep(facts(idle))).toEqual({ kind: "continue", n: 3, attempt: 1, dry: 0, final: "sources_exhausted", finalDetail: "the assistant found no further source or query worth searching" });
    expect(nextDriverStep(facts({ ...idle, refusals: ["Instagram is not connected."] }))).toMatchObject({ final: "sources_exhausted", finalDetail: "no other source could be searched (Instagram is not connected)" });
    // Two dry continuations in a row: the same last turn first.
    expect(nextDriverStep(facts({ wakeAtLimit: true, leadTarget: 10, leads: 4, dry: 1, continuation: turn({ n: 2, leadsAtStart: 4, judged: "productive" }) }))).toEqual({ kind: "continue", n: 3, attempt: 1, dry: 2, final: "sources_exhausted", finalDetail: "2 continuations in a row found no new lead" });
    // That turn running, interrupted, then ended: the request stops with the recorded reason, whatever the turn did not start.
    const last = turn({ n: 3, leadsAtStart: 4, final: "sources_exhausted", finalDetail: "the assistant found no further source or query worth searching" });
    expect(nextDriverStep(facts({ ...idle, threadBusy: true, continuation: { ...last, endedAt: null, end: null } }))).toMatchObject({ kind: "wait", delayMs: 15_000 });
    expect(nextDriverStep(facts({ ...idle, continuation: { ...last, endedAt: null, end: null } }))).toEqual({ kind: "continue", n: 3, attempt: 2, dry: 0, final: "sources_exhausted", finalDetail: "the assistant found no further source or query worth searching" });
    // Its third attempt still running is waited for, not cut off; one that never ended after three is given up.
    expect(nextDriverStep(facts({ ...idle, threadBusy: true, continuation: { ...last, endedAt: null, end: null, attempt: MAX_CONTINUATION_ATTEMPTS } }))).toMatchObject({ kind: "wait" });
    expect(nextDriverStep(facts({ ...idle, continuation: { ...last, endedAt: null, end: null, attempt: MAX_CONTINUATION_ATTEMPTS } }))).toMatchObject({ kind: "stop", reason: "sources_exhausted" });
    // Paused by the owner: an interrupted last turn waits, it is not run again; a limit still ends it.
    expect(nextDriverStep(facts({ ...idle, status: "paused", continuation: { ...last, endedAt: null, end: null } }))).toMatchObject({ kind: "wait", reason: "paused by the owner" });
    expect(nextDriverStep(facts({ ...idle, status: "paused", deadline: minutes(-1), continuation: { ...last, endedAt: null, end: null } }))).toMatchObject({ kind: "stop", reason: "time_limit" });
    expect(nextDriverStep(facts({ ...idle, status: "paused", continuation: last }))).toMatchObject({ kind: "wait", reason: "paused by the owner" });
    // The model failed to answer in it: tried again after the backoff, at most three times; no AI provider ends it.
    expect(nextDriverStep(facts({ ...idle, continuation: { ...last, end: "failed", endedAt: minutes(0).toISOString() } }))).toMatchObject({ kind: "wait" });
    expect(nextDriverStep(facts({ ...idle, continuation: { ...last, end: "failed", endedAt: minutes(-5).toISOString() } }))).toEqual({ kind: "continue", n: 3, attempt: 2, dry: 0, final: "sources_exhausted", finalDetail: "the assistant found no further source or query worth searching" });
    expect(nextDriverStep(facts({ ...idle, continuation: { ...last, end: "failed", endedAt: minutes(-5).toISOString(), attempt: MAX_CONTINUATION_ATTEMPTS } }))).toMatchObject({ kind: "stop", reason: "sources_exhausted" });
    expect(nextDriverStep(facts({ ...idle, continuation: { ...last, end: "no_ai" } }))).toMatchObject({ kind: "stop", reason: "sources_exhausted" });
    expect(nextDriverStep(facts({ ...idle, continuation: last }))).toEqual({ kind: "stop", reason: "sources_exhausted", detail: "the assistant found no further source or query worth searching" });
    // A limit reached during that turn stops at the limit.
    expect(nextDriverStep(facts({ ...idle, deadline: minutes(-1), continuation: last }))).toMatchObject({ kind: "stop", reason: "time_limit" });
    // A limit's last turn that ends below the limit (the model corrected verdicts, 4 of 5 now match): not done, so the
    // request goes on as an ordinary continuation (searches allowed again), never a stop that says the target was reached.
    expect(nextDriverStep(facts({ wakeAtLimit: true, leadTarget: 5, leads: 4, continuation: turn({ n: 2, final: "target_reached", finalDetail: "5 qualified leads found, the target was 5" }) }))).toEqual({ kind: "continue", n: 3, attempt: 1, dry: 0 });
    // v1 is unchanged: an idle turn stops at once.
    expect(nextDriverStep(facts({ leadTarget: 10, leads: 4, continuation: turn({ n: 2, leadsAtStart: 4 }) }))).toMatchObject({ kind: "stop", reason: "sources_exhausted" });
    // A last turn begun because no source seemed left, in which the assistant found one and searched: it goes on.
    expect(nextDriverStep(facts({ ...idle, newSearches: 1, openChildren: 1, continuation: last }))).toMatchObject({ kind: "wait", reason: "searches still running" });
    expect(nextDriverStep(facts({ ...idle, newSearches: 1, leads: 6, continuation: last }))).toEqual({ kind: "continue", n: 4, attempt: 1, dry: 0 });
    // …but a search that found nothing new (or a paid one refused at its reservation) ends it: no cycle of last turns.
    expect(nextDriverStep(facts({ ...idle, newSearches: 1, leads: 4, continuation: last }))).toEqual({ kind: "stop", reason: "sources_exhausted", detail: "the assistant found no further source or query worth searching" });
  });

  test("the one harness: a target ends the request only when the owner gave it; a used spend cap does not end it", () => {
    // "find me leads", no number: 25 matches (the default target) is no reason to stop; the assistant decides.
    expect(limitReached({ now: minutes(0), deadline: minutes(60), leadTarget: 25, leads: 30, spendCapUsd: 5, spentUsd: 0, targetNamed: false })).toBeNull();
    expect(limitReached({ now: minutes(0), deadline: minutes(60), leadTarget: 25, leads: 30, spendCapUsd: 5, spentUsd: 0, targetNamed: true })).toMatchObject({ reason: "target_reached" });
    // The cap used: paid starts are refused at their reservation, free sources go on.
    expect(limitReached({ now: minutes(0), deadline: minutes(60), leadTarget: 25, leads: 3, spendCapUsd: 5, spentUsd: 5, budgetEnds: false })).toBeNull();
    // The time limit still ends it.
    expect(limitReached({ now: minutes(0), deadline: minutes(-1), leadTarget: 25, leads: 3, spendCapUsd: 5, spentUsd: 5, targetNamed: false, budgetEnds: false })).toMatchObject({ reason: "time_limit" });
  });

  test("research agent v2: only a question from a turn that started nothing holds the request", () => {
    // "Which city should I search in?" with no search: the request waits for the answer.
    expect(waitsForOwner({ lastWord: { role: "assistant", content: "Which city or area should I search in?" }, turnStartedSearch: false })).toBe(true);
    // Eval c3: the search started, and a side question ("do you have prices…?") must not freeze the request.
    expect(waitsForOwner({ lastWord: { role: "assistant", content: "The Austin search is running. Meanwhile, do you have prices I can mention?" }, turnStartedSearch: true })).toBe(false);
    expect(waitsForOwner({ lastWord: { role: "assistant", content: "Searching Google Maps now." }, turnStartedSearch: false })).toBe(false);
    expect(waitsForOwner({ lastWord: { role: "user", content: "Miami?" }, turnStartedSearch: false })).toBe(false);
    expect(waitsForOwner({ lastWord: undefined, turnStartedSearch: false })).toBe(false);
  });

  test("research agent v2: the judge reads the owner's own words beside the brief, so an answer's place stays in force", () => {
    // Eval c6: the brief was written before the owner answered "Miami." and never updated.
    const text = judgeRequestText("Find 10 hair salons on Instagram and DM them", ["Find 10 hair salons on Instagram and DM them", "Miami."]);
    expect(text).toContain("Find 10 hair salons on Instagram and DM them");
    expect(text).toContain("(2) Miami.");
    expect(text).toMatch(/owner's own words .* decide where they disagree/);
    // One message, the same as the goal: just the goal.
    expect(judgeRequestText("Find 5 dentists in Austin", ["Find 5 dentists in Austin"])).toBe("Find 5 dentists in Austin");
    expect(judgeRequestText("Find 5 dentists in Austin", [])).toBe("Find 5 dentists in Austin");
  });

  test("research agent v2: a question to the owner waits for the answer instead of ending the request", () => {
    expect(nextDriverStep(facts({ waitingForOwner: true, continuation: turn({ leadsAtStart: 0 }), leads: 0 })).kind).toBe("wait");
    expect(nextDriverStep(facts({ waitingForOwner: true, leads: 0 })).kind).toBe("wait");
    // The time limit still ends it.
    expect(nextDriverStep(facts({ waitingForOwner: true, deadline: minutes(-1) }))).toMatchObject({ kind: "stop", reason: "time_limit" });
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
    { label: "Google Maps through the built-in scraper", searches: 2, found: 31, eligible: 12, judged: 0, matched: 0, notSearched: 0, failed: 0, open: 0, notes: [] },
    { label: "Instagram through Apify", searches: 1, found: 0, eligible: 0, judged: 0, matched: 0, notSearched: 1, failed: 0, open: 0, notes: ["no Apify run slot came free within 6 hours"] },
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
    expect(text).toMatch(/12 qualified leads \(contactable and matching your request\) of the 25 wanted; 13 still to find/);
    expect(text).toMatch(/9 by email, 5 by WhatsApp or phone, 1 on Instagram/);
    expect(text).toMatch(/Recorded spend: \$0\.42 of the \$5\.00 cap \(Apify \$0\.42\)/);
    expect(text).toMatch(/1 search still running when it stopped/);
    expect(text).toMatch(/kept/);
  });

  test("a reached target says so, and nothing is left to find", () => {
    const text = objectiveReportText({ request: "x", reason: "target_reached", detail: "", leads: 26, leadTarget: 25, routes: { email: 26, whatsapp: 0, linkedin: 0, instagram: 0 }, spend: spendFromLedgers([]), spendCapUsd: 5, sources, web: null, stillRunning: 0 });
    expect(text).toMatch(/^Research finished: the target of 25 was reached/);
    expect(text).toMatch(/26 qualified leads \(contactable and matching your request\) of the 25 wanted\./);
    expect(text).toMatch(/Recorded spend: \$0\.00/);
  });

  test("the report says what the cap counts, keeps Tavily in credits, and never claims nothing was spent when something was", () => {
    const tavily = spendFromLedgers([{ ledger: "tavily_job", credits: 4 }, { ledger: "ai_search", costUsd: 0.05, state: "uncertain" }]);
    const text = objectiveReportText({ request: "x", reason: "sources_exhausted", detail: "", leads: 3, leadTarget: 25, routes: { email: 3, whatsapp: 0, linkedin: 0, instagram: 0 }, spend: tavily, spendCapUsd: 5, sources, web: null, stillRunning: 0 });
    expect(text).toMatch(/\$0\.05 of the \$5\.00 cap \(AI web research \$0\.05, \$0\.05 counted at an estimate because the provider did not report the cost\); 4 Tavily credits, limited by your daily Tavily cap/);
    expect(text).toMatch(/AI model's own use for chat, judging leads and writing is not in this figure/);
    const freeOnly = objectiveReportText({ request: "x", reason: "sources_exhausted", detail: "", leads: 0, leadTarget: 25, routes: { email: 0, whatsapp: 0, linkedin: 0, instagram: 0 }, spend: spendFromLedgers([]), spendCapUsd: 0, sources, web: null, stillRunning: 0 });
    expect(freeOnly).toMatch(/Recorded spend: nothing \(free sources only\)/);
    const note = continuationNote({ request: "x", n: 1, leads: 0, leadTarget: 25, spend: spendFromLedgers([{ ledger: "treg", status: "succeeded", costUsd: 0.02, ceilingUsd: 0.5 }]), spendCapUsd: 0, msLeft: 60_000, sources, web: null });
    expect(note).toMatch(/Spent \$0\.02 \(free sources only/);
    expect(note).not.toMatch(/Spent nothing/);
  });

  test("the report keeps found, contactable and matching apart, and explains leads added after the stop", () => {
    const funnel = { found: 74, contactable: 70, qualified: 26, notMatching: 40, unconfirmed: 4, pending: 0, pendingMembers: 0, noMatchReasons: [{ reason: "A software founder, not in real estate.", count: 30 }, { reason: "Outside the United States.", count: 10 }] };
    const text = objectiveReportText({ request: "x", reason: "target_reached", detail: "26 qualified leads found, the target was 25", leads: 26, leadTarget: 25, routes: { email: 4, whatsapp: 2, linkedin: 22, instagram: 0 }, spend: spendFromLedgers([]), spendCapUsd: 5, sources, web: null, stillRunning: 0, funnel, atStop: { qualified: 25 } });
    expect(text).toMatch(/26 qualified leads \(contactable and matching your request\) of the 25 wanted\. It stopped at 25; searches already running then added 1\./);
    expect(text).toMatch(/Their contact routes \(one person can have several\): 4 by email, 2 by WhatsApp or phone, 22 on LinkedIn/);
    expect(text).toMatch(/Found 74 \(70 contactable\): 26 match your request, 40 do not \(30: A software founder, not in real estate; 10: Outside the United States\), 4 unconfirmed/);
    // One total: the stop-time figure is explained, never printed as a second "qualified" count.
    expect(text.match(/qualified lead/g)?.length).toBe(1);
  });

  test("a source line says how many of its contactable leads match", () => {
    const note = continuationNote({ request: "x", n: 1, leads: 3, leadTarget: 25, spend: spendFromLedgers([]), spendCapUsd: 5, msLeft: 60_000, web: null,
      sources: [{ label: "LinkedIn people search through Unipile", searches: 1, found: 50, eligible: 50, judged: 50, matched: 3, notSearched: 0, failed: 0, open: 0, notes: [] }] });
    expect(note).toMatch(/LinkedIn people search through Unipile: 1 search, 50 found, 50 can be contacted, 3 of them match your request/);
    expect(note).toMatch(/3 of 25 qualified leads so far \(contactable and matching the request\)/);
  });

  test("research agent v2: the note names the limit that ends the request and asks for the plan from what matched", () => {
    const base = { request: "x", n: 4, leads: 6, leadTarget: 10, spend: spendFromLedgers([]), spendCapUsd: 5, msLeft: 0, sources: [], web: null, v2: true };
    expect(continuationNote({ ...base, final: "time_limit" })).toMatch(/reached its time limit with 6 of 10 matching leads \(step 4\)\. No more searches start for it\. Next: review them, prepare outreach if the owner asked to contact them, then finish_request\./);
    expect(continuationNote({ ...base, final: "budget_spent" })).toMatch(/reached its spend cap with 6 of 10/);
    expect(continuationNote({ ...base, leads: 10, final: "target_reached" })).toMatch(/has its 10 matching leads/);
    // A last turn begun because no source seemed left may still search one that fits.
    expect(continuationNote({ ...base, final: "sources_exhausted", finalDetail: "the assistant found no further source or query worth searching" })).toMatch(/found no further source to search \(the assistant found no further source or query worth searching\) with 6 of 10 matching leads \(step 4\)\. Search another source only if one fits the request; otherwise review the leads, prepare outreach if the owner asked to contact them, then finish_request\./);
    expect(continuationNote({ ...base, final: "sources_exhausted", targetNamed: false })).toContain("with 6 matching leads");
    expect(continuationNote(base)).toMatch(/have finished for now/);
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
