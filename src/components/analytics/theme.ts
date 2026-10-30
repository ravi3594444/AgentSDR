import { RiGlobalLine, RiInstagramFill, RiLinkedinBoxFill, RiMailFill, RiWhatsappFill } from "@remixicon/react";
import type { ComponentType } from "react";
import type { AnalyticsChannel } from "@/lib/analytics/contract";

/**
 * Analytics design tokens: the chart palette, the fixed channel identity,
 * and the number formatters every chart and tile shares.
 *
 * The palette is AlignUI's own hue scale (blue, orange, green, purple, teal,
 * pink, sky at their 500/600 steps, plus a slightly deeper amber so it keeps
 * contrast on white), so charts sit in the same family as badges and
 * buttons. Validated with the dataviz checker: every hue inside the
 * lightness band, adjacent slots distinguishable with colour-blindness.
 *
 * Colour rules the kit relies on:
 * - Channel colours are identity. LinkedIn blue, Email orange, WhatsApp
 *   green, everywhere, in that order of slots.
 * - Status colours mean good/bad only, and always travel with an icon + label.
 * - Text never wears a series colour: use AlignUI text tokens beside a swatch.
 * - The two grays are CSS variables (globals.css) so they re-tone in dark mode.
 */

export const HUE = {
  blue: "#335cff",
  orange: "#fa7319",
  green: "#1fc16b",
  purple: "#7d52f4",
  teal: "#1daf9c",
  amber: "#e5930a",
  pink: "#fb4ba3",
  sky: "#35ade9",
  red: "#fb3748",
} as const;

export const CHANNEL_META: Record<
  AnalyticsChannel,
  { label: string; color: string; icon: ComponentType<{ className?: string }> }
> = {
  linkedin: { label: "LinkedIn", color: HUE.blue, icon: RiLinkedinBoxFill },
  email: { label: "Email", color: HUE.orange, icon: RiMailFill },
  whatsapp: { label: "WhatsApp", color: HUE.green, icon: RiWhatsappFill },
};

/**
 * Conversation channels (the CRM's): the analytics channels plus Instagram,
 * which has conversations but no campaigns or analytics view of its own.
 */
export const CONVERSATION_CHANNEL_META: Record<
  AnalyticsChannel | "instagram" | "browser",
  { label: string; color: string; icon: ComponentType<{ className?: string }> }
> = {
  ...CHANNEL_META,
  instagram: { label: "Instagram", color: HUE.pink, icon: RiInstagramFill },
  // Messages sent through the owner's own signed-in Chrome (X, Instagram, Facebook, LinkedIn).
  browser: { label: "Browser", color: HUE.purple, icon: RiGlobalLine },
};

/** Categorical slots after the three channel slots, in this order only. */
export const CATEGORICAL_EXTRA = [HUE.purple, HUE.teal, HUE.amber, HUE.pink, HUE.sky] as const;
/** Slot 1 — the single-hue default for one-series charts. */
export const ACCENT = HUE.blue;
/** Ordinal ramp for ordered stages (funnels): AlignUI blue 300 → 800. */
export const ORDINAL_BLUE = ["#97baff", "#739eff", "#4d82ff", "#335cff", "#2547d0", "#1f3bad"] as const;
/** De-emphasis gray: "other", previous period, not-yet. */
export const MUTED = "var(--chart-muted)";
/** A second, darker neutral for a gray that must stand apart from MUTED. */
export const MUTED_STRONG = "var(--chart-muted-strong)";

export const STATUS = {
  good: HUE.green,
  warning: HUE.amber,
  serious: HUE.orange,
  critical: HUE.red,
} as const;

/** CRM categories: one colour everywhere (charts, donuts, badges' dots). */
export const CRM_CATEGORY_COLOR = {
  interested: HUE.teal,
  customer: HUE.purple,
  not_interested: HUE.red,
  other: HUE.amber,
  unclassified: MUTED,
} as const;

/** Chart chrome. */
export const GRID_STROKE = "var(--color-stroke-soft-200)";
export const AXIS_TEXT = "var(--color-text-soft-400)";
export const SURFACE = "var(--color-bg-white-0)";

/** Picks `count` ramp colours, light to dark, spread across the ramp. */
export function ordinalRamp(count: number): string[] {
  if (count <= 1) return [ORDINAL_BLUE[3]];
  return Array.from({ length: count }, (_, i) => ORDINAL_BLUE[Math.round((i * (ORDINAL_BLUE.length - 1)) / (count - 1))]);
}

// ------------------------------------------------------------- formatters

/** 1,284 stays whole; from 10,000 it compacts: 12.9K, 1.2M. */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  if (abs < 10_000) return Math.round(value).toLocaleString("en-US");
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, "");
  if (abs < 1_000_000) return `${trim(value / 1_000)}K`;
  if (abs < 1_000_000_000) return `${trim(value / 1_000_000)}M`;
  return `${trim(value / 1_000_000_000)}B`;
}

/** A 0..1 rate as "18%" (one decimal under 10%: "4.6%"); null renders "—". */
export function formatPercent(value: number | null | undefined, digits?: number): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const pct = value * 100;
  const d = digits ?? (Math.abs(pct) < 10 && pct !== 0 ? 1 : 0);
  return `${pct.toFixed(d).replace(/\.0$/, "")}%`;
}

/** Signed change as "+12%" / "−8%". */
export function formatChange(value: number): string {
  const pct = Math.abs(value * 100);
  const text = pct < 10 ? pct.toFixed(1).replace(/\.0$/, "") : Math.round(pct).toLocaleString("en-US");
  return `${value < 0 ? "−" : "+"}${text}%`;
}

/** Milliseconds as "45s", "3h 12m", "2d 4h". null renders "—". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

/** Minutes as a duration: 192 -> "3h 12m". */
export function formatMinutes(minutes: number | null | undefined): string {
  return minutes === null || minutes === undefined ? "—" : formatDuration(minutes * 60_000);
}

export type DeltaTone = "good" | "bad" | "neutral";

/** Colour meaning of a change: direction × whether up is good. Under 0.5% is neutral. */
export function deltaTone(change: number | null, upIsGood = true): DeltaTone {
  if (change === null || Math.abs(change) < 0.005) return "neutral";
  return change > 0 === upIsGood ? "good" : "bad";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-01" -> "1 Sep". */
export function formatDay(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ""}`;
}

/** "2026-09-01" -> "1 Sep 2026". */
export function formatDayLong(date: string): string {
  return `${formatDay(date)} ${date.slice(0, 4)}`;
}

/** Bucket start as an axis label ("1 Sep") or, with `long`, a tooltip/table label ("Week of 1 Sep"). */
export function formatBucket(date: string, bucket: "day" | "week", long = false): string {
  if (bucket === "week") return long ? `Week of ${formatDay(date)}` : formatDay(date);
  return long ? formatDayLong(date) : formatDay(date);
}
