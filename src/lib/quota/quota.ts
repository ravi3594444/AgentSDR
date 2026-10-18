/**
 * Provider quotas: how much of a provider's own limit is left, counted per
 * quota scope (the API key, IP or OAuth client the provider counts against),
 * never per organization. Two organizations sharing a key share its quota;
 * an organization's own allowance never creates provider quota.
 *
 * The counters are fixed windows (the current UTC minute, hour and day),
 * which matches how TinyFish documents its free allowance (the day resets at
 * 00:00 UTC) and is conservative for the minute and hour limits. Besides the
 * counters, a provider can tell us to wait (a 429 with Retry-After, a used-up
 * daily allowance); that wait is recorded as `blockedUntil` and honoured by
 * every caller sharing the scope.
 *
 * Pure: quota.server.ts holds the row lock and writes.
 */

export type QuotaLimits = { perMinute?: number; perHour?: number; perDay?: number };

export type QuotaCounters = {
  minuteStart: Date | null;
  minuteUsed: number;
  hourStart: Date | null;
  hourUsed: number;
  dayStart: Date | null;
  dayUsed: number;
  blockedUntil: Date | null;
  blockedReason: string | null;
};

export type QuotaDecision =
  | { ok: true; counters: QuotaCounters }
  | { ok: false; until: Date; reason: string };

export const EMPTY_COUNTERS: QuotaCounters = {
  minuteStart: null, minuteUsed: 0, hourStart: null, hourUsed: 0, dayStart: null, dayUsed: 0, blockedUntil: null, blockedReason: null,
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The start of the UTC minute, hour and day containing `now`. */
export function windowStarts(now: Date): { minute: Date; hour: Date; day: Date } {
  const t = now.getTime();
  return { minute: new Date(t - (t % MINUTE)), hour: new Date(t - (t % HOUR)), day: new Date(t - (t % DAY)) };
}

const same = (a: Date | null, b: Date) => a !== null && a.getTime() === b.getTime();

/** The counters as of `now`: a window that has passed starts again from 0, an expired wait is gone. */
export function rolled(counters: QuotaCounters, now: Date): QuotaCounters {
  const w = windowStarts(now);
  const blocked = counters.blockedUntil && counters.blockedUntil.getTime() > now.getTime();
  return {
    minuteStart: w.minute, minuteUsed: same(counters.minuteStart, w.minute) ? counters.minuteUsed : 0,
    hourStart: w.hour, hourUsed: same(counters.hourStart, w.hour) ? counters.hourUsed : 0,
    dayStart: w.day, dayUsed: same(counters.dayStart, w.day) ? counters.dayUsed : 0,
    blockedUntil: blocked ? counters.blockedUntil : null,
    blockedReason: blocked ? counters.blockedReason : null,
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Whether `units` more may be used now. When yes, the counters with them
 * added; when no, the earliest time they could fit and why. A request larger
 * than a whole window can never fit and says so.
 */
export function quotaDecision(counters: QuotaCounters, limits: QuotaLimits, units: number, now: Date, label: string): QuotaDecision {
  const current = rolled(counters, now);
  if (current.blockedUntil) return { ok: false, until: current.blockedUntil, reason: current.blockedReason ?? `${label} asked us to wait` };
  const checks: [number | undefined, number, Date, number, string][] = [
    [limits.perMinute, current.minuteUsed, current.minuteStart!, MINUTE, "a minute"],
    [limits.perHour, current.hourUsed, current.hourStart!, HOUR, "an hour"],
    [limits.perDay, current.dayUsed, current.dayStart!, DAY, "a day (UTC)"],
  ];
  for (const [limit, used, start, length, per] of checks) {
    if (limit === undefined) continue;
    if (units > limit) return { ok: false, until: new Date(8.64e15), reason: `${label}: ${plural(units, "unit")} at once exceeds the limit of ${limit} ${per}` };
    if (used + units > limit) {
      return { ok: false, until: new Date(start.getTime() + length), reason: `${label}: the free limit of ${limit} ${per} is used (${used} so far)` };
    }
  }
  return {
    ok: true,
    counters: { ...current, minuteUsed: current.minuteUsed + units, hourUsed: current.hourUsed + units, dayUsed: current.dayUsed + units },
  };
}

/**
 * Gives back units reserved at `reservedAt` that were not used: only from the
 * windows that are still the same ones (a passed window already forgot them).
 */
export function released(counters: QuotaCounters, units: number, reservedAt: Date): QuotaCounters {
  if (units <= 0) return counters;
  const w = windowStarts(reservedAt);
  const back = (start: Date | null, at: Date, used: number) => (same(start, at) ? Math.max(0, used - units) : used);
  return {
    ...counters,
    minuteUsed: back(counters.minuteStart, w.minute, counters.minuteUsed),
    hourUsed: back(counters.hourStart, w.hour, counters.hourUsed),
    dayUsed: back(counters.dayStart, w.day, counters.dayUsed),
  };
}

/** What a provider's refusal says about waiting: until when, and why. Null when it is not a wait. */
export type ProviderRefusal = { status: number | null; code?: string | null; retryAfterMs?: number | null; resetAt?: Date | null };

export function waitFromRefusal(refusal: ProviderRefusal, now: Date, label: string): { until: Date; reason: string } | null {
  if (refusal.status === 429) {
    const after = refusal.retryAfterMs ?? (refusal.resetAt ? refusal.resetAt.getTime() - now.getTime() : null);
    const ms = Math.min(Math.max(after ?? 60_000, 1_000), HOUR);
    return { until: new Date(now.getTime() + ms), reason: `${label} is rate limiting this key` };
  }
  if (refusal.status === 402) {
    // The free daily allowance is used up; it resets at 00:00 UTC. Never top up.
    return { until: new Date(windowStarts(now).day.getTime() + DAY), reason: `${label}'s free daily allowance is used up (${refusal.code ?? "402"}); it resets at 00:00 UTC` };
  }
  if (refusal.status === 503) {
    return { until: new Date(now.getTime() + Math.min(Math.max(refusal.retryAfterMs ?? 30_000, 1_000), 10 * MINUTE)), reason: `${label} is temporarily busy` };
  }
  return null;
}

/** `Retry-After` as milliseconds: seconds or an HTTP date. */
export function retryAfterMs(header: string | null, now: Date): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now.getTime()) : null;
}

/** A rate-limit reset header given in epoch seconds (or milliseconds), as a date. */
export function resetAt(header: string | null): Date | null {
  if (!header) return null;
  const value = Number(header);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value > 1e12 ? value : value * 1000);
}

/** Bounded exponential backoff with full jitter; `random` is injectable for tests. */
export function backoffMs(attempt: number, baseMs: number, capMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
