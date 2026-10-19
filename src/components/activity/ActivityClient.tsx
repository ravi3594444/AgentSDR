"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { RiChat3Line, RiInboxLine, RiPulseLine, RiRefreshLine } from "@remixicon/react";
import type { ReplyItem, WorkItem } from "@/lib/activity/activity.server";
import { repliesSeenUntil, type ReplyState, type WorkState } from "@/lib/activity/status";
import { CONVERSATION_CHANNEL_META } from "@/components/analytics/theme";
import { announceRecordChanged } from "@/components/crm/recordEvents";
import { Badge, ErrorState, LoadingRows, secondaryButtonClass } from "@/components/crm/CrmLayout";
import { timeAgo } from "@/components/crm/crm-utils";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { PageTabs } from "@/components/page/PageTabs";
import { useVisiblePolling } from "@/components/whatsapp/usePolling";
import { cn } from "@/utils/cn";

/**
 * Activity: every background search and outreach plan, and every reply they
 * brought, whichever chat started them. Refreshes every 10 s while visible.
 * The only things a person can do here are cancel a search and pause,
 * resume or stop a running plan; a proposed plan is started from its chat.
 */

type View = "work" | "replies";
type Channel = "all" | "email" | "whatsapp" | "linkedin" | "instagram";

const POLL_MS = 10_000;
const CHANNELS: Channel[] = ["all", "email", "whatsapp", "linkedin", "instagram"];

