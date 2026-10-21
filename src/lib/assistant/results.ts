import { dayStart, daysWindow, localDate, presetDays, shiftDate } from "@/lib/reporting/metrics";

/**
 * Reporting periods in the business's own time zone, and how results are
 * written for the owner. Pure. A figure that cannot be measured from what
 * the app records is `null` and reads "not measured", never 0.
 *
 * A period is whole local days, [first day 00:00, the day after the last
 * 00:00), on the shared calendar of src/lib/reporting/metrics.ts: "today"
 * or "the last 7 days" here is the same window Analytics reads for its
 * preset of the same name.
 */

export type PeriodKind = "today" | "yesterday" | "last_7_days" | "last_30_days" | "all_time";
export const PERIOD_KINDS: readonly PeriodKind[] = ["today", "yesterday", "last_7_days", "last_30_days", "all_time"];

export type Period = {
  kind: PeriodKind;
  from: Date | null;
  to: Date;
  timeZone: string;
  /** The inclusive local days it covers; null for all time. */
  days: { from: string; to: string } | null;
  label: string;
};

/** The calendar day it is at `instant` in this time zone, e.g. "2026-10-18". */
export { localDate };

export function periodFor(kind: PeriodKind, timeZone: string, now = new Date()): Period {
  const today = localDate(timeZone, now);
  if (kind === "all_time") return { kind, from: null, to: dayStart(shiftDate(today, 1), timeZone), timeZone, days: null, label: "all time" };
  const days = presetDays(kind, today);
  const { from, to } = daysWindow(days, timeZone);
  const label = kind === "today"
    ? `today (${today})`
    : kind === "yesterday"
      ? `yesterday (${days.from})`
      : `the last ${kind === "last_7_days" ? 7 : 30} days (${days.from} to today)`;
  return { kind, from, to, timeZone, days, label };
}

/**
 * Whose work a report counts. "organization" is everything; the others
 * restrict every ledger query to the outreach runs, lead lists and jobs of
 * one run, one owner request (the plans and searches it started) or one
 * chat. Limits and the channels' sending checks stay organization-wide:
 * they are shared by every run.
 */
export type ResultsScopeKind = "run" | "request" | "thread" | "organization";
export const RESULTS_SCOPE_KINDS: readonly ResultsScopeKind[] = ["run", "request", "thread", "organization"];

export type ResultsScope = {
  kind: ResultsScopeKind;
  runIds: string[];
  audienceIds: string[];
  jobIds: string[];
  /** A run's name, for scope "run". */
  name?: string | null;
};

export const ORGANIZATION_SCOPE: ResultsScope = { kind: "organization", runIds: [], audienceIds: [], jobIds: [] };

/** What a scope covers, in words: "this request (2 plans, 3 searches)". */
export function scopeLabel(scope: ResultsScope): string {
  if (scope.kind === "organization") return "the whole organization";
  const plans = `${scope.runIds.length} plan${scope.runIds.length === 1 ? "" : "s"}`;
  const searches = scope.jobIds.length ? `, ${scope.jobIds.length} background job${scope.jobIds.length === 1 ? "" : "s"}` : "";
  if (scope.kind === "run") return `the plan “${scope.name ?? "this run"}”`;
  const what = scope.kind === "request" ? "this request" : "this chat";
  return scope.runIds.length || scope.jobIds.length ? `${what} (${plans}${searches})` : what;
}

/** Whether a narrower scope has nothing attributed to it yet: its figures are then all zero for that reason. */
export function scopeIsEmpty(scope: ResultsScope): boolean {
  return scope.kind !== "organization" && !scope.runIds.length && !scope.audienceIds.length && !scope.jobIds.length;
}

/** The local calendar day a summary written at `now` covers: the day before. */
export function summaryDay(timeZone: string, now = new Date()): { day: string; period: Period } {
  const period = periodFor("yesterday", timeZone, now);
  return { day: period.days!.from, period };
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
 * not when it cannot, from the same gates the send engines check
 * (results.server.ts). Sending is always on: no channel has sending hours.
 */
export type ChannelSending = {
  /** No measured gate is blocking due work; does not prove the worker is sending. */
  open: boolean;
  blockedBy: "paused" | "no_sender" | "daily_limit" | "nothing_queued" | "throttled" | "sender_checks" | null;
  /** Additional recorded blockers, or checks this snapshot does not measure. */
  detail?: string;
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
    case "daily_limit":
      return "has used its mailboxes' daily send limits; each starts again at its own midnight";
    case "nothing_queued":
      return "has nothing due to send right now";
    case "throttled":
      return "is pausing between sends";
    case "sender_checks":
      return `has messages held by its senders${sending.detail ? `: ${sending.detail}` : ""}`;
    default:
      return `has emails due and ready for the next send${sending.detail ? `; ${sending.detail}` : ""}`;
  }
}

/** A share as a whole percentage, "not measured" when there is no base. */
export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "not measured";
  return `${Math.round(value * 100)}%`;
}
