"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  RiArrowDownSLine,
  RiChat3Line,
  RiCheckLine,
  RiCloseCircleLine,
  RiFacebookCircleLine,
  RiGlobalLine,
  RiInstagramLine,
  RiLinkedinBoxLine,
  RiLoader4Line,
  RiMapPin2Line,
  RiRedditLine,
  RiSubtractLine,
  RiTwitterXLine,
  RiUserLine,
} from "@remixicon/react";
import { ProspectsList } from "@/components/assistant/ProspectsList";
import { formatChatTime } from "@/lib/assistant/chatTime";
import { toolTransport } from "@/lib/activity/jobActivity";
import { cn } from "@/utils/cn";
import { Mascot, type MascotMood } from "./Mascot";
import { requestFigures, researchHeadline, researchRow, researchSummary, type ResearchJob, type ResearchMessage, type ResearchRow, type SourceIcon } from "./researchView";
import { browserActivity, isConnectedBrowserTool } from "./browserActivity";

/**
 * One owner request's activity in the chat, as one card that updates in
 * place: where the research is, its figures (Found, Contactable, Matching,
 * and Contacted, Replied, Interested once outreach is relevant), one row per
 * search with what it ran through and its state, the other sources the
 * assistant used itself, and everything technical — tool steps, progress
 * reports, retries, earlier narration — behind Details. Replaces a card per
 * run of searches, a "Done" report per search and a paragraph per retry.
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

type DetailMessage = { id: string; tool: string | null; status: string | null; toolResult: { data?: Record<string, unknown> } | null };

function StateMark({ row }: { row: ResearchRow }) {
  if (row.state === "done") return <RiCheckLine className="size-4 shrink-0 text-success-base" aria-hidden="true" />;
  if (row.state === "failed") return <RiCloseCircleLine className="size-4 shrink-0 text-error-base" aria-hidden="true" />;
  if (row.state === "skipped" || row.state === "cancelled") return <RiSubtractLine className="size-4 shrink-0 text-text-soft-400" aria-hidden="true" />;
  if (row.phase === "needs_you") return <RiUserLine className="size-4 shrink-0 text-warning-base" aria-hidden="true" />;
  return <RiLoader4Line className={cn("size-4 shrink-0 text-text-soft-400", (row.phase === "searching" || row.phase === "reading" || row.state === "starting") && "animate-spin")} aria-hidden="true" />;
}

function Row({ row, timeZone }: { row: ResearchRow; timeZone: string }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const Icon = ICONS[row.icon];
  const expandable = row.details.length > 0 || Boolean(row.audienceId) || Boolean(row.error);
  const percent = row.progress ? Math.round((row.progress.done / row.progress.total) * 100) : null;
  const live = [
    row.step ? `${row.step}${row.progress ? ` · ${row.progress.done} of ${row.progress.total}` : ""}` : null,
    row.reason,
    row.nextCheckAt ? `${row.phase === "retrying" ? "next try" : "next check"} ${formatChatTime(row.nextCheckAt, timeZone)}` : null,
  ].filter(Boolean).join(" · ");
  const stats = row.stats.map((stat) => `${stat.value.toLocaleString("en-US")} ${stat.label}`).join(" · ");
  const head = (
    <>
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-bg-weak-50 text-text-sub-600" aria-hidden="true"><Icon className="size-4" /></span>
      <span className="min-w-0 flex-1">
        {/* The state sits beside the title where there is room, and on its own line on a phone. */}
        <span className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:gap-2">
          <span className="min-w-0 truncate text-label-sm text-text-strong-950 sm:flex-1" title={row.title}>{row.title}</span>
          <span className={cn("inline-flex shrink-0 items-center gap-1 text-label-xs", row.state === "failed" ? "text-error-base" : row.phase === "needs_you" ? "text-warning-base" : row.state === "done" ? "text-text-sub-600" : "text-text-strong-950")}>
            <StateMark row={row} />{row.label}
          </span>
        </span>
        <span className="mt-0.5 block text-paragraph-xs text-text-sub-600 [overflow-wrap:anywhere]">
          {row.source}{stats ? <span className="text-text-soft-400"> · {stats}</span> : null}
        </span>
        {live && <span className="mt-0.5 block text-paragraph-xs text-text-soft-400 [overflow-wrap:anywhere]">{live}</span>}
      </span>
      {expandable && <RiArrowDownSLine className={cn("mt-1 size-4 shrink-0 text-text-soft-400 transition-transform", open && "rotate-180")} aria-hidden="true" />}
    </>
  );
  return (
    <li className="py-2.5" data-testid="request-search-row">
      {expandable
        ? <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((value) => !value)} className="flex w-full items-start gap-2.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-base">{head}</button>
        : <div className="flex items-start gap-2.5">{head}</div>}
      {percent !== null && row.state === "open" && (
        <div className="ml-[38px] mt-1.5 h-1 overflow-hidden rounded-full bg-bg-soft-200" role="progressbar" aria-label={row.step ?? row.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="research-bar h-full rounded-full bg-text-strong-950/70" style={{ width: `${percent}%` }} />
        </div>
      )}
      {open && (
        <div id={panel} className="research-in ml-[38px] mt-2 space-y-2">
          {row.error && <p className="text-paragraph-xs text-error-base [overflow-wrap:anywhere]">{row.error}</p>}
          {row.details.length > 0 && (
            <ul className="space-y-1 border-l-2 border-stroke-soft-200 pl-3 text-paragraph-xs text-text-sub-600">
              {row.details.map((line) => <li key={line} className="[overflow-wrap:anywhere]">{line}</li>)}
            </ul>
          )}
          {row.audienceId && <ProspectsList audienceId={row.audienceId} count={row.contactable} excluded={row.excluded} timeZone={timeZone} />}
        </div>
      )}
    </li>
  );
}

