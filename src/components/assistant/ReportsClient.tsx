"use client";

import { useState } from "react";
import { RiArrowDownSLine } from "@remixicon/react";
import AnalyticsClient from "@/components/analytics/AnalyticsClient";
import type { AnalyticsView } from "@/lib/analytics/contract";
import { cn } from "@/utils/cn";
import ResultsClient, { ANALYTICS_RANGE, type ResultsPayload } from "./ResultsClient";

/**
 * Reports: one page for what Overview and Analytics used to show apart. The
 * summary numbers come first (ResultsClient); By channel (the Analytics
 * views) folds open below and follows the summary's period when a preset
 * covers it. A link that names a view (an old /analytics?view=… bookmark)
 * opens it. Both read the shared metric definitions, so nothing is counted
 * twice or differently.
 */
export default function ReportsClient({ initial, analytics }: {
  initial: ResultsPayload;
  analytics: { view: AnalyticsView; range: string; organizationTimeZone: string; timeZoneOverride: string | null; open: boolean };
}) {
  const [range, setRange] = useState(analytics.range);
  const [open, setOpen] = useState(analytics.open);
  return (
    <ResultsClient initial={initial} onPeriodChange={(period) => { const preset = ANALYTICS_RANGE[period]; if (preset) setRange(preset); }}>
      <section aria-labelledby="by-channel" className="rounded-xl ring-1 ring-inset ring-stroke-soft-200">
        <button id="by-channel" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-4 py-3 text-left">
          <span className="min-w-0 flex-1">
            <span className="block text-label-md text-text-strong-950">By channel</span>
            <span className="block text-paragraph-xs text-text-sub-600">Email, LinkedIn and WhatsApp in detail: funnels, replies, meetings and customers.</span>
          </span>
          <RiArrowDownSLine className={cn("size-5 shrink-0 text-text-soft-400 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </button>
        {open && (
          <div className="border-t border-stroke-soft-200 px-4 py-4">
            <AnalyticsClient key={range} initialView={analytics.view} initialRange={range} organizationTimeZone={analytics.organizationTimeZone} timeZoneOverride={analytics.timeZoneOverride} />
          </div>
        )}
      </section>
    </ResultsClient>
  );
}
