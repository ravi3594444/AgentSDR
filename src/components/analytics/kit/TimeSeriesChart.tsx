"use client";

import { useId } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalyticsRange, TimeSeries } from "@/lib/analytics/contract";
import { AXIS_TEXT, formatBucket, formatCompact, GRID_STROKE, MUTED, SURFACE } from "../theme";
import { DataTableView, type TableColumn } from "./DataTableView";
import { EmptyChart } from "./EmptyChart";

/**
 * Time-series chart on Recharts, following the mark specs: 2px lines, bars at
 * most 24px with a 4px round data-end (top segment only) and a 2px surface gap
 * between stacked segments, area fill at 10%, hairline solid gridlines, one
 * y-axis. Tooltip = crosshair + every series at that x, values first, line keys.
 * Render the legend yourself in ChartCard's `legend` slot (ChartLegend).
 *
 * Props:
 * - series: TimeSeries<K> from the contract
 * - keys: { [key]: { label, color } } — which series to draw, in stack order
 * - type: "line" | "area" | "stackedBar" | "bar"
 * - valueFormat: number -> string for tooltip and table (default formatCompact)
 * - bucket: "day" | "week" for x labels ("1 Sep" / tooltip "Week of 1 Sep")
 * - height: plot height px including the x-axis band (default 260)
 * - showYAxis: compact y ticks on the left (default true); omit them when the
 *   header (SeriesStats) and tooltip already carry the values
 * - highlight: (bar only) a bucket date to emphasise — every other bar turns
 *   de-emphasis gray, the highlighted one keeps the series colour
 * - barSize: max bar thickness, default 24 (16 automatically past 20 points)
 * Companion: <TimeSeriesTable> renders the same data for ChartCard's `table`.
 */
export type SeriesKeys<K extends string> = Record<K, { label: string; color: string }>;
export type TimeSeriesType = "line" | "area" | "stackedBar" | "bar";

type TooltipItem = { dataKey?: unknown; value?: unknown };
type TooltipArgs = { active?: boolean; payload?: readonly TooltipItem[]; label?: unknown };

function ChartTooltip<K extends string>({ active, payload, label, keys, order, bucket, valueFormat, showTotal }: TooltipArgs & { keys: SeriesKeys<K>; order: K[]; bucket: "day" | "week"; valueFormat: (n: number) => string; showTotal: boolean }) {
  if (!active || !payload?.length) return null;
  const byKey = new Map(payload.map((p) => [String(p.dataKey), Number(p.value ?? 0)]));
  return (
    <div className="min-w-44 rounded-lg bg-bg-white-0 p-3 shadow-regular-md ring-1 ring-inset ring-stroke-soft-200">
      <p className="mb-2 text-paragraph-xs text-text-sub-600">{formatBucket(String(label), bucket, true)}</p>
      <ul className="space-y-1.5">
        {order.map((key) => (
          <li key={key} className="flex items-center gap-2">
            <span aria-hidden="true" className="h-0.5 w-3 shrink-0 rounded-full" style={{ backgroundColor: keys[key].color }} />
            <span className="text-label-sm tabular-nums text-text-strong-950">{valueFormat(byKey.get(key) ?? 0)}</span>
            <span className="text-paragraph-xs text-text-sub-600">{keys[key].label}</span>
          </li>
        ))}
      </ul>
      {showTotal && (
        <div className="mt-2 flex items-center justify-between gap-4 border-t border-stroke-soft-200 pt-2">
          <span className="text-paragraph-xs text-text-sub-600">Total</span>
          <span className="text-label-sm tabular-nums text-text-strong-950">{valueFormat(order.reduce((sum, k) => sum + (byKey.get(k) ?? 0), 0))}</span>
        </div>
      )}
    </div>
  );
}

type RectProps = { x?: number; y?: number; width?: number; height?: number; fill?: string; payload?: Record<string, unknown> };

/** A stacked-bar segment: square at the baseline, 4px round at the data end when it is the topmost non-zero segment. */
function Segment({ x = 0, y = 0, width = 0, height = 0, fill, isTop, opacity = 1 }: RectProps & { isTop: boolean; opacity?: number }) {
  if (height <= 0 || width <= 0) return null;
  const r = isTop ? Math.min(4, width / 2, height) : 0;
  const d = `M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height} Z`;
  return <path d={d} fill={fill} fillOpacity={opacity} stroke={SURFACE} strokeWidth={2} />;
}

