/**
 * Timezone-aware working-hours window check — ported from AgentSDR-app's
 * send-mails.ts (isNowWithinDayWindow), scoped to a mailbox instead of a
 * purchased domain. Handles overnight windows (e.g. 9pm-6am) by shifting
 * the window to the correct calendar day depending on where `now` falls.
 */
import { isWithinInterval, addDays, set as setTime } from "date-fns";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import type { WorkingHours, WorkingDay } from "./schema";

/** One window on chosen days, the shape the retired channel "sending hours" rules had. */
export type WeeklyHours = {
  /** IANA time zone, e.g. Asia/Kolkata. */
  timezone: string;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** "HH:mm", 24-hour. */
  start: string;
  end: string;
};

function parseHHmm(hhmm: string): { hours: number; minutes: number } {
  const [h, m] = hhmm.split(":").map(Number);
  return { hours: h || 0, minutes: m || 0 };
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const ALL_DAY: WorkingDay = { enabled: true, from: "00:00", to: "00:00" };

/**
 * A mailbox's hours now that sending is always on: every day, all day. Only
 * the time zone still matters, as the day its daily send counter resets on
 * (sendRules.ts, buildQueue.ts), so it is kept as given.
 */
export function alwaysOpenHours(timezone: string): WorkingHours {
  return { timezone, days: Object.fromEntries(DAY_NAMES.map((name) => [name, { ...ALL_DAY }])) as WorkingHours["days"] };
}

/** True for alwaysOpenHours' shape: every day enabled from 00:00 to 00:00. */
export function isAlwaysOpen(workingHours: WorkingHours): boolean {
  return DAY_NAMES.every((name) => {
    const day = workingHours.days?.[name];
    return day?.enabled === true && day.from === "00:00" && day.to === "00:00";
  });
}

function isWithinDayWindow(day: WorkingDay, now: Date, timezone: string): boolean {
  const zonedNow = toZonedTime(now, timezone);
  const { hours: sh, minutes: sm } = parseHHmm(day.from);
  const { hours: eh, minutes: em } = parseHHmm(day.to);

  const startTodayLocal = setTime(zonedNow, { hours: sh, minutes: sm, seconds: 0, milliseconds: 0 });
  const endTodayLocal = setTime(zonedNow, { hours: eh, minutes: em, seconds: 0, milliseconds: 0 });

  let startLocal = startTodayLocal;
  let endLocal = endTodayLocal;

  // Overnight window (e.g. 21:00-06:00): figure out which calendar day it started on.
  if (endTodayLocal <= startTodayLocal) {
    if (zonedNow <= endTodayLocal) {
      startLocal = addDays(startTodayLocal, -1);
      endLocal = endTodayLocal;
    } else {
      startLocal = startTodayLocal;
      endLocal = addDays(endTodayLocal, 1);
    }
  }

  const startUtc = fromZonedTime(startLocal, timezone);
  const endUtc = fromZonedTime(endLocal, timezone);
  return isWithinInterval(now, { start: startUtc, end: endUtc });
}

/**
 * True if `now` falls inside this mailbox's configured send window for the
 * current day (in its timezone). Always-open hours are open at every
 * instant, explicitly: not through the overnight branch, which a zone whose
 * clocks skip local midnight would leave a gap in.
 */
export function isWithinWorkingHours(workingHours: WorkingHours, now: Date = new Date()): boolean {
  if (isAlwaysOpen(workingHours)) return true;
  try {
    const zonedNow = toZonedTime(now, workingHours.timezone);
    const dayName = DAY_NAMES[zonedNow.getDay()];
    const day = workingHours.days[dayName];
    if (!day?.enabled) return false;
    return isWithinDayWindow(day, now, workingHours.timezone);
  } catch (err) {
    console.error("[outreach/workingHours] isWithinWorkingHours error:", err);
    return false;
  }
}

/**
 * True if `last` falls on the same calendar day as `now`, in `timezone`.
 * Used to make the daily send-counter reset idempotent — if build-queue
 * runs twice in one day (duplicate cron fire, manual re-run to pick up a
 * newly-launched campaign), the second run must not re-zero a mailbox's
 * todayEmailsSent, or it would silently grant a second full daily allowance.
 */
export function isSameLocalDay(last: Date | null, now: Date, timezone: string): boolean {
  if (!last) return false;
  try {
    const zonedLast = toZonedTime(last, timezone);
    const zonedNow = toZonedTime(now, timezone);
    return (
      zonedLast.getFullYear() === zonedNow.getFullYear() &&
      zonedLast.getMonth() === zonedNow.getMonth() &&
      zonedLast.getDate() === zonedNow.getDate()
    );
  } catch (err) {
    console.error("[outreach/workingHours] isSameLocalDay error:", err);
    return false;
  }
}

/** Per-day mailbox hours from one weekly window: the same window on every chosen day. */
export function mailboxHoursFromWeekly(hours: WeeklyHours): WorkingHours {
  const days = Object.fromEntries(
    DAY_NAMES.map((name, index) => [name, { enabled: hours.days.includes(index), from: hours.start, to: hours.end }]),
  ) as WorkingHours["days"];
  return { timezone: hours.timezone, days };
}

/**
 * True if a sending window is open at `at` and stays open after it. A window
 * ending at 00:00 ("until midnight") contains its closing instant, since the
 * end is inclusive, but nothing can be sent in it.
 */
export function isWindowOpenFrom(workingHours: WorkingHours, at: Date): boolean {
  return isWithinWorkingHours(workingHours, at) && isWithinWorkingHours(workingHours, new Date(at.getTime() + 1));
}

/**
 * When the next sending window opens, in its own time zone: null when `now`
 * is already inside one that stays open, or when no day is enabled. Looks a
 * week ahead.
 */
export function nextWindowStart(workingHours: WorkingHours, now: Date = new Date()): Date | null {
  if (isWindowOpenFrom(workingHours, now)) return null;
  try {
    const zonedNow = toZonedTime(now, workingHours.timezone);
    for (let offset = 0; offset <= 7; offset++) {
      const zonedDay = addDays(zonedNow, offset);
      const day = workingHours.days[DAY_NAMES[zonedDay.getDay()]];
      if (!day?.enabled) continue;
      // An overnight window also covers its own day's early morning (isWithinDayWindow), so a later day can open at midnight.
      const midnight = fromZonedTime(setTime(zonedDay, { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 }), workingHours.timezone);
      if (offset > 0 && isWindowOpenFrom(workingHours, midnight)) return midnight;
      const { hours, minutes } = parseHHmm(day.from);
      const start = fromZonedTime(setTime(zonedDay, { hours, minutes, seconds: 0, milliseconds: 0 }), workingHours.timezone);
      if (start > now) return start;
    }
  } catch (err) {
    console.error("[outreach/workingHours] nextWindowStart error:", err);
  }
  return null;
}