/** The sources the assistant used itself (no job), counted, in the order first used: "Exa ×2 · Tavily". */
function directSources(details: readonly DetailMessage[]): string | null {
  const counts = new Map<string, number>();
  for (const message of details) {
    if (isConnectedBrowserTool(message.tool)) continue;
    if (message.status === "error") continue;
    const via = toolTransport(message.tool, message.toolResult);
    if (via) counts.set(via, (counts.get(via) ?? 0) + 1);
  }
  return counts.size ? [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(" · ") : null;
}

export function RequestActivity({ research, jobs, details, renderDetail, numbers, target, outreach, timeZone, working, workingLabel }: {
  research: ResearchMessage[];
  jobs: ResearchJob[];
  details: DetailMessage[];
  renderDetail: (message: DetailMessage) => React.ReactNode;
  /** The request's own numbers (useRequestSummary): undefined while loading, null when it has none. */
  numbers: Parameters<typeof requestFigures>[0]["numbers"];
  /** The lead target the owner named, else null. */
  target: number | null;
  /** A plan exists or outreach started: show Contacted, Replied, Interested. */
  outreach: boolean;
  timeZone: string;
  /** A step of this turn is running now, and what it is. */
  working: boolean;
  workingLabel: string | null;
}) {
  // The time states are read against ("next check" ahead or due), ticking while anything is open.
  const [now, setNow] = useState(() => new Date());
  const anyOpen = research.some((message) => message.status === "running") || jobs.some((job) => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!anyOpen) return;
    const timer = setInterval(() => setNow(new Date()), 5_000);
    return () => clearInterval(timer);
  }, [anyOpen]);
  const rows = research.map((message) => researchRow(message, jobs.find((job) => job.id === message.toolResult?.data?.jobId), now));
  const summary = researchSummary(rows);
  const headline = researchHeadline(summary);
  const figures = rows.length || outreach ? requestFigures({ numbers, target, rows: summary, outreach }) : [];
  const sources = useMemo(() => directSources(details), [details]);
  const browser = useMemo(() => browserActivity(details), [details]);
  const failedSteps = details.filter((message) => message.status === "error").length;
  // The hop plays when research finishes while the owner watches, not on every reload of a finished chat.
  const wasRunning = useRef(summary.open > 0);
  const [justFinished, setJustFinished] = useState(false);
  useEffect(() => {
    if (wasRunning.current && summary.open === 0) setJustFinished(true);
    wasRunning.current = summary.open > 0;
  }, [summary.open]);
  const mood: MascotMood = summary.open > 0 || working ? "searching" : summary.done === 0 && summary.failed > 0 ? "stuck" : justFinished ? "done" : "idle";
  const title = rows.length ? headline.title : browser ? browser.waiting ? "Waiting for page" : working ? "Using Chrome" : "Browser activity" : working ? "Working" : "Activity";
  const detail = rows.length ? headline.detail : browser ? [browser.label, browser.goal].filter(Boolean).join(" · ") : working ? workingLabel : null;

  return (
    <section aria-label="Request activity" data-testid="request-activity" className="w-full max-w-2xl rounded-2xl border border-stroke-soft-200 bg-bg-white-0">
      {(rows.length > 0 || working || browser) && (
        <div className="flex items-center gap-3 px-4 pt-3.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-bg-weak-50" aria-hidden="true"><Mascot mood={mood} className="size-7" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-label-sm text-text-strong-950">{title}</p>
            {detail && <p className="text-paragraph-xs text-text-sub-600 [overflow-wrap:anywhere]">{detail}{rows.length > 0 && working && workingLabel ? ` · ${workingLabel}` : ""}</p>}
          </div>
        </div>
      )}
      {figures.length > 0 && (
        <dl className="mx-4 mt-3 grid grid-cols-3 gap-x-3 gap-y-2 rounded-xl bg-bg-weak-50 px-3 py-2.5 sm:flex sm:flex-wrap sm:gap-x-6" data-testid="request-figures">
          {figures.map((figure) => (
            <div key={figure.label} className="min-w-0">
              <dt className="truncate text-paragraph-xs text-text-sub-600">{figure.label}</dt>
              <dd className="text-label-md tabular-nums text-text-strong-950">{figure.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {rows.length > 0 && (
        <ul className="mx-4 mt-1 divide-y divide-stroke-soft-200" aria-label="Searches">
          {rows.map((row) => <Row key={row.id} row={row} timeZone={timeZone} />)}
        </ul>
      )}
      {rows.length > 0 && browser && <p className="mx-4 mt-1 text-paragraph-xs text-text-sub-600">Browser activity: {browser.label}</p>}
      {sources && <p className="mx-4 mt-1 text-paragraph-xs text-text-sub-600">Sources used: {sources}</p>}
      {details.length > 0 && (
        <details className={cn("group mt-2 border-t border-stroke-soft-200", !(rows.length > 0 || working || browser || figures.length > 0) && "mt-0 border-t-0")}>
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-b-2xl px-4 text-label-xs text-text-sub-600 outline-none hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-base [&::-webkit-details-marker]:hidden">
            <RiArrowDownSLine className="size-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
            <span>Details</span>
            <span className="text-text-soft-400">· {details.length} {details.length === 1 ? "step" : "steps"}</span>
            {failedSteps > 0 && <span className="text-error-base">· {failedSteps} failed</span>}
          </summary>
          <div className="space-y-3 border-t border-stroke-soft-200 px-4 py-3">{details.map((message) => <div key={message.id}>{renderDetail(message)}</div>)}</div>
        </details>
      )}
    </section>
  );
}
