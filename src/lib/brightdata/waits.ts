import { BRIGHTDATA_LIMITS } from "./catalog";

export const DEFAULT_BRIGHTDATA_WAIT_MS = 60_000;

/** A provider's not-before delay must never be shortened to our polling interval. */
export function brightdataRetryAfterMs(value: number | null): number {
  return value !== null && Number.isFinite(value) ? Math.max(0, value) : DEFAULT_BRIGHTDATA_WAIT_MS;
}

/** Wait until retry is allowed, or until the research deadline ends the task. */
export function brightdataTaskWaitMs(since: string, now: number, retryAfterMs: number | null): number | null {
  const remaining = Date.parse(since) + BRIGHTDATA_LIMITS.collectionTimeoutMinutes * 60_000 - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  return Math.min(remaining, Math.max(DEFAULT_BRIGHTDATA_WAIT_MS, brightdataRetryAfterMs(retryAfterMs)));
}
