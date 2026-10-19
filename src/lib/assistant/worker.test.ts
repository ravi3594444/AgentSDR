import { describe, expect, test } from "bun:test";
import { mergeJobProgress } from "./worker";

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
