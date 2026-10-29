import { describe, expect, test } from "bun:test";
import { prospectsRequest, reportAudiences, reportLinks, searchListOf, viewLeadsLabel, workCounts } from "./leadLists";

describe("viewLeadsLabel", () => {
  test("shows the contactable count when it is known", () => {
    expect(viewLeadsLabel(5)).toBe("View leads (5)");
    expect(viewLeadsLabel(0)).toBe("View leads (0)");
    expect(viewLeadsLabel(1234)).toBe("View leads (1,234)");
  });

  test("without a count it still reads as the control", () => {
    expect(viewLeadsLabel(null)).toBe("View leads");
    expect(viewLeadsLabel(undefined)).toBe("View leads");
    expect(viewLeadsLabel(Number.NaN)).toBe("View leads");
    expect(viewLeadsLabel(-1)).toBe("View leads");
  });
});

describe("prospectsRequest: opening a list only reads", () => {
  test("a GET of that list's prospects, never cached, with no method or body", () => {
    const { url, init } = prospectsRequest("3f1c2b9e-0000-4000-8000-000000000001");
    expect(url).toBe("/api/assistant/audiences/3f1c2b9e-0000-4000-8000-000000000001/prospects");
    expect(init).toEqual({ cache: "no-store" });
    expect("method" in init).toBe(false);
    expect("body" in init).toBe(false);
  });

  test("the id is encoded into the path", () => {
    expect(prospectsRequest("a/b").url).toBe("/api/assistant/audiences/a%2Fb/prospects");
  });
});

const search = { type: "job" as const, kind: "discovery", state: "completed" as const, audienceId: "aud-1", eligible: 5, found: 7, counts: null };

describe("searchListOf: which request rows offer their own list", () => {
  test("a finished search with a list, counted by its contactable leads", () => {
    expect(searchListOf(search)).toEqual({ audienceId: "aud-1", count: 5 });
    expect(searchListOf({ ...search, state: "partial", kind: "web_discovery" })).toEqual({ audienceId: "aud-1", count: 5 });
    expect(searchListOf({ ...search, eligible: null, kind: "social_research" })).toEqual({ audienceId: "aud-1", count: null });
  });

  test("nothing for a search still running, failed, cancelled or not searched, or without a list", () => {
    for (const state of ["queued", "executing", "failed", "cancelled", "not_searched", "stale"] as const) expect(searchListOf({ ...search, state })).toBeNull();
    expect(searchListOf({ ...search, audienceId: null })).toBeNull();
  });

  test("nothing for a plan, a lead request's driver or the job that starts outreach", () => {
    expect(searchListOf({ ...search, type: "plan" })).toBeNull();
    expect(searchListOf({ ...search, kind: "objective" })).toBeNull();
    expect(searchListOf({ ...search, kind: "outreach_start" })).toBeNull();
  });
});

describe("workCounts", () => {
  test("a search's contactable leads are called contactable, as on its card and in the report, never new", () => {
    expect(workCounts(search)).toBe("7 Found · 5 Contactable");
    expect(workCounts(search)).not.toContain("new");
    expect(workCounts({ ...search, matching: 3 })).toBe("7 Found · 5 Contactable · 3 Matching");
  });

  test("a plan's counts stay as they were", () => {
    expect(workCounts({ found: null, eligible: null, counts: { leads: 1, contacted: 1, replied: 0, failed: 0 } })).toBe("1 lead · 1 Contacted · 0 Replied");
    expect(workCounts({ found: null, eligible: null, counts: { leads: 3, contacted: 2, replied: 1, failed: 1 } })).toBe("3 leads · 2 Contacted · 1 Replied · 1 failed");
    expect(workCounts({ found: null, eligible: null, counts: null })).toBe("");
  });
});

describe("reportLinks: the final report's links", () => {
  const thread = "11111111-2222-4333-8444-555555555555";

  test("a stored report's link to the chat it is in is dropped; the saved leads link says it is every lead", () => {
    const stored = [
      { label: "Lead lists in this chat", href: `/assistant?thread=${thread}` },
      { label: "Saved leads", href: "/leads" },
    ];
    expect(reportLinks(stored, thread)).toEqual([{ label: "All saved leads", href: "/leads" }]);
  });

  test("a link to another chat or page is kept as it is", () => {
    const other = { label: "Lead lists in this chat", href: "/assistant?thread=99999999-2222-4333-8444-555555555555" };
    expect(reportLinks([other, { label: "Requests", href: "/assistant/requests" }], thread)).toEqual([other, { label: "Requests", href: "/assistant/requests" }]);
  });
});

describe("reportAudiences: the report's lists, one per search", () => {
  const jobs = [
    { id: "j1", kind: "discovery", audienceId: "a1", result: { eligible: 5 }, progress: { source: "Google Maps through the built-in scraper" } },
    { id: "j0", kind: "outreach_start", audienceId: "a1", result: null, progress: {} },
    { id: "j2", kind: "web_discovery", audienceId: "a2", result: { eligible: 2 }, progress: {} },
  ];

  test("each list with its search's contactable count and source", () => {
    expect(reportAudiences({ audienceIds: ["a1", "a2"] }, jobs)).toEqual([
      { audienceId: "a1", count: 5, title: "Google Maps through the built-in scraper" },
      { audienceId: "a2", count: 2, title: "Website and directory search" },
    ]);
  });

  test("a list whose search is not loaded still opens, without a count", () => {
    expect(reportAudiences({ audienceIds: ["a3"] }, jobs)).toEqual([{ audienceId: "a3", count: null, title: null }]);
  });

  test("nothing for an event without lists; ids that are not strings and repeats are dropped", () => {
    expect(reportAudiences(undefined, jobs)).toEqual([]);
    expect(reportAudiences({ audienceIds: "a1" }, jobs)).toEqual([]);
    expect(reportAudiences({ audienceIds: [7, "a2", "a2", ""] }, jobs)).toEqual([{ audienceId: "a2", count: 2, title: "Website and directory search" }]);
  });
});
