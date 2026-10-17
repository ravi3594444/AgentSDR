/**
 * When a channel may send next, and how to say it. Pure (no database), so the
 * Results page, the assistant's results tool and the daily summary all
 * describe sending from the same rules the send engines gate on
 * (`src/lib/outreach/workingHours.ts`): a closed window here is exactly the
 * scheduler's `skippedOutsideHours`.
 */
import { fromZonedTime, toZonedTime } from "date-fns-tz";

import type { WeeklyHours } from "./rules";
import type { WorkingHours } from "@/lib/outreach/schema";
import { isWithinWorkingHours, mailboxHoursFromWeekly } from "@/lib/outreach/workingHours";

export type SendingWindow = {
  /** True inside the window, or when no hours are set (any time). */
  open: boolean;
  /** The next instant the window opens, when it is closed and a later opening exists. */
  opensAt: Date | null;
};

const DAY_MS = 86_400_000;

/** Monday-first, matching how a person reads a week. */
const WEEK = [
  { key: "monday", short: "Mon" },
  { key: "tuesday", short: "Tue" },
  { key: "wednesday", short: "Wed" },
  { key: "thursday", short: "Thu" },
  { key: "friday", short: "Fri" },
  { key: "saturday", short: "Sat" },
  { key: "sunday", short: "Sun" },
] as const;

/** `Date#getDay()` is Sunday-first. */
const KEY_BY_JS_DAY = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/** The earliest start strictly after `now`, looking one week ahead (so a closed window always finds its next day). */
function nextOpening(working: WorkingHours, now: Date): Date | null {
  for (let offset = 0; offset <= 7; offset += 1) {
    const zoned = toZonedTime(new Date(now.getTime() + offset * DAY_MS), working.timezone);
    const day = working.days[KEY_BY_JS_DAY[zoned.getDay()]!];
    if (!day?.enabled) continue;
    const [hours, minutes] = day.from.split(":").map(Number);
    const start = new Date(zoned);
    start.setHours(hours || 0, minutes || 0, 0, 0);
    const at = fromZonedTime(start, working.timezone);
    if (at.getTime() > now.getTime()) return at;
  }
  return null;
}

/** The window of a mailbox (or any `WorkingHours`, which may set different times per day). */
export function workingWindow(working: WorkingHours, now: Date = new Date()): SendingWindow {
  if (isWithinWorkingHours(working, now)) return { open: true, opensAt: null };
  return { open: false, opensAt: nextOpening(working, now) };
}

/** The window of a channel rule (`sendingHours`). Null means any time. */
export function sendingWindow(hours: WeeklyHours | null, now: Date = new Date()): SendingWindow {
  if (!hours) return { open: true, opensAt: null };
  return workingWindow(mailboxHoursFromWeekly(hours), now);
}

/** "Mon–Fri", "Mon, Wed, Fri", "every day", "no days" — from Monday-first indexes. */
function dayRuns(indexes: number[]): string {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  if (!sorted.length) return "no days";
  if (sorted.length === 7) return "every day";
  const runs: string[] = [];
  let start = sorted[0]!;
  let previous = start;
  for (let index = 1; index <= sorted.length; index += 1) {
    const day = sorted[index];
    if (day !== undefined && day === previous + 1) {
      previous = day;
      continue;
    }
    runs.push(start === previous ? WEEK[start]!.short : `${WEEK[start]!.short}–${WEEK[previous]!.short}`);
    if (day !== undefined) {
      start = day;
      previous = day;
    }
  }
  return runs.join(", ");
}

/** How a mailbox's hours read in a sentence: "Mon–Fri 09:00–18:00 (Asia/Kolkata)". */
export function describeWorkingHours(working: WorkingHours): string {
  const enabled = WEEK.filter(({ key }) => working.days[key].enabled);
  if (!enabled.length) return `no sending days enabled, ${working.timezone}`;
  const windows = new Set(enabled.map(({ key }) => `${working.days[key].from}–${working.days[key].to}`));
  const times = windows.size === 1 ? [...windows][0]! : "times vary by day";
  const indexes = enabled.map(({ key }) => WEEK.findIndex((day) => day.key === key));
  return `${dayRuns(indexes)} ${times} (${working.timezone})`;
}

/** How a channel rule's hours read in a sentence, or null when it may send any time. */
export function describeWeeklyHours(hours: WeeklyHours | null): string | null {
  return hours ? describeWorkingHours(mailboxHoursFromWeekly(hours)) : null;
}

/** "Monday 19 Oct at 09:00", in the window's own time zone. */
export function describeOpening(at: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "short" }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  return `${day} at ${time}`;
}
