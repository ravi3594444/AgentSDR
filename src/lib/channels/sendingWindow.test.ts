import { describe, expect, test } from "bun:test";

import { describeOpening, describeWorkingHours, workingWindow } from "./sendingWindow";
import type { WorkingHours } from "@/lib/outreach/schema";
import { alwaysOpenHours, mailboxHoursFromWeekly } from "@/lib/outreach/workingHours";

// A mailbox that still has restricted hours from before sending was always on.
const monToFri = mailboxHoursFromWeekly({ timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" });

describe("workingWindow", () => {
  test("an always-open mailbox is open, even on a Saturday evening", () => {
    expect(workingWindow(alwaysOpenHours("Asia/Kolkata"), new Date("2026-10-17T13:46:00Z"))).toEqual({ open: true, opensAt: null });
  });

  test("inside a legacy window on a weekday", () => {
    // Monday 10:00 in Asia/Kolkata.
    expect(workingWindow(monToFri, new Date("2026-10-19T04:30:00Z"))).toEqual({ open: true, opensAt: null });
  });

  test("Saturday afternoon in IST is closed until Monday 09:00 IST", () => {
    // 2026-10-17T13:46Z is Saturday 19:16 IST — the day the owner asked why nothing sent.
    const window = workingWindow(monToFri, new Date("2026-10-17T13:46:00Z"));
    expect(window.open).toBe(false);
    expect(window.opensAt?.toISOString()).toBe("2026-10-19T03:30:00.000Z");
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
  test("an always-open mailbox sends any time", () => {
    expect(describeWorkingHours(alwaysOpenHours("Asia/Kolkata"))).toBe("any time, every day (Asia/Kolkata)");
  });

  test("legacy weekday hours read as a range", () => {
    expect(describeWorkingHours(monToFri)).toBe("Mon–Fri 09:00–18:00 (Asia/Kolkata)");
  });

  test("scattered days are listed", () => {
    expect(describeWorkingHours(mailboxHoursFromWeekly({ timezone: "Asia/Kolkata", days: [1, 3, 5], start: "09:00", end: "18:00" }))).toBe("Mon, Wed, Fri 09:00–18:00 (Asia/Kolkata)");
  });

  test("the next opening is said in the window's own time zone", () => {
    expect(describeOpening(new Date("2026-10-19T03:30:00Z"), "Asia/Kolkata")).toBe("Monday 19 Oct at 09:00");
  });
});
