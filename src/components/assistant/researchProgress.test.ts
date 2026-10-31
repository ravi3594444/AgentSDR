import { describe, expect, test } from "bun:test";
import { hasResearchActivity, researchProgress, reviewedCounts, type ProgressMessage, type ProgressObjective } from "./researchProgress";
import { researchRow, type ResearchMessage, type ResearchJob } from "./researchView";

const now = new Date("2026-10-31T12:00:00Z");
const message = (tool: string, patch: Partial<ProgressMessage> = {}): ProgressMessage => ({ id: tool, role: "tool", tool, status: "ok", toolInput: null, toolResult: null, createdAt: "2026-10-31T11:59:00Z", ...patch });
const objective = (patch: Partial<ProgressObjective> = {}): ProgressObjective => ({ status: "active", request: "Find potential clients for website work", review: { leads: 26, match: 5, noMatch: 3, unconfirmed: 12, pending: 6, unchecked: 14 }, leadTarget: 50, targetNamed: false, leads: 5, waiting: null, nextEligibleAt: null, stopDetail: null, createdAt: "2026-10-31T11:55:00Z", stoppedAt: null, ...patch });
const model = (messages: ProgressMessage[], patch: Partial<Parameters<typeof researchProgress>[0]> = {}) => researchProgress({ messages, objective: objective(), rows: [], agentActive: true, statusKnown: true, now, ...patch });