const WORK_TONE: Record<WorkState, "neutral" | "success" | "info" | "danger" | "warning"> = {
  queued: "neutral",
  executing: "info",
  waiting_slot: "warning",
  waiting_quota: "warning",
  outside_hours: "neutral",
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

const REPLY_TONE: Record<ReplyState, "neutral" | "success" | "info" | "danger" | "warning"> = {
  answered: "success",
  needs_you: "danger",
  action_required: "warning",
  processing: "info",
  waiting: "warning",
};

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (HTTP ${response.status})`);
  return body;
}

function chatHref(threadId: string): string {
  return `/assistant?thread=${encodeURIComponent(threadId)}`;
}

export function ActivityClient({ initialView }: { initialView: View }) {
  const [view, setView] = useState<View>(initialView);
  const [channel, setChannel] = useState<Channel>("all");
  const [work, setWork] = useState<WorkItem[] | null>(null);
  const [replies, setReplies] = useState<ReplyItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Replies that were new when this visit saw them stay marked until the page is left.
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(new Set());
  const loading = useRef(false);

  const loadWork = useCallback(async () => {
    const body = await readJson<{ work: WorkItem[] }>(await fetch("/api/activity?view=work", { cache: "no-store" }));
    setWork(body.work);
  }, []);

  const loadReplies = useCallback(async () => {
    const query = channel === "all" ? "" : `&channel=${channel}`;
    const body = await readJson<{ replies: ReplyItem[] }>(await fetch(`/api/activity?view=replies${query}`, { cache: "no-store" }));
    setReplies(body.replies);
    const fresh = body.replies.filter((reply) => reply.isNew).map((reply) => reply.messageId);
    if (fresh.length) setNewIds((current) => new Set([...current, ...fresh]));
    // Seen up to the newest reply shown, and only from the unfiltered list: the sidebar's
    // count drops; the rows stay marked for this visit. A filter hides other channels' replies.
    const until = repliesSeenUntil(channel, body.replies);
    if (until) {
      await fetch("/api/activity/seen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ until }) }).catch(() => null);
      announceRecordChanged("activity");
    }
  }, [channel]);

  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      // Both counts feed the tabs, so both lists load; only the visible one is read closely.
      await Promise.all([loadWork(), view === "replies" ? loadReplies() : Promise.resolve()]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      loading.current = false;
    }
  }, [loadWork, loadReplies, view]);

  // Fetching on mount and on a view or channel change; every state update lands after the request.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  useVisiblePolling(() => void load(), POLL_MS);

  const changeView = (next: View) => {
    setView(next);
    const url = new URL(window.location.href);
    if (next === "replies") url.searchParams.set("view", "replies");
    else url.searchParams.delete("view");
    window.history.replaceState(null, "", url);
  };

  const act = async (id: string, request: () => Promise<Response>) => {
    setBusyId(id);
    setActionError(null);
    try {
      await readJson(await request());
      await loadWork();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };
  const cancelJob = (item: WorkItem) => {
    if (!window.confirm("Cancel this search? Leads it already saved are kept; nothing further is searched.")) return;
    void act(item.id, () => fetch(`/api/activity/jobs/${item.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) }));
  };
  const runAction = (item: WorkItem, action: "pause" | "resume" | "stop") => {
    if (action === "stop" && !window.confirm("Stop this outreach plan? No further messages are sent from it.")) return;
    void act(item.id, () => fetch(`/api/assistant/runs/${item.runId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }));
  };

  const openWork = work?.filter((item) => item.open) ?? [];
  const finishedWork = work?.filter((item) => !item.open) ?? [];
  const unseen = replies ? replies.filter((reply) => newIds.has(reply.messageId)).length : undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Activity"
        description="Searches, outreach plans and the replies they brought, from every chat. Looking here never starts or sends anything."
        actions={<button type="button" className={secondaryButtonClass} onClick={() => void load()}><RiRefreshLine className="size-4" aria-hidden="true" />Refresh</button>}
      />
      <PageTabs<View>
        label="Activity"
        value={view}
        onChange={changeView}
        tabs={[
          { value: "work", label: "Work", icon: RiPulseLine, count: work ? openWork.length : undefined },
          { value: "replies", label: "Replies", icon: RiInboxLine, count: unseen || undefined },
        ]}
      />
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {actionError && <ErrorState message={actionError} />}

      {view === "work" && (
        work === null ? <LoadingRows /> : work.length === 0 ? (
          <EmptyState icon={RiPulseLine} title="No background work this week" description="Searches and outreach plans the assistant starts, from any chat, show here while they run and for a week after." />
        ) : (
          <div className="space-y-6">
            <WorkSection title="In progress" items={openWork} empty="Nothing is running or waiting." busyId={busyId} onCancel={cancelJob} onRun={runAction} />
            <WorkSection title="Finished in the last 7 days" items={finishedWork} empty="Nothing has finished this week." busyId={busyId} onCancel={cancelJob} onRun={runAction} />
          </div>
        )
      )}

      {view === "replies" && (
        <div className="space-y-4">
          <div role="group" aria-label="Channel" className="flex flex-wrap gap-2">
            {CHANNELS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={channel === value}
                onClick={() => { setChannel(value); setReplies(null); }}
                className={cn("h-8 rounded-lg px-3 text-label-sm ring-1 ring-inset transition", channel === value ? "bg-bg-strong-950 text-text-white-0 ring-bg-strong-950" : "bg-bg-white-0 text-text-sub-600 ring-stroke-soft-200 hover:text-text-strong-950")}
              >
                {value === "all" ? "All channels" : CONVERSATION_CHANNEL_META[value].label}
              </button>
            ))}
          </div>
          {replies === null ? <LoadingRows /> : replies.length === 0 ? (
            <EmptyState icon={RiInboxLine} title="No replies yet" description="Messages leads send back, on any channel, show here with whether they have been answered." />
          ) : (
            <ul className="divide-y divide-stroke-soft-200 overflow-hidden rounded-xl bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200">
              {replies.map((reply) => <ReplyRow key={reply.messageId} reply={reply} isNew={newIds.has(reply.messageId)} />)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function WorkSection({ title, items, empty, busyId, onCancel, onRun }: {
  title: string;
  items: WorkItem[];
  empty: string;
  busyId: string | null;
  onCancel: (item: WorkItem) => void;
  onRun: (item: WorkItem, action: "pause" | "resume" | "stop") => void;
}) {
  return (
    <section>
      <h2 className="mb-2 text-label-sm text-text-sub-600">{title}</h2>
      {items.length === 0 ? <p className="text-paragraph-sm text-text-soft-400">{empty}</p> : (
        <ul className="divide-y divide-stroke-soft-200 overflow-hidden rounded-xl bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200">
          {items.map((item) => <WorkRow key={`${item.type}:${item.id}`} item={item} busy={busyId === item.id} onCancel={onCancel} onRun={onRun} />)}
        </ul>
      )}
    </section>
  );
}

function WorkRow({ item, busy, onCancel, onRun }: { item: WorkItem; busy: boolean; onCancel: (item: WorkItem) => void; onRun: (item: WorkItem, action: "pause" | "resume" | "stop") => void }) {
  const counts = [
    item.found !== null ? `${item.found} found` : null,
    item.eligible !== null ? `${item.eligible} new` : null,
    item.counts ? `${item.counts.leads} ${item.counts.leads === 1 ? "lead" : "leads"} · ${item.counts.contacted} contacted · ${item.counts.replied} replied` : null,
  ].filter(Boolean).join(" · ");
  const running = item.runStatus === "running";
  const small = "h-8 px-2.5";
  return (
    <li className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 break-words text-label-sm text-text-strong-950">{item.title}</p>
          <Badge tone={WORK_TONE[item.state]}>{item.stateLabel}</Badge>
        </div>
        {item.reason && <p className="text-paragraph-sm text-text-sub-600">{item.reason}{item.nextAt && <>; the next send is allowed <time dateTime={item.nextAt}>{new Date(item.nextAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></>}</p>}
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

function ReplyRow({ reply, isNew }: { reply: ReplyItem; isNew: boolean }) {
  const meta = CONVERSATION_CHANNEL_META[reply.channel as keyof typeof CONVERSATION_CHANNEL_META];
  const Icon = meta?.icon;
  return (
    <li className={cn("flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between", isNew && "bg-bg-weak-50")}>
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          {isNew && <span className="size-2 shrink-0 rounded-full bg-information-base" aria-label="New" />}
          <Link href={`/crm/records/${reply.recordId}`} className="min-w-0 break-words text-label-sm text-text-strong-950 hover:underline">{reply.personName}</Link>
          <Badge tone={REPLY_TONE[reply.state]}>{reply.stateLabel}</Badge>
        </div>
        <p className="line-clamp-2 break-words text-paragraph-sm text-text-sub-600">{reply.preview || "(no text)"}</p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-paragraph-xs text-text-soft-400">
          <span className="inline-flex items-center gap-1">{Icon && <Icon className="size-3.5" aria-hidden="true" />}{meta?.label ?? reply.channel}</span>
          <span title={new Date(reply.receivedAt).toLocaleString()}>{timeAgo(reply.receivedAt)}</span>
          {reply.runName && <span>From “{reply.runName}”</span>}
          {reply.threadId && (
            <Link href={chatHref(reply.threadId)} className="inline-flex items-center gap-1 text-text-sub-600 underline-offset-2 hover:text-text-strong-950 hover:underline">
              <RiChat3Line className="size-3.5" aria-hidden="true" />Open chat
            </Link>
          )}
        </p>
      </div>
      <Link href={`/crm/records/${reply.recordId}`} className={cn(secondaryButtonClass, "h-8 shrink-0 self-start px-2.5")}>Open conversation</Link>
    </li>
  );
}