export function TimeSeriesChart<K extends string>({
  series,
  keys,
  type,
  valueFormat = formatCompact,
  bucket,
  height = 260,
  showYAxis = true,
  highlight,
  barSize,
}: {
  series: TimeSeries<K>;
  keys: SeriesKeys<K>;
  type: TimeSeriesType;
  valueFormat?: (value: number) => string;
  bucket: AnalyticsRange["bucket"];
  height?: number;
  showYAxis?: boolean;
  highlight?: string;
  barSize?: number;
}) {
  const gradientId = useId().replace(/:/g, "");
  const order = (Object.keys(keys) as K[]).filter((k) => series.keys.includes(k));
  const hasData = series.points.some((p) => order.some((k) => p[k] > 0));
  if (!hasData) return <EmptyChart height={height} />;

  const margin = { top: 8, right: 8, bottom: 0, left: showYAxis ? 0 : 8 };
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeWidth={1} />
      <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={10} minTickGap={44} interval="preserveStartEnd" tick={{ fill: AXIS_TEXT, fontSize: 13 }} tickFormatter={(v: string) => formatBucket(v, bucket)} />
      {showYAxis ? <YAxis width={40} tickLine={false} axisLine={false} tickCount={4} allowDecimals={false} tick={{ fill: AXIS_TEXT, fontSize: 13 }} tickFormatter={(v: number) => formatCompact(v)} /> : <YAxis hide />}
    </>
  );
  const tooltip = (cursor: object) => (
    <Tooltip
      cursor={cursor}
      isAnimationActive={false}
      content={(props) => <ChartTooltip {...(props as TooltipArgs)} keys={keys} order={order} bucket={bucket} valueFormat={valueFormat} showTotal={type === "stackedBar" && order.length > 1} />}
    />
  );
  const cursor = { stroke: GRID_STROKE, strokeWidth: 1 };
  const maxBar = barSize ?? (series.points.length > 20 ? 16 : 24);
  
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        {type === "line" ? (
          <LineChart data={series.points} margin={margin}>
            {axes}
            {tooltip(cursor)}
            {order.map((k) => (
              <Line key={k} type="monotone" dataKey={k} stroke={keys[k].color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" isAnimationActive={false} dot={false} activeDot={{ r: 4, fill: keys[k].color, stroke: SURFACE, strokeWidth: 2 }} />
            ))}
          </LineChart>
        ) : type === "area" ? (
          <AreaChart data={series.points} margin={margin}>
            <defs>
              {order.map((k) => (
                <linearGradient key={k} id={`${gradientId}-${k}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={keys[k].color} stopOpacity={0.14} />
                  <stop offset="100%" stopColor={keys[k].color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            {axes}
            {tooltip(cursor)}
            {order.map((k) => (
              <Area key={k} type="monotone" dataKey={k} stroke={keys[k].color} strokeWidth={2} fill={`url(#${gradientId}-${k})`} isAnimationActive={false} dot={false} activeDot={{ r: 4, fill: keys[k].color, stroke: SURFACE, strokeWidth: 2 }} />
            ))}
          </AreaChart>
        ) : (
          <BarChart data={series.points} margin={margin} barCategoryGap="20%">
            {axes}
            {tooltip(cursor)}
            {order.map((k) => (
              <Bar
                key={k}
                dataKey={k}
                fill={keys[k].color}
                stackId={type === "stackedBar" ? "stack" : undefined}
                maxBarSize={maxBar}
                isAnimationActive={false}
                shape={(p: unknown) => {
                  const rect = p as RectProps;
                  const row = rect.payload ?? {};
                  const above = order.slice(order.indexOf(k) + 1);
                  const isTop = type === "bar" || !above.some((other) => Number(row[other] ?? 0) > 0);
                  const dim = highlight !== undefined && String(row.date) !== highlight;
                  return <Segment {...rect} fill={dim ? MUTED : keys[k].color} opacity={dim ? 0.6 : 1} isTop={isTop} />;
                }}
              />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/** The table twin of a TimeSeriesChart: one row per bucket, one column per key (plus Total when stacked/multi). */
export function TimeSeriesTable<K extends string>({ series, keys, bucket, valueFormat = (n) => n.toLocaleString("en-US"), caption }: { series: TimeSeries<K>; keys: SeriesKeys<K>; bucket: AnalyticsRange["bucket"]; valueFormat?: (value: number) => string; caption: string }) {
  const order = (Object.keys(keys) as K[]).filter((k) => series.keys.includes(k));
  const columns: TableColumn[] = [
    { key: "date", label: bucket === "week" ? "Week of" : "Date" },
    ...order.map((k) => ({ key: k, label: keys[k].label, align: "right" as const, swatch: keys[k].color, format: (v: string | number | null) => valueFormat(Number(v ?? 0)) })),
  ];
  if (order.length > 1) columns.push({ key: "total", label: "Total", align: "right", format: (v) => valueFormat(Number(v ?? 0)) });
  const rows = series.points.map((point) => ({
    date: formatBucket(point.date, bucket, true),
    ...Object.fromEntries(order.map((k) => [k, point[k]])),
    total: order.reduce((sum, k) => sum + point[k], 0),
  }));
  return <DataTableView columns={columns} rows={rows} caption={caption} />;
}

/** Sum of one key across the series, for legend totals. */
export function seriesTotal<K extends string>(series: TimeSeries<K>, key: K): number {
  return series.points.reduce((sum, p) => sum + p[key], 0);
}
