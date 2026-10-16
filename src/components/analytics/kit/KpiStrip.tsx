"use client";

import { RiInformationLine } from "@remixicon/react";
import * as Tooltip from "@/components/alignui/tooltip";
import { cn } from "@/utils/cn";
import { DeltaPill } from "./DeltaPill";
import { Frame, FramePanel } from "./Frame";
import { Sparkline } from "./Sparkline";

/**
 * A row of headline numbers in one Frame, split by vertical hairlines (two
 * columns on mobile). Put <KpiCell>s inside <KpiStrip>.
 *
 * KpiStrip props: `columns` (cells per row at lg, default = number of children
 * up to 6), `children`.
 *
 * KpiCell props:
 * - icon: a Remix icon component shown in a small chip
 * - label, value (pre-formatted string: "1,284", "38%", "3h 12m")
 * - metric: { value, previous } -> delta pill; omit for none. `upIsGood`
 *   (default true) flips green/red, e.g. for bounces.
 * - context: line under the value ("vs 2,854 previous period", "of 2,061 contacted")
 * - hint: tooltip text that defines the metric (every KPI should explain itself)
 * - spark: number[] trend, drawn in the de-emphasis gray, top-right beside the icon
 * - selected / onSelect: optional switcher behaviour (button with aria-pressed)
 */
export function KpiStrip({ children, columns, className }: { children: React.ReactNode; columns: number; className?: string }) {
  return (
    <Frame className={className}>
      <FramePanel className="overflow-hidden p-0 sm:p-0">
        <div
          className="grid grid-cols-2 gap-px bg-stroke-soft-200 lg:grid-cols-[repeat(var(--cols),minmax(0,1fr))] [&>*:last-child:nth-child(odd)]:col-span-2 lg:[&>*:last-child:nth-child(odd)]:col-span-1"
          style={{ "--cols": columns } as React.CSSProperties}
        >
          {children}
        </div>
      </FramePanel>
    </Frame>
  );
}

export function KpiCell({
  icon: Icon,
  label,
  value,
  metric,
  upIsGood = true,
  context,
  hint,
  spark,
  selected,
  onSelect,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  metric?: { value: number | null; previous: number | null };
  upIsGood?: boolean;
  context?: string;
  hint?: string;
  spark?: number[];
  selected?: boolean;
  onSelect?: () => void;
}) {
  return (
    <div className={cn("relative flex min-w-0 flex-col gap-3 bg-bg-white-0 p-4 transition-colors sm:p-5", selected && "bg-bg-weak-50 shadow-[inset_0_2px_0_var(--color-primary-base)]")}>
      {onSelect && <button type="button" onClick={onSelect} aria-pressed={Boolean(selected)} aria-label={`Show ${label}`} className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-base" />}
      <div className="flex items-center justify-between gap-2">
        {Icon ? (
          <span className="flex size-8 items-center justify-center rounded-lg border border-stroke-soft-200">
            <Icon className="size-4 text-text-sub-600" />
          </span>
        ) : (
          <span />
        )}
        {/* Top-right, beside the icon, so the context line below keeps the full width. */}
        {spark && spark.length > 1 && <Sparkline data={spark} type="line" color="var(--chart-muted)" highlightLast height={28} className="hidden w-20 shrink-0 sm:block" />}
      </div>
      <div>
        <div className="flex items-center gap-1.5">
          <p className="text-paragraph-sm text-text-sub-600">{label}</p>
          {hint && (
            <Tooltip.Provider delayDuration={150}>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <button type="button" aria-label={`What is “${label}”?`} className="relative z-10 rounded text-text-soft-400 outline-none hover:text-text-sub-600 focus-visible:ring-2 focus-visible:ring-primary-base">
                    <RiInformationLine className="size-3.5" aria-hidden="true" />
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Content side="top" className="max-w-64">
                  {hint}
                </Tooltip.Content>
              </Tooltip.Root>
            </Tooltip.Provider>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-[32px] font-medium leading-none tracking-[-0.045em] tabular-nums text-text-strong-950">{value}</p>
          {metric && <DeltaPill metric={metric} upIsGood={upIsGood} />}
        </div>
      </div>
      <p className="min-h-4 text-paragraph-xs text-text-sub-600">{context}</p>
    </div>
  );
}
