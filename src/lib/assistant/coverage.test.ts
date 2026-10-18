import { describe, expect, test } from "bun:test";
import { coverageLine, namedPlatforms, platformOfJob, requestCoverage, type CoverageJob } from "./coverage";

const job = (kind: string, status: string, extra: Partial<CoverageJob> = {}): CoverageJob => ({ kind, status, stage: null, payload: null, progress: null, result: null, error: null, ...extra });

describe("platforms an owner names", () => {
  test("the owner's own words, typos and short forms included", () => {
    expect(namedPlatforms("find leads on Google Maps, Instagram and LinkedIn")).toEqual(["google_maps", "instagram", "linkedin"]);
    expect(namedPlatforms("reach otu them in every ay possible insta email linked ai whastapp")).toEqual(["instagram", "linkedin"]);
    expect(namedPlatforms("search fb and websites")).toEqual(["facebook", "web"]);
    expect(namedPlatforms("find real estate agents in Pune")).toEqual([]);
  });
});

describe("which platform a search job covers", () => {
  test("by kind and target", () => {
    expect(platformOfJob(job("discovery", "queued", { payload: { target: "maps" } }))).toBe("google_maps");
    expect(platformOfJob(job("discovery", "queued"))).toBe("google_maps");
    expect(platformOfJob(job("discovery", "queued", { payload: { target: "facebook" } }))).toBe("facebook");
    expect(platformOfJob(job("apify_instagram", "queued"))).toBe("instagram");
    expect(platformOfJob(job("linkedin_search", "queued"))).toBe("linkedin");
    expect(platformOfJob(job("web_discovery", "queued"))).toBe("web");
    expect(platformOfJob(job("outreach_start", "queued"))).toBeNull();
  });
});

describe("a request's coverage", () => {
  const named = ["google_maps", "instagram", "linkedin"] as const;

  test("Maps done, Instagram waiting for a slot, LinkedIn not started: never complete after Maps alone", () => {
    const coverage = requestCoverage(named, [
      job("discovery", "succeeded", { result: { found: 20, eligible: 12 } }),
      job("apify_instagram", "queued", { progress: { waiting: { kind: "slot", reason: "2 Apify runs are still open" } } }),
    ]);
    expect(coverage).toEqual([
      { platform: "google_maps", state: "searched", detail: "20 found in 1 search" },
      { platform: "instagram", state: "waiting", detail: "2 Apify runs are still open" },
      { platform: "linkedin", state: "not started", detail: null },
    ]);
    expect(coverageLine(coverage)).toContain("LinkedIn — not started");
  });

  test("an Instagram search handed to website search is 'not searched', never '0 found'", () => {
    const [instagram] = requestCoverage(["instagram"], [job("apify_instagram", "succeeded", { result: { found: 0, notSearched: true, handedToJobId: "x", note: "Instagram was not searched: the budget is used up." } })]);
    expect(instagram).toEqual({ platform: "instagram", state: "not searched", detail: "Instagram was not searched: the budget is used up." });
  });

  test("several cities: partial while one still runs, failed with its error", () => {
    const [maps] = requestCoverage(["google_maps"], [
      job("discovery", "succeeded", { result: { found: 10 } }),
      job("discovery", "running"),
    ]);
    expect(maps!.state).toBe("partial");
    expect(maps!.detail).toContain("1 of 2 searches done");
    const [failed] = requestCoverage(["linkedin"], [job("linkedin_search", "failed", { error: "No LinkedIn account is connected" })]);
    expect(failed).toEqual({ platform: "linkedin", state: "failed", detail: "No LinkedIn account is connected" });
  });

  test("a request naming one platform needs no coverage line", () => {
    expect(coverageLine(requestCoverage(["instagram"], []))).toBeNull();
  });
});
