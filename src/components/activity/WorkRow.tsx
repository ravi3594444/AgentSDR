"use client";

import Link from "next/link";
import { RiChat3Line } from "@remixicon/react";
import type { WorkItem } from "@/lib/activity/activity.server";
import type { WorkState } from "@/lib/activity/status";
import { displayTime } from "@/lib/assistant/displayTime";
import { Badge, secondaryButtonClass } from "@/components/crm/CrmLayout";
import { timeAgo } from "@/components/crm/crm-utils";
import { cn } from "@/utils/cn";

/**
 * One search or outreach plan, as Activity showed it and a request's summary
 * lists it underneath: its state, why, its counts, its chat, and the run
 * controls that apply (cancel a search; pause, resume or stop a plan; a
 * proposed plan is started from its chat).
 */

export const WORK_TONE: Record<WorkState, "neutral" | "success" | "info" | "danger" | "warning"> = {
  queued: "neutral",
  executing: "info",
  waiting_slot: "warning",
  waiting_quota: "warning",
  outside_hours: "neutral",
  waiting_send: "warning",
  scheduled: "neutral",
  retrying: "warning",
  needs_approval: "info",
  paused: "neutral",
  completed: "success",
  partial: "warning",
  not_searched: "warning",
  failed: "danger",
  cancelled: "neutral",
  stale: "warning",
};

export function chatHref(threadId: string): string {
  return `/assistant?thread=${encodeURIComponent(threadId)}`;
}

export function WorkRow({ item, busy, timeZone, onCancel, onRun }: { item: WorkItem; busy: boolean; timeZone: string | null; onCancel: (item: WorkItem) => void; onRun: (item: WorkItem, action: "pause" | "resume" | "stop") => void }) {
  const counts = [
    item.found !== null ? `${item.found} found` : null,
    item.eligible !== null ? `${item.eligible} new` : null,
    item.counts ? `${item.counts.leads} ${item.counts.leads === 1 ? "lead" : "leads"} · ${item.counts.contacted} contacted · ${item.counts.replied} replied${item.counts.failed ? ` · ${item.counts.failed} failed` : ""}` : null,
  ].filter(Boolean).join(" · ");
  const nextAt = item.nextAt
    ? timeZone ? displayTime(new Date(item.nextAt), new Date(), timeZone) : new Date(item.nextAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  const running = item.runStatus === "running";
  const small = "h-8 px-2.5";
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 break-words text-label-sm text-text-strong-950">{item.title}</p>
          <Badge tone={WORK_TONE[item.state]}>{item.stateLabel}</Badge>
        </div>
        {item.reason && <p className="text-paragraph-sm text-text-sub-600">{item.reason}{item.nextAt && <>; the next send is allowed <time dateTime={item.nextAt}>{nextAt}</time></>}</p>}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-paragraph-xs text-text-soft-400">
          {item.source && <span>{item.source}</span>}
          {counts && <span>{counts}</span>}
          <span title={new Date(item.startedAt).toLocaleString()}>Started {timeAgo(item.startedAt)}</span>
          {item.threadId && (
            <Link href={chatHref(item.threadId)} className="inline-flex items-center gap-1 text-text-sub-600 underline-offset-2 hover:text-text-strong-950 hover:underline">
              <RiChat3Line className="size-3.5" aria-hidden="true" />{item.threadTitle ?? "Open chat"}
            </Link>
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {item.canCancel && <button type="button" disabled={busy} className={cn(secondaryButtonClass, small)} onClick={() => onCancel(item)}>Cancel</button>}
        {item.runId && running && <button type="button" disabled={busy} className={cn(secondaryButtonClass, small)} onClick={() => onRun(item, "pause")}>Pause</button>}
        {item.runId && item.runStatus === "paused" && <button type="button" disabled={busy} className={cn(secondaryButtonClass, small)} onClick={() => onRun(item, "resume")}>Resume</button>}
        {item.runId && (running || item.runStatus === "paused" || item.runStatus === "starting") && <button type="button" disabled={busy} className={cn(secondaryButtonClass, small)} onClick={() => onRun(item, "stop")}>Stop</button>}
        {item.runId && item.state === "needs_approval" && item.threadId && <Link href={chatHref(item.threadId)} className={cn(secondaryButtonClass, small)}>Review in chat</Link>}
      </div>
    </li>
  );
}
