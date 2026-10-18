import { describe, expect, test } from "bun:test";
import { backoffMs, EMPTY_COUNTERS, quotaDecision, released, resetAt, retryAfterMs, rolled, waitFromRefusal, windowStarts, type QuotaCounters, type QuotaLimits } from "./quota";

const at = (iso: string) => new Date(iso);
const LIMITS = { perMinute: 30, perHour: 500, perDay: 12_000 };

function take(counters: QuotaCounters, units: number, now: Date, limits: QuotaLimits = LIMITS): QuotaCounters {
  const decision = quotaDecision(counters, limits, units, now, "TinyFish Search");
  if (!decision.ok) throw new Error(`refused: ${decision.reason}`);
  return decision.counters;
}

describe("quota windows", () => {
  test("windows are the UTC minute, hour and day", () => {
    const w = windowStarts(at("2026-10-18T17:42:31.250Z"));
    expect(w.minute.toISOString()).toBe("2026-10-18T17:42:00.000Z");
    expect(w.hour.toISOString()).toBe("2026-10-18T17:00:00.000Z");
    expect(w.day.toISOString()).toBe("2026-10-18T00:00:00.000Z");
  });

  test("a new minute forgets the last minute but not the hour or the day", () => {
    let c = take(EMPTY_COUNTERS, 30, at("2026-10-18T17:42:10Z"));
    expect(quotaDecision(c, LIMITS, 1, at("2026-10-18T17:42:50Z"), "TinyFish Search").ok).toBe(false);
    c = take(c, 1, at("2026-10-18T17:43:00Z"));
    expect(c.minuteUsed).toBe(1);
    expect(c.hourUsed).toBe(31);
    expect(c.dayUsed).toBe(31);
  });

  test("a full minute says to wait until the next minute", () => {
    const c = take(EMPTY_COUNTERS, 30, at("2026-10-18T17:42:10Z"));
    const refused = quotaDecision(c, LIMITS, 1, at("2026-10-18T17:42:11Z"), "TinyFish Search");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.until.toISOString()).toBe("2026-10-18T17:43:00.000Z");
      expect(refused.reason).toContain("30 a minute");
    }
  });

  test("an exhausted daily allowance waits for 00:00 UTC", () => {
    const fetchLimits = { perMinute: 150, perDay: 1_000 };
    let c: QuotaCounters = { ...EMPTY_COUNTERS };
    for (let minute = 0; minute < 10; minute += 1) c = take(c, 100, new Date(Date.UTC(2026, 9, 18, 20, minute)), fetchLimits);
    const refused = quotaDecision(c, fetchLimits, 1, at("2026-10-18T23:59:00Z"), "TinyFish Fetch");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.until.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(quotaDecision(c, fetchLimits, 10, at("2026-10-19T00:00:01Z"), "TinyFish Fetch").ok).toBe(true);
  });

  test("a request larger than a whole window never fits", () => {
    const refused = quotaDecision(EMPTY_COUNTERS, { perMinute: 150 }, 151, at("2026-10-18T10:00:00Z"), "TinyFish Fetch");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("at once");
  });

  test("a provider's wait holds until it passes", () => {
    const blocked = { ...EMPTY_COUNTERS, blockedUntil: at("2026-10-18T17:45:00Z"), blockedReason: "TinyFish Search is rate limiting this key" };
    const refused = quotaDecision(blocked, LIMITS, 1, at("2026-10-18T17:44:00Z"), "TinyFish Search");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("TinyFish Search is rate limiting this key");
    expect(quotaDecision(blocked, LIMITS, 1, at("2026-10-18T17:45:00Z"), "TinyFish Search").ok).toBe(true);
    expect(rolled(blocked, at("2026-10-18T17:46:00Z")).blockedUntil).toBeNull();
  });

  test("unused units go back only to windows that are still current", () => {
    const reservedAt = at("2026-10-18T17:42:10Z");
    const c = take(EMPTY_COUNTERS, 10, reservedAt, { perMinute: 150, perDay: 1_000 });
    const sameMinute = released(c, 7, reservedAt);
    expect([sameMinute.minuteUsed, sameMinute.dayUsed]).toEqual([3, 3]);
    // Settled a minute later: the minute already forgot them, the day gets them back.
    const later = rolled(c, at("2026-10-18T17:43:05Z"));
    const back = released(later, 7, reservedAt);
    expect([back.minuteUsed, back.dayUsed]).toEqual([0, 3]);
    expect(released(c, 0, reservedAt)).toBe(c);
  });
});

describe("provider refusals", () => {
  const now = at("2026-10-18T17:42:00Z");

  test("429 waits for Retry-After, else the reset header, bounded to an hour", () => {
    expect(waitFromRefusal({ status: 429, retryAfterMs: 20_000 }, now, "TinyFish Search")!.until.toISOString()).toBe("2026-10-18T17:42:20.000Z");
    expect(waitFromRefusal({ status: 429, resetAt: at("2026-10-18T17:43:00Z") }, now, "TinyFish Search")!.until.toISOString()).toBe("2026-10-18T17:43:00.000Z");
    expect(waitFromRefusal({ status: 429, retryAfterMs: 10 * 3_600_000 }, now, "TinyFish Search")!.until.toISOString()).toBe("2026-10-18T18:42:00.000Z");
    expect(waitFromRefusal({ status: 429 }, now, "TinyFish Search")!.until.toISOString()).toBe("2026-10-18T17:43:00.000Z");
  });

  test("402 (free allowance used) waits for 00:00 UTC and never suggests a top-up", () => {
    const wait = waitFromRefusal({ status: 402, code: "FREE_ALLOWANCE_EXHAUSTED" }, now, "TinyFish Fetch")!;
    expect(wait.until.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(wait.reason).toContain("FREE_ALLOWANCE_EXHAUSTED");
  });

  test("other errors are not waits", () => {
    expect(waitFromRefusal({ status: 401 }, now, "TinyFish Search")).toBeNull();
    expect(waitFromRefusal({ status: 400 }, now, "TinyFish Search")).toBeNull();
    expect(waitFromRefusal({ status: null }, now, "TinyFish Search")).toBeNull();
  });

  test("Retry-After in seconds or as a date; reset in epoch seconds or ms", () => {
    expect(retryAfterMs("12", now)).toBe(12_000);
    expect(retryAfterMs("Sun, 18 Oct 2026 17:42:30 GMT", now)).toBe(30_000);
    expect(retryAfterMs(null, now)).toBeNull();
    expect(retryAfterMs("soon", now)).toBeNull();
    expect(resetAt("1792344180")!.toISOString()).toBe("2026-10-18T17:23:00.000Z");
    expect(resetAt("1792344180000")!.toISOString()).toBe("2026-10-18T17:23:00.000Z");
    expect(resetAt("0")).toBeNull();
  });

  test("backoff grows, is capped, and is jittered between half and full", () => {
    expect(backoffMs(0, 1_000, 60_000, () => 0)).toBe(500);
    expect(backoffMs(0, 1_000, 60_000, () => 1)).toBe(1_000);
    expect(backoffMs(3, 1_000, 60_000, () => 1)).toBe(8_000);
    expect(backoffMs(20, 1_000, 60_000, () => 1)).toBe(60_000);
  });
});
