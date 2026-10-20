/**
 * Slot math for the in-process scheduler (internalScheduler.ts). A "slot" is
 * the instant a scheduled run belongs to; the run for a slot is claimed once
 * in `scheduled_job_runs`, so it happens at most once however many processes
 * (or external cron callers) reach it.
 *
 * The scheduler always works on the LATEST slot that is due (≤ now): a run a
 * few minutes late lands on the same slot as one on time, and after downtime
 * only the most recent missed slot runs, not every one that was missed.
 *
 * Pure and client-safe: Intl only, no dependencies.
 */

export const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export type Schedule =
  /** Every N minutes, aligned to the UTC clock (N divides 60, or is whole hours dividing 24). */
  | { kind: "interval"; minutes: number }
  /** Once a day at a wall-clock time in a time zone. */
  | { kind: "daily"; at: string; timeZone: string };

export function everyMinutes(minutes: number): Schedule {
  const ok = Number.isInteger(minutes) && minutes > 0 && (60 % minutes === 0 || (minutes % 60 === 0 && 1440 % minutes === 0));
  if (!ok) throw new Error(`Interval of ${minutes} minutes does not divide the hour or the day evenly`);
  return { kind: "interval", minutes };
}

export function dailyAt(at: string, timeZone = "UTC"): Schedule {
  if (!parseClockTime(at)) throw new Error(`Not a time of day: ${at}`);
  return { kind: "daily", at, timeZone };
}

export function describeSchedule(schedule: Schedule): string {
  return schedule.kind === "interval" ? `every ${schedule.minutes} min` : `daily at ${schedule.at} ${schedule.timeZone}`;
}

/** The latest slot of `schedule` that is due at `now`. */
export function latestDueSlot(schedule: Schedule, now: Date): Date {
  if (schedule.kind === "interval") {
    const step = schedule.minutes * MINUTE_MS;
    return new Date(Math.floor(now.getTime() / step) * step);
  }
  return latestDailySlot(schedule.timeZone, schedule.at, now);
}

/**
 * The first slot of `schedule` at or after `at`: when a job that is due
 * then is next looked at. An interval's slots sit on the UTC clock (every
 * 30 minutes: :00 and :30); a daily slot is the next new-day time in its
 * zone, DST-safe because consecutive days are 23 to 25 hours apart.
 */
export function nextSlotAt(schedule: Schedule, at: Date): Date {
  if (schedule.kind === "interval") {
    const step = schedule.minutes * MINUTE_MS;
    return new Date(Math.ceil(at.getTime() / step) * step);
  }
  const latest = latestDailySlot(schedule.timeZone, schedule.at, at);
  if (latest.getTime() === at.getTime()) return latest;
  return latestDailySlot(schedule.timeZone, schedule.at, new Date(latest.getTime() + 25 * 60 * MINUTE_MS));
}

/** "HH:MM", 24-hour. */
export function parseClockTime(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
}

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock reading of `instant` in `timeZone`. */
export function wallTime(timeZone: string, instant: number): Wall {
  const wall: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") wall[part.type] = Number(part.value);
  }
  return { year: wall.year, month: wall.month, day: wall.day, hour: wall.hour % 24, minute: wall.minute, second: wall.second };
}

/** The zone's offset from UTC at `instant`, in ms (Asia/Kolkata: +5h30). */
function offsetAt(timeZone: string, instant: number): number {
  const w = wallTime(timeZone, instant);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in `timeZone`. Across a DST change:
 * a time that occurs twice (clocks go back) is its FIRST occurrence; a time
 * that does not exist (clocks go forward) moves forward by the gap, so
 * 02:30 on New York's spring-forward day is 03:30 EDT.
 */
export function wallTimeToInstant(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set([offsetAt(timeZone, guess - DAY_MS), offsetAt(timeZone, guess), offsetAt(timeZone, guess + DAY_MS)]);
  const candidates = [...offsets].map((offset) => guess - offset);
  const exact = candidates.filter((instant) => {
    const w = wallTime(timeZone, instant);
    return w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute;
  });
  return exact.length ? Math.min(...exact) : Math.max(...candidates);
}

/**
 * The start of the current "day" when a day begins at `at` (HH:MM) in
 * `timeZone`: the latest such instant that is ≤ now. It identifies the day,
 * so it is the slot of a once-a-day job.
 */
export function latestDailySlot(timeZone: string, at: string, now: Date): Date {
  const time = parseClockTime(at);
  if (!time) throw new Error(`Not a time of day: ${at}`);
  const nowMs = now.getTime();
  const today = wallTime(timeZone, nowMs);
  const todayMidnight = Date.UTC(today.year, today.month - 1, today.day);
  for (let back = 0; back <= 2; back++) {
    const date = new Date(todayMidnight - back * DAY_MS);
    const instant = wallTimeToInstant(timeZone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), time.hour, time.minute);
    if (instant <= nowMs) return new Date(instant);
  }
  throw new Error(`No daily slot found for ${at} ${timeZone} before ${now.toISOString()}`);
}