describe("recorded research stages", () => {
  test("browser research is recognized from the brief before a provider job exists", () => {
    const messages = [message("set_brief"), message("browser_tab_open", { status: "running", toolInput: { url: "https://www.google.com/maps/search/cleaning" } })];
    expect(hasResearchActivity(messages)).toBe(true);
    expect(model(messages)).toMatchObject({ stage: "discover", phase: "working", title: "Finding candidates", action: "Opening google.com in Chrome" });
  });
  test("an ordinary WhatsApp or browser task stays out of the lead funnel", () => {
    for (const messages of [[message("browser_task"), message("browser_tab_open")], [message("set_brief"), message("browser_task"), message("browser_tab_act")]]) {
      expect(hasResearchActivity(messages)).toBe(false);
      expect(model(messages)).toBeNull();
    }
  });
  test("saving contacts or checking an older request alone is not new research", () => {
    expect(hasResearchActivity([message("add_contacts")])).toBe(false);
    expect(hasResearchActivity([message("use_existing_leads")])).toBe(false);
    expect(hasResearchActivity([message("lead_search_status")])).toBe(false);
  });
  test("reviewing evidence and then searching again can revisit discovery", () => {
    const messages = [message("set_brief"), message("web_search"), message("review_leads"), message("browser_tab_read", { status: "running" })];
    expect(model(messages)).toMatchObject({ stage: "check", action: "Reading the open page in Chrome" });
    messages.push(message("web_search", { id: "next", status: "running" }));
    expect(model(messages)).toMatchObject({ stage: "discover", phase: "working" });
    expect(model(messages)?.visited).toEqual(expect.arrayContaining(["approach", "discover", "check"]));
  });
  test("shortlisting needs recorded matching-list or plan activity", () => {
    expect(model([message("review_leads", { status: "running", toolInput: { filter: "match" } })])).toMatchObject({ stage: "shortlist", action: "Reviewing the matching candidates" });
    expect(model([message("set_lead_fit")])?.visited).not.toContain("shortlist");
  });
  test("a refused finish is not a completed results stage", () => {
    const result = model([message("review_leads"), message("finish_request", { status: "error" })]);
    expect(result?.stage).toBe("check");
    expect(result?.visited).not.toContain("results");
    expect(result?.phase).toBe("working");
  });
  test("reading an unjudged list alone does not complete the checking stage", () => {
    const result = model([message("set_brief"), message("review_leads")], { objective: objective({ review: { leads: 26, match: 0, noMatch: 0, unconfirmed: 26, pending: 0, unchecked: 26 } }) });
    expect(result?.visited).not.toContain("check");
  });
  test("a native session between tool calls remains active, and preparing the final answer is explicit", () => {
    expect(model([message("set_brief"), message("set_lead_fit")])).toMatchObject({ phase: "working", title: "Researching" });
    expect(model([message("set_brief"), message("finish_request")])).toMatchObject({ stage: "results", phase: "working", title: "Preparing results" });
  });
  test("an active objective with no running work is a wait, not fake activity or completion", () => {
    expect(model([message("set_brief"), message("set_lead_fit")], { agentActive: false, objective: objective({ waiting: "Waiting for the next source slot", nextEligibleAt: "2026-10-31T12:01:00Z" }) })).toMatchObject({ phase: "waiting", title: "Research continues", action: "Waiting for the next source slot", nextAt: "2026-10-31T12:01:00Z" });
  });
  test("a status-read failure wins over stale running tools, while pause wins over active flags", () => {
    const messages = [message("set_brief"), message("browser_tab_open", { status: "running" })];
    expect(model(messages, { statusKnown: false })).toMatchObject({ phase: "unknown", title: "Live status unavailable" });
    expect(model(messages, { objective: objective({ status: "paused" }) })).toMatchObject({ phase: "paused", title: "Research paused" });
  });
  test("a stopped request shows the recorded outcome and freezes elapsed time", () => {
    expect(model([message("set_brief"), message("set_lead_fit")], { agentActive: false, objective: objective({ status: "stopped", stoppedAt: "2026-10-31T11:58:00Z", stopDetail: "Time limit reached; 14 candidates remain unchecked" }) })).toMatchObject({ stage: "results", phase: "finished", action: "Time limit reached; 14 candidates remain unchecked", elapsedMs: 180_000, review: { remaining: 14 } });
  });
  test("the model's saved approach is shown as a recorded choice and failed updates do not replace it", () => {
    const messages = [message("set_brief", { toolResult: { data: { brief: { approach: "Compare local businesses with manual booking workflows" } } } }), message("set_brief", { status: "error", toolResult: { data: { brief: { approach: "Not saved" } } } })];
    expect(model(messages)?.approach).toBe("Compare local businesses with manual booking workflows");
  });
  test("targets come from the server and remain labelled as defaults when the owner named none", () => {
    expect(model([message("set_brief")], { objective: objective({ leadTarget: 80, leads: 7 }) })?.target).toEqual({ total: 80, matched: 7, named: false });
    expect(model([message("set_brief")], { objective: objective({ leads: Number.NaN }) })?.target).toBeNull();
  });
  test("ordinary provider waits remain informational, and one failed source does not fail the request", () => {
    const source: ResearchMessage = { ...message("find_leads"), status: "ok", content: "", toolInput: null, toolResult: { data: { jobId: "job" } } };
    const job: ResearchJob = { id: "job", kind: "discovery", status: "queued", stage: "queued", progress: {}, result: null, error: null, audienceId: null, runAfter: "2026-10-31T12:01:00Z" };
    const row = researchRow(source, job, now);
    expect(model([message("web_search", { status: "error" })], { agentActive: false, rows: [row] })).toMatchObject({ phase: "waiting", stage: "discover" });
    const qualifying = researchRow(source, { ...job, status: "running", stage: "qualifying", progress: { stage: "qualifying", judged: 2, toJudge: 6 } }, now);
    expect(model([], { agentActive: false, rows: [qualifying] })).toMatchObject({ phase: "working", stage: "check", title: "Checking potential clients" });
    const blocked = { ...row, phase: "needs_you" as const, label: "Needs you" };
    expect(model([], { agentActive: false, rows: [blocked, qualifying] })).toMatchObject({ phase: "working", title: "Checking potential clients" });
  });
});

describe("review progress is a count of checked people", () => {
  test("judge-only unconfirmed and pending candidates do not count as reviewed", () => {
    expect(reviewedCounts(objective().review)).toEqual({ total: 26, reviewed: 12, uncertain: 4, excluded: 3, remaining: 14 });
    expect(reviewedCounts({ leads: 26, match: 0, noMatch: 0, unconfirmed: 26, pending: 0, unchecked: 26 })).toMatchObject({ reviewed: 0, uncertain: 0, remaining: 26 });
  });
  test("unknown or inconsistent counters stay unknown instead of appearing as zero", () => {
    expect(reviewedCounts(undefined)).toBeNull();
    expect(reviewedCounts({ leads: 2, match: 2, noMatch: 0, unconfirmed: 0, pending: 0, unchecked: 1 })).toBeNull();
    expect(reviewedCounts({ leads: -1, match: 0, noMatch: 0, unconfirmed: 0, pending: 0, unchecked: 0 })).toBeNull();
  });
});
