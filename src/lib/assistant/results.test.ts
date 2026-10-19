import { describe, expect, test } from "bun:test";

import { analyticsRange } from "@/lib/analytics/range";
import { periodFor, summaryDay, type PeriodKind } from "./results";

/** The Analytics preset of each Overview period both pages offer. */
const ANALYTICS_PRESET: Record<Exclude<PeriodKind, "all_time">, string> = {
  today: "today",
  yesterday: "yesterday",
  last_7_days: "7d",
  last_30_days: "30d",
};

describe("Overview periods", () => {
  test("today is the whole local day in the business's time zone", () => {
    // 23:50 UTC on the 18th is 05:20 on the 19th in Kolkata.
    const today = periodFor("today", "Asia/Kolkata", new Date("2026-10-18T23:50:00Z"));
    expect(today.from?.toISOString()).toBe("2026-10-18T18:30:00.000Z");
    expect(today.to.toISOString()).toBe("2026-10-19T18:30:00.000Z");
    expect(today.days).toEqual({ from: "2026-10-19", to: "2026-10-19" });
    expect(today.label).toBe("today (2026-10-19)");
  });

  test("the last 7 days are seven local days ending today", () => {
    const week = periodFor("last_7_days", "Asia/Kolkata", new Date("2026-10-18T23:50:00Z"));
    expect(week.days).toEqual({ from: "2026-10-13", to: "2026-10-19" });
    expect(week.from?.toISOString()).toBe("2026-10-12T18:30:00.000Z");
    expect(week.label).toBe("the last 7 days (2026-10-13 to today)");
  });

  test("all time has no start and ends where today ends", () => {
    const all = periodFor("all_time", "Asia/Kolkata", new Date("2026-10-18T23:50:00Z"));
    expect(all.from).toBeNull();
    expect(all.to.toISOString()).toBe("2026-10-19T18:30:00.000Z");
    expect(all.days).toBeNull();
  });

  test("the daily summary covers yesterday's local day", () => {
    const { day, period } = summaryDay("Asia/Kolkata", new Date("2026-10-18T23:50:00Z"));
    expect(day).toBe("2026-10-18");
    expect(period.from?.toISOString()).toBe("2026-10-17T18:30:00.000Z");
    expect(period.to.toISOString()).toBe("2026-10-18T18:30:00.000Z");
  });
});

describe("Overview and Analytics read the same window for the same preset", () => {
  const instants = [
    "2026-10-18T23:50:00Z", // just before midnight UTC: already the 19th in Kolkata
    "2026-10-19T00:10:00Z", // just after midnight UTC
    "2026-10-18T18:29:00Z", // a minute before Kolkata's midnight
    "2026-10-18T18:31:00Z", // a minute after it
    "2026-10-25T00:30:00Z", // the night London leaves summer time
  ];
  const zones = ["Asia/Kolkata", "UTC", "America/Los_Angeles", "Europe/London"];

  for (const zone of zones) {
    for (const instant of instants) {
      test(`${zone} at ${instant}`, () => {
        const now = new Date(instant);
        for (const [kind, preset] of Object.entries(ANALYTICS_PRESET) as [Exclude<PeriodKind, "all_time">, string][]) {
          const overview = periodFor(kind, zone, now);
          const analytics = analyticsRange(new URLSearchParams({ range: preset }), zone, now);
          expect(analytics.window).toEqual({ from: overview.from!.toISOString(), to: overview.to.toISOString() });
          expect({ from: analytics.from, to: analytics.to }).toEqual(overview.days!);
          expect(analytics.tz).toBe(zone);
          expect(analytics.tzSource).toBe("organization");
          expect(analytics.preset).toBe(preset);
        }
      });
    }
  }

  test("Analytics takes the organization's zone, not the viewer's, unless ?tz= overrides it", () => {
    const now = new Date("2026-10-18T23:50:00Z");
    // A viewer in Los Angeles (still the 18th there) of a Kolkata business (already the 19th).
    const organization = analyticsRange(new URLSearchParams({ range: "today" }), "Asia/Kolkata", now);
    expect(organization).toMatchObject({ from: "2026-10-19", to: "2026-10-19", tz: "Asia/Kolkata", tzSource: "organization" });
    const override = analyticsRange(new URLSearchParams({ range: "today", tz: "America/Los_Angeles" }), "Asia/Kolkata", now);
    expect(override).toMatchObject({ from: "2026-10-18", to: "2026-10-18", tz: "America/Los_Angeles", tzSource: "override" });
    expect(override.window).toEqual({ from: "2026-10-18T07:00:00.000Z", to: "2026-10-19T07:00:00.000Z" });
  });

  test("explicit dates and legacy zone names still work", () => {
    const range = analyticsRange(new URLSearchParams({ from: "2026-10-01", to: "2026-10-07", tz: "Asia/Calcutta" }), "UTC");
    expect(range).toMatchObject({ from: "2026-10-01", to: "2026-10-07", tz: "Asia/Kolkata", tzSource: "override", preset: null, bucket: "day" });
    expect(range.window.from).toBe("2026-09-30T18:30:00.000Z");
  });

  test("a range Analytics cannot answer is refused", () => {
    expect(() => analyticsRange(new URLSearchParams({ range: "forever" }), "UTC")).toThrow("Unknown range");
    expect(() => analyticsRange(new URLSearchParams({ from: "2026-10-07", to: "2026-10-01" }), "UTC")).toThrow("from must not be after to");
    expect(() => analyticsRange(new URLSearchParams({ from: "2025-01-01", to: "2026-10-01" }), "UTC")).toThrow("at most");
  });
});
