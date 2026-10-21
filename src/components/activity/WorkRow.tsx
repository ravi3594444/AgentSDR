"use client";

import Link from "next/link";
import { RiChat3Line } from "@remixicon/react";
import type { WorkItem } from "@/lib/activity/activity.server";
import { nextAtPhrase, type WorkState } from "@/lib/activity/status";
import { formatChatDateTime } from "@/lib/assistant/chatTime";
import { displayTime } from "@/lib/assistant/displayTime";
import { Badge, secondaryButtonClass } from "@/components/crm/CrmLayout";
import { timeAgo } from "@/components/crm/crm-utils";
import { ProspectsList } from "@/components/assistant/ProspectsList";
import { searchListOf, workCounts } from "@/lib/assistant/leadLists";
import { cn } from "@/utils/cn";

/**
 * One search or outreach plan, as Activity showed it and a request's summary
 * lists it underneath: its state, why, its counts, its chat, and the run
 * controls that apply (cancel a search; pause, resume or stop a plan; a
 * proposed plan is started from its chat). A finished search opens its own
 * lead list underneath (View leads), the same list as under its card in the
 * chat. Its times are written in `timeZone`, the organization's (chatTime.ts).
 */

export const WORK_TONE: Record<WorkState, "neutral" | "success" | "info" | "danger" | "warning"> = {
  queued: "neutral",
  executing: "info",
  waiting_slot: "warning",
  waiting_quota: "warning",
  waiting_send: "warning",
  daily_lead_limit: "neutral",
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

/**
 * `compact` is the request column beside the chat: always stacked (the column
 * is narrow even on a wide screen), and without the link back to the chat
 * the column already sits in.
 */
export function WorkRow({ item, busy, timeZone, onCancel, onRun, compact = false }: { item: WorkItem; busy: boolean; timeZone: string; onCancel: (item: WorkItem) => void; onRun: (item: WorkItem, action: "pause" | "resume" | "stop") => void; compact?: boolean }) {
  const counts = workCounts(item);
  const list = searchListOf(item);
  const nextAt = item.nextAt ? displayTime(new Date(item.nextAt), new Date(), timeZone) : null;
  const running = item.runStatus === "running";
  const small = "h-8 px-2.5";
  return (
    <li className={cn("flex flex-col gap-3 px-4 py-3", !compact && "sm:flex-row sm:items-start sm:justify-between")}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className={cn("min-w-0 break-words text-label-sm text-text-strong-950", compact && "line-clamp-2")}>{item.title}</p>
          <Badge tone={WORK_TONE[item.state]}>{item.stateLabel}</Badge>
        </div>
        {item.reason && <p className={cn("text-text-sub-600", compact ? "text-paragraph-xs" : "text-paragraph-sm")}>{item.reason}{item.nextAt && <>; {nextAtPhrase(item.state)} <time dateTime={item.nextAt}>{nextAt}</time></>}</p>}
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-paragraph-xs text-text-soft-400">
          {item.source && <span>{item.source}</span>}
          {counts && <span>{counts}</span>}
          <span title={formatChatDateTime(item.startedAt, timeZone)}>Started {timeAgo(item.startedAt)}</span>
          {item.threadId && !compact && (
            <Link href={chatHref(item.threadId)} className="inline-flex items-center gap-1 text-text-sub-600 underline-offset-2 hover:text-text-strong-950 hover:underline">
              <RiChat3Line className="size-3.5" aria-hidden="true" />{item.threadTitle ?? "Open chat"}
            </Link>
          )}
        </p>
        {list && <div className="pt-1"><ProspectsList audienceId={list.audienceId} count={list.count} timeZone={timeZone} /></div>}
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
