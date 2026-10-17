import { latestDailySlot, wallTime } from "@/lib/scheduler/slots";
import { sourceLabel } from "./qualification";

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

/**
 * Whether a channel can send at the moment the results were read, and why
 * not when it cannot. Computed from the same working-hours rules the send
 * engines gate on, so "outside its sending hours" here is the scheduler's
 * `skippedOutsideHours`, not a guess (results.server.ts).
 */
export type ChannelSending = {
  /** True when the channel may send now: open window, sender, room and something queued. */
  open: boolean;
  blockedBy: "paused" | "no_sender" | "outside_hours" | "daily_limit" | "nothing_queued" | null;
  /** ISO instant of the next opening, when the window is what blocks it. */
  nextOpenAt: string | null;
  /** The same instant written in the window's own time zone, e.g. "Monday 19 Oct at 09:00". */
  nextOpenLabel: string | null;
  /** The window that governs, e.g. "Mon–Fri 09:00–18:00 (Asia/Kolkata)"; null is any time. */
  hours: string | null;
  /** Leads waiting to send on this channel right now. */
  queued: number;
};

/** A channel's sending state in words, without repeating the channel's name. */
export function describeChannelSending(sending: ChannelSending): string {
  switch (sending.blockedBy) {
    case "paused":
      return "is paused by an operations switch";
    case "no_sender":
      return "has no connected sending account";
    case "outside_hours":
      return `is outside its sending hours${sending.hours ? ` (${sending.hours})` : ""}${sending.nextOpenLabel ? ` — next send ${sending.nextOpenLabel}` : ""}`;
    case "daily_limit":
      return "has used today's allowance — it resets at the start of your day";
    case "nothing_queued":
      return "has nothing queued — the daily queue is built at the start of your day";
    default:
      return "is sending";
  }
}

/**
 * How many leads each source produced, and how many of them can be reached.
 * The question this answers is which source is worth asking for more of:
 * Google Maps is the default only because it needs no setup, not because it
 * is the best for every kind of customer. Sorted by how many were found.
 */
export type SourceYield = {
  source: string;
  /** How the source reads to the owner: "Google Maps listing", "Web search". */
  label: string;
  found: number;
  contactable: number;
  leftOut: number;
};

export function summarizeSources(
  rows: readonly { source: string; status: string; count: number }[],
): SourceYield[] {
  const bySource = new Map<string, SourceYield>();
  for (const row of rows) {
    const source = row.source || "unknown";
    const entry = bySource.get(source) ?? {
      source,
      label: sourceLabel(source),
      found: 0,
      contactable: 0,
      leftOut: 0,
    };
    entry.found += row.count;
    if (row.status === "eligible") entry.contactable += row.count;
    if (row.status === "excluded") entry.leftOut += row.count;
    bySource.set(source, entry);
  }
  return [...bySource.values()].sort((a, b) => b.found - a.found || a.label.localeCompare(b.label));
}
