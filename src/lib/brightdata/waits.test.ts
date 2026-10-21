import { expect, test } from "bun:test";
import { brightdataRetryAfterMs, brightdataTaskWaitMs } from "./waits";

const since = "2026-10-21T10:00:00.000Z";
const began = Date.parse(since);
const minute = 60_000;

test("a provider's 30-minute Retry-After remains 30 minutes in the collection ledger", () => {
  expect(brightdataRetryAfterMs(30 * minute)).toBe(30 * minute);
  expect(brightdataRetryAfterMs(null)).toBe(minute);
});

test("a wait longer than the research deadline wakes to stop, rather than to resend early", () => {
  expect(brightdataTaskWaitMs(since, began, 30 * minute)).toBe(20 * minute);
  expect(brightdataTaskWaitMs(since, began + 20 * minute, 10 * minute)).toBeNull();
  expect(brightdataTaskWaitMs(since, began + 30 * minute, 0)).toBeNull();
});

test("ordinary waits preserve Retry-After and never oversleep the remaining deadline", () => {
  expect(brightdataTaskWaitMs(since, began, 2 * minute)).toBe(2 * minute);
  expect(brightdataTaskWaitMs(since, began + 19 * minute, 2 * minute)).toBe(minute);
  expect(brightdataTaskWaitMs(since, began + 20 * minute - 500, null)).toBe(500);
});
