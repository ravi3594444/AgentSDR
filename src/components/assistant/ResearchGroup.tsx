"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  RiArrowDownSLine,
  RiChat3Line,
  RiCheckLine,
  RiCloseCircleLine,
  RiFacebookCircleLine,
  RiGlobalLine,
  RiInstagramLine,
  RiLinkedinBoxLine,
  RiMapPin2Line,
  RiRedditLine,
  RiTimeLine,
  RiTwitterXLine,
} from "@remixicon/react";
import { ProspectsList } from "@/components/assistant/ProspectsList";
import { cn } from "@/utils/cn";
import { Mascot, type MascotMood } from "./Mascot";
import { researchHeadline, researchRow, researchSummary, type ResearchJob, type ResearchMessage, type ResearchRow, type SourceIcon } from "./researchView";

/**
 * The searches a turn started, as one card: the mascot and a line on where
 * the research is, a bar with one segment per search, and a row per search
 * with its source, its live step (and fraction) or its figures; the rest of
 * what each job recorded and its lead list open under the row. Replaces one
 * dense card per search (researchView.ts holds the wording).
 */

const ICONS: Record<SourceIcon, typeof RiMapPin2Line> = {
  maps: RiMapPin2Line,
  linkedin: RiLinkedinBoxLine,
  web: RiGlobalLine,
  instagram: RiInstagramLine,
  facebook: RiFacebookCircleLine,
  reddit: RiRedditLine,
  x: RiTwitterXLine,
  social: RiChat3Line,
};

const live = (row: ResearchRow) => row.state === "running" || row.state === "starting" || row.state === "waiting";

function Segment({ row }: { row: ResearchRow }) {
  return (
    <span
      className={cn(
        "relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full",
        row.state === "done" ? "bg-success-base" : row.state === "failed" ? "bg-error-base" : row.state === "skipped" || row.state === "cancelled" ? "bg-stroke-sub-300" : row.state === "waiting" ? "bg-warning-light" : "bg-bg-soft-200",
      )}
      title={`${row.title}: ${row.step}`}
    >
      {live(row) && row.state !== "waiting" && (
        row.progress
          ? <span className="research-bar absolute inset-y-0 left-0 rounded-full bg-text-strong-950/70" style={{ width: `${Math.round((row.progress.done / row.progress.total) * 100)}%` }} />
          : <span className="research-sweep absolute inset-y-0 left-0 w-1/3 rounded-full bg-text-strong-950/40" />
      )}
    </span>
  );
}

function StateTag({ row }: { row: ResearchRow }) {
  if (row.state === "done") return <span className="inline-flex shrink-0 items-center gap-0.5 text-label-xs text-success-base"><RiCheckLine className="size-3.5" aria-hidden="true" />Done</span>;
  if (row.state === "failed") return <span className="inline-flex shrink-0 items-center gap-0.5 text-label-xs text-error-base"><RiCloseCircleLine className="size-3.5" aria-hidden="true" />{row.step}</span>;
  if (row.state === "waiting") return <span className="inline-flex shrink-0 items-center gap-0.5 text-label-xs text-warning-base"><RiTimeLine className="size-3.5" aria-hidden="true" />Waiting</span>;
  if (row.state === "skipped" || row.state === "cancelled") return <span className="shrink-0 text-label-xs text-text-soft-400">{row.step}</span>;
  return null;
}

