import { describe, expect, test } from "bun:test";
import { DAILY_LEAD_LIMIT_GATE, dailyLeadLimitReason, describeLeadDay, leadDayWindow } from "./dailyLeadLimit";

const iso = (window: { start: Date; resetsAt: Date }) => ({ start: window.start.toISOString(), resetsAt: window.resetsAt.toISOString() });

describe("the workspace's lead day (general.timeZone + general.dayStartsAt)", () => {
  test("UTC midnight: today began at 00:00 and resets at the next 00:00", () => {
    expect(iso(leadDayWindow("UTC", "00:00", new Date("2026-10-21T17:00:00Z")))).toEqual({ start: "2026-10-21T00:00:00.000Z", resetsAt: "2026-10-22T00:00:00.000Z" });
  });

  test("a day that starts at 05:30 in India: before 05:30 it is still yesterday", () => {
    // 05:40 IST on the 21st.
    expect(iso(leadDayWindow("Asia/Kolkata", "05:30", new Date("2026-10-21T00:10:00Z")))).toEqual({ start: "2026-10-21T00:00:00.000Z", resetsAt: "2026-10-22T00:00:00.000Z" });
    // 05:20 IST on the 21st.
    expect(iso(leadDayWindow("Asia/Kolkata", "05:30", new Date("2026-10-20T23:50:00Z")))).toEqual({ start: "2026-10-20T00:00:00.000Z", resetsAt: "2026-10-21T00:00:00.000Z" });
  });

  test("at the reset instant a new day has begun, and the next reset is a day later", () => {
    const now = new Date("2026-10-22T00:00:00Z");
    expect(iso(leadDayWindow("UTC", "00:00", now))).toEqual({ start: "2026-10-22T00:00:00.000Z", resetsAt: "2026-10-23T00:00:00.000Z" });
    const justBefore = new Date(now.getTime() - 1);
    expect(leadDayWindow("UTC", "00:00", justBefore).resetsAt.getTime()).toBe(now.getTime());
  });

  test("across daylight saving the day is 23 or 25 hours, still from local midnight", () => {
    // New York springs forward on 8 March 2026 and falls back on 1 November 2026.
    expect(iso(leadDayWindow("America/New_York", "00:00", new Date("2026-03-08T12:00:00Z")))).toEqual({ start: "2026-03-08T05:00:00.000Z", resetsAt: "2026-03-09T04:00:00.000Z" });
    expect(iso(leadDayWindow("America/New_York", "00:00", new Date("2026-11-01T12:00:00Z")))).toEqual({ start: "2026-11-01T04:00:00.000Z", resetsAt: "2026-11-02T05:00:00.000Z" });
  });
});

describe("what the settings screen says about today", () => {
  test("today's count against the limit, and when it resets, in the workspace's own day", () => {
    const day = { used: 3, limit: 50, resetsAt: new Date("2026-10-22T00:00:00Z"), timeZone: "Asia/Kolkata", dayStartsAt: "05:30" };
    expect(describeLeadDay(day)).toEqual({
      used: "3 of 50 new leads contacted today",
      reached: false,
      resets: "Resets every day at 05:30 (Asia/Kolkata). Next reset: Thursday 22 Oct at 05:30.",
    });
    expect(describeLeadDay({ ...day, used: 50 }).reached).toBe(true);
    expect(describeLeadDay({ ...day, used: 1, limit: 1 }).used).toBe("1 of 1 new lead contacted today");
  });
});

describe("why a first message waits", () => {
  test("says the count, the limit and when it resets, in the workspace's time zone", () => {
    expect(dailyLeadLimitReason(50, 50, new Date("2026-10-22T00:00:00Z"), "Asia/Kolkata")).toBe(
      "Daily lead limit reached (50 of 50 new leads today); resets Thursday 22 Oct at 05:30 (Asia/Kolkata)",
    );
    expect(dailyLeadLimitReason(1, 1, new Date("2026-10-22T00:00:00Z"), "UTC")).toBe("Daily lead limit reached (1 of 1 new lead today); resets Thursday 22 Oct at 00:00 (UTC)");
  });

  test("always starts with the gate text the status screens match", () => {
    expect(dailyLeadLimitReason(3, 3, new Date(), "UTC").startsWith(DAILY_LEAD_LIMIT_GATE)).toBe(true);
    expect(DAILY_LEAD_LIMIT_GATE).toBe("Daily lead limit reached");
  });
});
