/**
 * Timezone-aware working-hours window check — ported from AgentSDR-app's
 * send-mails.ts (isNowWithinDayWindow), scoped to a mailbox instead of a
 * purchased domain. Handles overnight windows (e.g. 9pm-6am) by shifting
 * the window to the correct calendar day depending on where `now` falls.
 */
import { isWithinInterval, addDays, set as setTime } from "date-fns";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import type { WorkingHours, WorkingDay } from "./schema";
import type { WeeklyHours } from "@/lib/channels/rules";

function parseHHmm(hhmm: string): { hours: number; minutes: number } {
  const [h, m] = hhmm.split(":").map(Number);
  return { hours: h || 0, minutes: m || 0 };
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

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

/** True if `now` falls inside this mailbox's configured send window for the current day (in its timezone). */
export function isWithinWorkingHours(workingHours: WorkingHours, now: Date = new Date()): boolean {
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

/**
 * A mailbox's per-day hours from the organization's default sending hours
 * (Settings → Email → Sending rules): the same window on every chosen day.
 */
export function mailboxHoursFromWeekly(hours: WeeklyHours): WorkingHours {
  const days = Object.fromEntries(
    DAY_NAMES.map((name, index) => [name, { enabled: hours.days.includes(index), from: hours.start, to: hours.end }]),
  ) as WorkingHours["days"];
  return { timezone: hours.timezone, days };
}

/**
 * When the next sending window opens, in its own time zone: null when `now`
 * is already inside one, or when no day is enabled. Looks a week ahead.
 */
export function nextWindowStart(workingHours: WorkingHours, now: Date = new Date()): Date | null {
  if (isWithinWorkingHours(workingHours, now)) return null;
  try {
    const zonedNow = toZonedTime(now, workingHours.timezone);
    for (let offset = 0; offset <= 7; offset++) {
      const zonedDay = addDays(zonedNow, offset);
      const day = workingHours.days[DAY_NAMES[zonedDay.getDay()]];
      if (!day?.enabled) continue;
      const { hours, minutes } = parseHHmm(day.from);
      const start = fromZonedTime(setTime(zonedDay, { hours, minutes, seconds: 0, milliseconds: 0 }), workingHours.timezone);
      if (start > now) return start;
    }
  } catch (err) {
    console.error("[outreach/workingHours] nextWindowStart error:", err);
  }
  return null;
}