function Row({ row, timeZone }: { row: ResearchRow; timeZone: string }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[row.icon];
  const running = live(row);
  const hasMore = row.details.length > 0;
  const percent = row.progress ? Math.round((row.progress.done / row.progress.total) * 100) : null;
  return (
    <li className="research-in px-4 py-3.5">
      <div className="flex items-start gap-3">
        <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl bg-bg-weak-50 text-text-sub-600", running && "text-text-strong-950")} aria-hidden="true">
          <Icon className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="line-clamp-2 min-w-0 flex-1 break-words text-label-sm text-text-strong-950" title={row.title}>{row.title}</p>
            <StateTag row={row} />
          </div>
          <p className="mt-0.5 text-paragraph-xs text-text-soft-400 [overflow-wrap:anywhere]">
            {row.source}
            {(running || row.state === "waiting") && <span className="text-text-sub-600"> · {row.step}{row.progress ? ` · ${row.progress.done} of ${row.progress.total}` : "…"}</span>}
          </p>

          {running && row.state !== "waiting" && (
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-bg-soft-200" role="progressbar" aria-label={row.step} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
              {percent !== null
                ? <div className="research-bar h-full rounded-full bg-text-strong-950" style={{ width: `${percent}%` }} />
                : <div className="research-sweep h-full w-1/3 rounded-full bg-text-strong-950/50" />}
            </div>
          )}

          {row.stats.length > 0 && (
            <dl className="mt-2.5 flex flex-wrap gap-1.5">
              {row.stats.map((stat) => (
                <div key={stat.label} className={cn("inline-flex items-baseline gap-1 rounded-lg px-2 py-1", stat.label === "match" ? "bg-success-lighter text-success-dark" : "bg-bg-weak-50 text-text-sub-600")}>
                  <dd className={cn("text-label-sm tabular-nums", stat.label === "match" ? "text-success-dark" : "text-text-strong-950")}>{stat.value.toLocaleString()}</dd>
                  <dt className="text-paragraph-xs">{stat.label}</dt>
                </div>
              ))}
            </dl>
          )}

          {row.error && <p className="mt-1.5 text-paragraph-xs text-error-base [overflow-wrap:anywhere]">{row.error}</p>}

          {(row.audienceId || hasMore) && (
            <div className="mt-2.5 flex flex-col gap-2">
              {row.audienceId && <ProspectsList audienceId={row.audienceId} count={row.contactable} excluded={row.excluded} timeZone={timeZone} />}
              {hasMore && (
                <div>
                  <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="inline-flex items-center gap-1 rounded-md text-label-xs text-text-sub-600 outline-none hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base">
                    <RiArrowDownSLine className={cn("size-4 transition-transform", open && "rotate-180")} aria-hidden="true" />
                    {open ? "Hide details" : "Details"}
                  </button>
                  {open && (
                    <ul className="research-in mt-1.5 space-y-1 border-l-2 border-stroke-soft-200 pl-3 text-paragraph-xs text-text-sub-600">
                      {row.details.map((line) => <li key={line} className="[overflow-wrap:anywhere]">{line}</li>)}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export function ResearchGroup({ messages, jobs, timeZone }: { messages: ResearchMessage[]; jobs: ResearchJob[]; timeZone: string }) {
  const rows = useMemo(() => messages.map((message) => researchRow(message, jobs.find((job) => job.id === message.toolResult?.data?.jobId), timeZone)), [messages, jobs, timeZone]);
  const summary = researchSummary(rows);
  const headline = researchHeadline(summary);
  // The hop plays when research finishes while the owner watches, not on every reload of a finished chat.
  const wasRunning = useRef(summary.running > 0);
  const [justFinished, setJustFinished] = useState(false);
  useEffect(() => {
    if (wasRunning.current && summary.running === 0) setJustFinished(true);
    wasRunning.current = summary.running > 0;
  }, [summary.running]);
  const mood: MascotMood = summary.running > 0 ? "searching" : summary.done === 0 && summary.failed > 0 ? "stuck" : justFinished ? "done" : "idle";
  return (
    <section aria-label="Research" data-testid="research-group" className="w-full max-w-2xl overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0">
      <div className="flex items-center gap-3 px-4 pb-3 pt-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-bg-weak-50">
          <Mascot mood={mood} className="size-10" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-label-md text-text-strong-950">{headline.title}</p>
          <p className="mt-0.5 text-paragraph-xs text-text-sub-600 [overflow-wrap:anywhere]">{headline.detail}</p>
        </div>
        {summary.total > 1 && <span className="shrink-0 text-label-xs tabular-nums text-text-soft-400">{summary.done + summary.failed}/{summary.total}</span>}
      </div>
      {summary.total > 1 && (
        <div className="flex gap-1 px-4 pb-3" aria-hidden="true">
          {rows.map((row) => <Segment key={row.id} row={row} />)}
        </div>
      )}
      <ul className="divide-y divide-stroke-soft-200 border-t border-stroke-soft-200">
        {rows.map((row) => <Row key={row.id} row={row} timeZone={timeZone} />)}
      </ul>
    </section>
  );
}
