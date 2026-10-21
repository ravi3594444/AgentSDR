import { describe, expect, test } from "bun:test";
import { DEFAULT_WORKING_HOURS } from "./schema";
import { alwaysOpenHours, isAlwaysOpen, isWithinWorkingHours, mailboxHoursFromWeekly, nextWindowStart } from "./workingHours";

// Monday to Friday, 09:00–18:00 in India (UTC+5:30, no daylight saving).
const india = mailboxHoursFromWeekly({ timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" });

describe("always open: every mailbox sends any time, every day", () => {
  const instants = [
    "2026-10-17T11:00:00Z", // the Saturday of the reported incident
    "2026-10-18T23:59:30Z",
    "2026-10-19T00:00:00.000Z",
    "2026-10-19T12:00:00Z",
    "2026-03-08T07:30:00Z", // New York's spring-forward morning
    "2026-11-01T05:30:00Z", // and its fall-back hour
    "2026-09-06T04:00:00Z", // Santiago skips its local midnight that night
  ].map((at) => new Date(at));

  test("a new mailbox's hours keep only its time zone, the day its daily count resets on", () => {
    const hours = alwaysOpenHours("Asia/Kolkata");
    expect(hours.timezone).toBe("Asia/Kolkata");
    expect(Object.values(hours.days)).toEqual(Array(7).fill({ enabled: true, from: "00:00", to: "00:00" }));
    expect(isAlwaysOpen(hours)).toBe(true);
    expect(isAlwaysOpen(india)).toBe(false);
  });

  test("open at every instant, in any zone, across daylight saving and at midnight", () => {
    for (const zone of ["UTC", "Asia/Kolkata", "America/New_York", "America/Santiago"]) {
      for (const at of instants) expect(isWithinWorkingHours(alwaysOpenHours(zone), at)).toBe(true);
    }
  });

  test("never waits for a window", () => {
    for (const at of instants) expect(nextWindowStart(alwaysOpenHours("America/Santiago"), at)).toBeNull();
  });

  test("the column default is always open", () => {
    expect(isAlwaysOpen(DEFAULT_WORKING_HOURS)).toBe(true);
    expect(DEFAULT_WORKING_HOURS).toEqual(alwaysOpenHours("UTC"));
  });
});

describe("nextWindowStart", () => {
  test("inside the window there is nothing to wait for", () => {
    expect(nextWindowStart(india, new Date("2026-10-19T06:00:00Z"))).toBeNull(); // Monday 11:30 IST
  });
  test("before the window opens, the same morning in the sender's time zone", () => {
    expect(nextWindowStart(india, new Date("2026-10-19T01:00:00Z"))?.toISOString()).toBe("2026-10-19T03:30:00.000Z"); // Monday 06:30 IST → 09:00 IST
  });
  test("after hours on Friday, Monday morning", () => {
    expect(nextWindowStart(india, new Date("2026-10-23T13:00:00Z"))?.toISOString()).toBe("2026-10-26T03:30:00.000Z"); // Friday 18:30 IST
  });
  test("an overnight window opens the same evening", () => {
    const nights = mailboxHoursFromWeekly({ timezone: "UTC", days: [0, 1, 2, 3, 4, 5, 6], start: "21:00", end: "06:00" });
    expect(nextWindowStart(nights, new Date("2026-10-19T12:00:00Z"))?.toISOString()).toBe("2026-10-19T21:00:00.000Z");
    expect(nextWindowStart(nights, new Date("2026-10-19T03:00:00Z"))).toBeNull();
  });
  test("an overnight window after days off opens at midnight, where its early-morning part begins", () => {
    // Monday to Friday 22:00–06:00: Monday's window also covers Monday 00:00–06:00, and the scheduler sends then.
    const weeknights = mailboxHoursFromWeekly({ timezone: "UTC", days: [1, 2, 3, 4, 5], start: "22:00", end: "06:00" });
    const next = nextWindowStart(weeknights, new Date("2026-10-17T07:00:00Z")); // Saturday
    expect(next?.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(isWithinWorkingHours(weeknights, next!)).toBe(true);
    expect(isWithinWorkingHours(weeknights, new Date("2026-10-18T23:59:00Z"))).toBe(false);
  });
  test("a window that runs until midnight after days off opens at its start, not at the midnight it ends on", () => {
    // Monday to Friday 09:00–00:00: Monday 00:00 is only the inclusive end of a window that started on Sunday, and the scheduler never sends in it.
    const untilMidnight = mailboxHoursFromWeekly({ timezone: "UTC", days: [1, 2, 3, 4, 5], start: "09:00", end: "00:00" });
    expect(nextWindowStart(untilMidnight, new Date("2026-10-17T07:00:00Z"))?.toISOString()).toBe("2026-10-19T09:00:00.000Z"); // Saturday
    expect(isWithinWorkingHours(untilMidnight, new Date("2026-10-19T00:00:00.001Z"))).toBe(false);
    expect(nextWindowStart(untilMidnight, new Date("2026-10-19T05:00:00Z"))?.toISOString()).toBe("2026-10-19T09:00:00.000Z"); // Monday morning
    expect(nextWindowStart(untilMidnight, new Date("2026-10-19T23:00:00Z"))).toBeNull();
  });
  test("an overnight 21:00–06:00 window after days off opens at midnight, and on a weekday morning the same evening", () => {
    const nights = mailboxHoursFromWeekly({ timezone: "UTC", days: [1, 2, 3, 4, 5], start: "21:00", end: "06:00" });
    expect(nextWindowStart(nights, new Date("2026-10-17T07:00:00Z"))?.toISOString()).toBe("2026-10-19T00:00:00.000Z"); // Saturday
    expect(nextWindowStart(nights, new Date("2026-10-19T07:00:00Z"))?.toISOString()).toBe("2026-10-19T21:00:00.000Z"); // Monday morning
  });
  test("a normal daytime window after days off opens at its start, never at midnight", () => {
    const days = mailboxHoursFromWeekly({ timezone: "UTC", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" });
    expect(nextWindowStart(days, new Date("2026-10-17T07:00:00Z"))?.toISOString()).toBe("2026-10-19T09:00:00.000Z"); // Saturday
    expect(nextWindowStart(days, new Date("2026-10-19T18:00:00Z"))?.toISOString()).toBe("2026-10-20T09:00:00.000Z"); // Monday evening
  });
  test("no enabled day: no next window", () => {
    expect(nextWindowStart(mailboxHoursFromWeekly({ timezone: "UTC", days: [], start: "09:00", end: "17:00" }), new Date("2026-10-19T12:00:00Z"))).toBeNull();
  });
});
