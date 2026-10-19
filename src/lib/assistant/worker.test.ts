import { describe, expect, test } from "bun:test";
import { jobErrorText, mergeJobProgress, pastClaimCeiling, retryDelayMs } from "./worker";

describe("a step's progress over the job's", () => {
  const queued = { stage: "queued", found: 0, source: "Instagram (Apify)" };
  const slot = { kind: "slot", provider: "apify", reason: "both Apify runs are in use; it starts when one finishes" };

  test("a wait reported earlier is dropped once a step reports progress without it", () => {
    const waited = mergeJobProgress(queued, { stage: "queued", found: 0, source: "Instagram (Apify)", waiting: slot });
    expect(waited.waiting).toEqual(slot);
    const started = mergeJobProgress(waited, { stage: "searching", provider: "Apify", actor: "Instagram search" });
    expect(started).toEqual({ stage: "searching", found: 0, source: "Instagram (Apify)", provider: "Apify", actor: "Instagram search" });
    const enriching = mergeJobProgress(started, { stage: "enriching", provider: "Apify", found: 4, websitesChecked: 0 });
    expect("waiting" in enriching).toBe(false);
  });

  test("a step that waits again keeps the wait, with its latest reason", () => {
    const first = mergeJobProgress(queued, { waiting: slot });
    const again = mergeJobProgress(first, { stage: "queued", waiting: { ...slot, reason: "still in use" } });
    expect(again.waiting).toEqual({ ...slot, reason: "still in use" });
  });

  test("a step that reports no progress leaves the job's as it was", () => {
    const waited = { ...queued, waiting: slot };
    expect(mergeJobProgress(waited, undefined)).toBe(waited);
  });

  test("an earlier step's error is dropped once a step completes without one, with or without progress", () => {
    const failedOnce = { ...queued, lastError: "socket hang up" };
    expect(mergeJobProgress(failedOnce, undefined)).toEqual(queued);
    expect(mergeJobProgress(failedOnce, { stage: "searching", provider: "Apify" })).toEqual({ ...queued, stage: "searching", provider: "Apify" });
  });

  test("a step that failed keeps its error for the retry", () => {
    const failedOnce = { ...queued, lastError: "socket hang up" };
    expect(mergeJobProgress(failedOnce, undefined, { stepFailed: true })).toEqual(failedOnce);
    expect(mergeJobProgress(queued, { lastError: "timeout" }, { stepFailed: true })).toEqual({ ...queued, lastError: "timeout" });
  });
});

describe("a step that fails or cannot be saved", () => {
  test("its error is kept clean and short enough to save", () => {
    expect(jobErrorText(new Error("bad\u0000byte"))).toBe("badbyte");
    expect(jobErrorText("lone \ud800 surrogate")).toBe("lone \ufffd surrogate");
    const long = jobErrorText(new Error("x".repeat(5_000)));
    expect(long.length).toBe(2_000);
    expect(long.endsWith("…")).toBe(true);
  });

  test("a failed query keeps the database's reason, never the statement and the values it carried", () => {
    const failed = new Error("Failed query: update \"assistant_jobs\" set \"payload\" = $1\nparams: {\"email\":\"lead@example.com\"}", { cause: new Error("value too long for type character varying(20)") });
    expect(jobErrorText(failed)).toBe("value too long for type character varying(20)");
    expect(jobErrorText(new Error("Failed query: select 1"))).toBe("Failed query: select 1");
  });

  test("its retry backs off and is never more than a minute away", () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  test("a job claimed again and again without a saved step stops at the ceiling, past where failures end on their own", () => {
    // Failed steps and refused saves end the job at the fifth attempt; the ceiling is beyond that.
    expect(pastClaimCeiling(5)).toBe(false);
    expect(pastClaimCeiling(7)).toBe(false);
    expect(pastClaimCeiling(8)).toBe(true);
  });
});
