import { daysWindow, localDate, presetDays, shiftDate, type SharedPreset } from "@/lib/reporting/metrics";
import { resolveTimeZone } from "@/lib/timeZone";
import { dayCount, MAX_ANALYTICS_RANGE_DAYS, WEEKLY_BUCKET_AFTER_DAYS, type AnalyticsRange } from "./contract";

/**
 * Analytics date ranges: the presets, the ?range= spelling, and the local
 * days each covers. Pure, so the page, the client and the API resolve a
 * range the same way. Today, Yesterday, Last 7 days and Last 30 days are
 * Overview's periods too: they resolve through the shared calendar
 * (src/lib/reporting/metrics.ts), so both pages read the same [from, to)
 * in the organization's time zone.
 */

export const RANGE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
] as const;
export type PresetKey = (typeof RANGE_PRESETS)[number]["key"];
export type RangeSelection = { kind: "preset"; key: PresetKey } | { kind: "custom"; from: string; to: string };

export const DEFAULT_RANGE: RangeSelection = { kind: "preset", key: "30d" };

/** The Analytics presets that are Overview periods, by the shared preset they are. */
export const SHARED_PRESET_OF: Partial<Record<PresetKey, SharedPreset>> = {
  today: "today",
  yesterday: "yesterday",
  "7d": "last_7_days",
  "30d": "last_30_days",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A ?range= value as a selection, or null when it is not one. */
export function readRange(value: string | null | undefined): RangeSelection | null {
  if (!value) return null;
  const preset = RANGE_PRESETS.find((p) => p.key === value);
  if (preset) return { kind: "preset", key: preset.key };
  const [from, to] = value.split("..");
  if (from && to && DATE_RE.test(from) && DATE_RE.test(to) && from <= to) return { kind: "custom", from, to };
  return null;
}

/** A ?range= value as a selection; the default when it is not one. */
export function parseRange(value: string | undefined): RangeSelection {
  return readRange(value) ?? DEFAULT_RANGE;
}

export function serializeRange(selection: RangeSelection): string {
  return selection.kind === "preset" ? selection.key : `${selection.from}..${selection.to}`;
}

/** The inclusive local days a selection covers, from the local date it is today. */
export function resolveRange(selection: RangeSelection, today: string): { from: string; to: string } {
  if (selection.kind === "custom") return { from: selection.from, to: selection.to };
  const shared = SHARED_PRESET_OF[selection.key];
  if (shared) return presetDays(shared, today);
  switch (selection.key) {
    case "90d":
      return { from: shiftDate(today, -89), to: today };
    case "this-month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "last-month": {
      const to = shiftDate(`${today.slice(0, 8)}01`, -1);
      return { from: `${to.slice(0, 8)}01`, to };
    }
    default:
      return presetDays("last_30_days", today);
  }
}

export class AnalyticsRangeError extends Error {}

/**
 * The range a request asks for. The time zone is the organization's
 * business time zone unless the request names one (?tz=, an override the
 * page labels). The days come from ?range= (a preset, resolved on "today"
 * in that zone, or from..to) or from ?from&to. Weekly buckets past
 * WEEKLY_BUCKET_AFTER_DAYS.
 */
export function analyticsRange(params: URLSearchParams, organizationTimeZone: string, now = new Date()): AnalyticsRange {
  const override = params.get("tz");
  const tz = override ? resolveTimeZone(override) : resolveTimeZone(organizationTimeZone);
  const requested = params.get("range");
  const selection = requested ? readRange(requested) : null;
  if (requested && !selection) throw new AnalyticsRangeError(`Unknown range: ${requested.slice(0, 40)}`);
  const days = selection ? resolveRange(selection, localDate(tz, now)) : { from: params.get("from") ?? "", to: params.get("to") ?? "" };
  if (!DATE_RE.test(days.from) || !DATE_RE.test(days.to) || Number.isNaN(Date.parse(days.from)) || Number.isNaN(Date.parse(days.to))) {
    throw new AnalyticsRangeError("from and to must be dates as YYYY-MM-DD");
  }
  if (days.from > days.to) throw new AnalyticsRangeError("from must not be after to");
  const count = dayCount(days.from, days.to);
  if (count > MAX_ANALYTICS_RANGE_DAYS) throw new AnalyticsRangeError(`The range can be at most ${MAX_ANALYTICS_RANGE_DAYS} days`);
  const window = daysWindow(days, tz);
  return {
    from: days.from,
    to: days.to,
    tz,
    tzSource: override ? "override" : "organization",
    preset: selection?.kind === "preset" ? selection.key : null,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    bucket: count > WEEKLY_BUCKET_AFTER_DAYS ? "week" : "day",
  };
}
