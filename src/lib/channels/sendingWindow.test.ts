import { describe, expect, test } from "bun:test";

import type { WeeklyHours } from "./rules";
import { describeOpening, describeWeeklyHours, sendingWindow, workingWindow } from "./sendingWindow";
import type { WorkingHours } from "@/lib/outreach/schema";

const monToFri: WeeklyHours = { timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };

describe("sendingWindow", () => {
  test("no hours means any time", () => {
    expect(sendingWindow(null, new Date("2026-10-17T13:46:00Z"))).toEqual({ open: true, opensAt: null });
  });

  test("inside the window on a weekday", () => {
    // Monday 10:00 in Asia/Kolkata.
    expect(sendingWindow(monToFri, new Date("2026-10-19T04:30:00Z"))).toEqual({ open: true, opensAt: null });
  });

  test("Saturday afternoon in IST is closed until Monday 09:00 IST", () => {
    // 2026-10-17T13:46Z is Saturday 19:16 IST — the day the owner asked why nothing sent.
    const window = sendingWindow(monToFri, new Date("2026-10-17T13:46:00Z"));
    expect(window.open).toBe(false);
    expect(window.opensAt?.toISOString()).toBe("2026-10-19T03:30:00.000Z");
  });

  test("after hours on a weekday opens the next weekday morning", () => {
    // Thursday 19:00 IST → Friday 09:00 IST.
    expect(sendingWindow(monToFri, new Date("2026-10-15T13:30:00Z")).opensAt?.toISOString()).toBe("2026-10-16T03:30:00.000Z");
  });

  test("an overnight window is open after midnight", () => {
    const overnight: WeeklyHours = { timezone: "UTC", days: [2], start: "21:00", end: "06:00" };
    // Tuesday 23:00 UTC.
    expect(sendingWindow(overnight, new Date("2026-10-13T23:00:00Z"))).toEqual({ open: true, opensAt: null });
  });

  test("an overnight window that has closed reopens that evening", () => {
    const overnight: WeeklyHours = { timezone: "UTC", days: [2, 3], start: "21:00", end: "06:00" };
    // Tuesday 07:00 UTC: Tuesday's window ended at 06:00 and starts again at 21:00.
    expect(sendingWindow(overnight, new Date("2026-10-13T07:00:00Z")).opensAt?.toISOString()).toBe("2026-10-13T21:00:00.000Z");
  });

  test("hours set per day still find the next enabled day", () => {
    const working: WorkingHours = {
      timezone: "America/Chicago",
      days: {
        monday: { enabled: true, from: "09:00", to: "12:00" },
        tuesday: { enabled: false, from: "09:00", to: "12:00" },
        wednesday: { enabled: false, from: "09:00", to: "12:00" },
        thursday: { enabled: true, from: "13:00", to: "17:00" },
        friday: { enabled: false, from: "09:00", to: "12:00" },
        saturday: { enabled: false, from: "09:00", to: "12:00" },
        sunday: { enabled: false, from: "09:00", to: "12:00" },
      },
    };
    // Tuesday 02:00 CDT — Tuesday is off, so Thursday 13:00 CDT (18:00Z) is next.
    const window = workingWindow(working, new Date("2026-10-13T07:00:00Z"));
    expect(window.open).toBe(false);
    expect(window.opensAt?.toISOString()).toBe("2026-10-15T18:00:00.000Z");
  });
});

describe("describing hours", () => {
  test("weekday hours read as a range", () => {
    expect(describeWeeklyHours(monToFri)).toBe("Mon–Fri 09:00–18:00 (Asia/Kolkata)");
  });

  test("scattered days are listed", () => {
    expect(describeWeeklyHours({ ...monToFri, days: [1, 3, 5] })).toBe("Mon, Wed, Fri 09:00–18:00 (Asia/Kolkata)");
  });

  test("every day", () => {
    expect(describeWeeklyHours({ ...monToFri, days: [0, 1, 2, 3, 4, 5, 6] })).toBe("every day 09:00–18:00 (Asia/Kolkata)");
  });

  test("no hours set means any time", () => {
    expect(describeWeeklyHours(null)).toBeNull();
  });

  test("the next opening is said in the window's own time zone", () => {
    expect(describeOpening(new Date("2026-10-19T03:30:00Z"), "Asia/Kolkata")).toBe("Monday 19 Oct at 09:00");
  });
});
