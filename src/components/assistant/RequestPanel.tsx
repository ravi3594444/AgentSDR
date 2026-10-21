"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RiArrowDownSLine, RiListCheck3 } from "@remixicon/react";
import type { RequestSummary } from "@/lib/assistant/requests.server";
import { useVisiblePolling } from "@/components/whatsapp/usePolling";
import { cn } from "@/utils/cn";
import { fetchRequestSummary, RequestSummaryView } from "./RequestSummaryView";

/**
 * The request beside the chat: the newest one this chat started (or the one
 * picked when it started several), with its figures, blocker, next step and
 * the searches and plans underneath. A column on wide screens; on a phone a
 * one-line bar above the conversation that opens into the same view. Shows
 * nothing until the chat has started something. `refreshKey` changes when
 * the chat sees new activity, so the panel follows it without its own fast poll.
 */

type ThreadRequest = { key: string; title: string; open: boolean; startedAt: string };

const POLL_MS = 15_000;

export function useThreadRequest(threadId: string, refreshKey: string) {
  const [requests, setRequests] = useState<ThreadRequest[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [summary, setSummary] = useState<RequestSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = picked && requests.some((request) => request.key === picked) ? picked : requests[0]?.key ?? null;

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/assistant/threads/${encodeURIComponent(threadId)}/requests`, { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { requests?: ThreadRequest[] };
      setRequests(response.ok ? body.requests ?? [] : []);
    } catch {
      // The next poll retries; the chat works without the panel.
    }
  }, [threadId]);

  const loadSummary = useCallback(async () => {
    if (!key) { setSummary(null); return; }
    try {
      const next = await fetchRequestSummary(key);
      setSummary(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [key]);

  // A new chat starts empty; its activity (refreshKey) brings the requests in.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setPicked(null); setSummary(null); }, [threadId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load, refreshKey]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadSummary(); }, [loadSummary, refreshKey]);
  useVisiblePolling(() => { if (summary?.open) void loadSummary(); }, POLL_MS);

  return { requests, key, pick: setPicked, summary, error, reload: () => { void load(); void loadSummary(); } };
}

function Picker({ requests, value, onPick }: { requests: ThreadRequest[]; value: string | null; onPick: (key: string) => void }) {
  if (requests.length < 2) return null;
  return (
    <label className="mt-2 block">
      <span className="sr-only">Request</span>
      <select value={value ?? ""} onChange={(event) => onPick(event.target.value)} className="h-8 w-full rounded-lg bg-bg-white-0 px-2 text-paragraph-xs text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200">
        {requests.map((request) => <option key={request.key} value={request.key}>{request.title}{request.open ? "" : " (finished)"}</option>)}
      </select>
    </label>
  );
}

export function RequestPanel({ state }: { state: ReturnType<typeof useThreadRequest> }) {
  const { requests, key, pick, summary, error, reload } = state;
  if (!requests.length) return null;
  return (
    <aside aria-label="This request" data-testid="request-panel" className="hidden w-[340px] shrink-0 flex-col overflow-y-auto border-l border-stroke-soft-200 bg-bg-white-0 lg:flex xl:w-[380px]">
      <div className="border-b border-stroke-soft-200 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-label-sm text-text-strong-950">This request</h2>
          <Link href="/assistant/requests" className="text-label-xs text-text-sub-600 hover:text-text-strong-950">All requests</Link>
        </div>
        <p className="mt-1 line-clamp-2 text-paragraph-xs text-text-sub-600">{summary?.title ?? requests.find((request) => request.key === key)?.title}</p>
        {summary && <p className="mt-1 text-paragraph-xs text-text-soft-400">{summary.stateLabel}</p>}
        <Picker requests={requests} value={key} onPick={pick} />
      </div>
      <div className="px-4 py-4">
        {error && !summary && <p role="alert" className="text-paragraph-xs text-error-base">{error}</p>}
        {summary ? <RequestSummaryView summary={summary} compact onChanged={reload} /> : !error && <p className="text-paragraph-xs text-text-soft-400">Loading…</p>}
      </div>
    </aside>
  );
}

/** The phone version: one line above the conversation, opening into the summary. */
export function RequestBar({ state }: { state: ReturnType<typeof useThreadRequest> }) {
  const { requests, key, pick, summary, reload } = state;
  const [open, setOpen] = useState(false);
  if (!requests.length || !summary) return null;
  const n = summary.numbers;
  return (
    <div className="shrink-0 border-b border-stroke-soft-200 bg-bg-white-0 lg:hidden" data-testid="request-bar">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left">
        <RiListCheck3 className="size-4 shrink-0 text-text-soft-400" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-label-xs text-text-strong-950">{summary.nextAction.label}</span>
          <span className="block truncate text-paragraph-xs text-text-sub-600">{n.matching !== null ? `${n.matching} matching · ` : ""}{n.contacted} contacted · {n.replied} replied</span>
        </span>
        <RiArrowDownSLine className={cn("size-4 shrink-0 text-text-soft-400 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && (
        <div className="max-h-[60vh] overflow-y-auto border-t border-stroke-soft-200 px-4 py-3">
          <p className="mb-3 line-clamp-2 text-paragraph-xs text-text-sub-600">{summary.title}</p>
          <Picker requests={requests} value={key} onPick={pick} />
          <div className="mt-3"><RequestSummaryView summary={summary} compact onChanged={reload} /></div>
        </div>
      )}
    </div>
  );
}
