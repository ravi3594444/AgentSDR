import { ANALYTICS_VIEWS, type AnalyticsView } from "@/lib/analytics/contract";

/**
 * Date-range and view URL helpers. Pure (no "use client") so the server page
 * can use them too. The ranges themselves live in src/lib/analytics/range.ts,
 * which the API resolves with as well.
 */

export {
  DEFAULT_RANGE,
  parseRange,
  RANGE_PRESETS,
  resolveRange,
  serializeRange,
  type PresetKey,
  type RangeSelection,
} from "@/lib/analytics/range";

export function parseView(value: string | undefined): AnalyticsView {
  return (ANALYTICS_VIEWS as readonly string[]).includes(value ?? "") ? (value as AnalyticsView) : "overview";
}
