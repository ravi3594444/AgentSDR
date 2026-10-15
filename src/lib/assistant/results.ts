import { latestDailySlot, wallTime } from "@/lib/scheduler/slots";

/**
 * Reporting periods in the business's own time zone, and how results are
 * written for the owner. Pure. A figure that cannot be measured from what
 * the app records is `null` and reads "not measured", never 0.
 */

export type PeriodKind = "today" | "yesterday" | "last_7_days" | "last_30_days" | "all_time";
export const PERIOD_KINDS: readonly PeriodKind[] = ["today", "yesterday", "last_7_days", "last_30_days", "all_time"];

export type Period = { kind: PeriodKind; from: Date | null; to: Date; timeZone: string; label: string };

function dayLabel(timeZone: string, instant: Date): string {
  const wall = wallTime(timeZone, instant.getTime());
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

/** The local start of the day `daysBack` days before the day containing `now`. */
function dayStart(timeZone: string, now: Date, daysBack: number): Date {
  let start = latestDailySlot(timeZone, "00:00", now);
  for (let index = 0; index < daysBack; index += 1) start = latestDailySlot(timeZone, "00:00", new Date(start.getTime() - 1));
  return start;
}

export function periodFor(kind: PeriodKind, timeZone: string, now = new Date()): Period {
  const today = dayStart(timeZone, now, 0);
  switch (kind) {
    case "today":
      return { kind, from: today, to: now, timeZone, label: `today (${dayLabel(timeZone, today)})` };
    case "yesterday": {
      const from = dayStart(timeZone, now, 1);
      return { kind, from, to: today, timeZone, label: `yesterday (${dayLabel(timeZone, from)})` };
    }
    case "last_7_days": {
      const from = dayStart(timeZone, now, 6);
      return { kind, from, to: now, timeZone, label: `the last 7 days (${dayLabel(timeZone, from)} to today)` };
    }
    case "last_30_days": {
      const from = dayStart(timeZone, now, 29);
      return { kind, from, to: now, timeZone, label: `the last 30 days (${dayLabel(timeZone, from)} to today)` };
    }
    default:
      return { kind: "all_time", from: null, to: now, timeZone, label: "all time" };
  }
}

/** The local calendar day a summary written at `now` covers: the day before. */
export function summaryDay(timeZone: string, now = new Date()): { day: string; period: Period } {
  const period = periodFor("yesterday", timeZone, now);
  return { day: dayLabel(timeZone, period.from!), period };
}

export function figure(value: number | null | undefined, unit = ""): string {
  if (value === null || value === undefined) return "not measured";
  return `${value}${unit}`;
}

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "not recorded";
  if (value > 0 && value < 0.01) return "< $0.01";
  return `$${value.toFixed(2)}`;
}
