"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { RiCloseLine, RiListCheck3 } from "@remixicon/react";
import type { RequestSummary } from "@/lib/assistant/requests.server";
import { useVisiblePolling } from "@/components/whatsapp/usePolling";
import { cn } from "@/utils/cn";
import { createResponseGate } from "@/components/crm/responseGate";
import { Mascot } from "./Mascot";
import { fetchRequestSummary, RequestSummaryView } from "./RequestSummaryView";

/**
 * The request beside the chat: the newest one this chat started (or the one
 * picked when it started several), with its figures, blocker, next step and
 * the searches and plans underneath. Closed by default; the header's "This
 * request" button opens it as a column on wide screens and a sheet on a
 * phone. Shows nothing until the chat has started something. `refreshKey` changes when
 * the chat sees new activity, so the panel follows it without its own fast poll.
 */

type ThreadRequest = { key: string; title: string; open: boolean; startedAt: string };

const POLL_MS = 15_000;

export function useThreadRequest(threadId: string, refreshKey: string) {
  const [requestData, setRequestData] = useState<{ threadId: string; rows: ThreadRequest[] } | null>(null);
  const requests = requestData?.threadId === threadId ? requestData.rows : [];
  const [picked, setPicked] = useState<string | null>(null);
  const [summaryData, setSummaryData] = useState<{ key: string; value: RequestSummary } | null>(null);
  const [errorData, setErrorData] = useState<{ threadId: string; key: string | null; text: string } | null>(null);
  const [listResponses] = useState(createResponseGate);
  const [summaryResponses] = useState(createResponseGate);
  const key = picked && requests.some((request) => request.key === picked) ? picked : requests[0]?.key ?? null;
  const summary = summaryData?.key === key ? summaryData.value : null;
  const error = errorData?.threadId === threadId && (errorData.key === null || errorData.key === key) ? errorData.text : null;

  const load = useCallback(async () => {
    const ticket = listResponses.restart();
    try {
      const response = await fetch(`/api/assistant/threads/${encodeURIComponent(threadId)}/requests`, { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { requests?: ThreadRequest[] };
      if (!response.ok) throw new Error(`Request list could not load (HTTP ${response.status}).`);
      if (!listResponses.isCurrent(ticket)) return;
      setRequestData({ threadId, rows: body.requests ?? [] });
      setErrorData(current => current?.key === null ? null : current);
    } catch {
      if (listResponses.isCurrent(ticket)) setErrorData({ threadId, key: null, text: "The request list could not be refreshed." });
    }
  }, [threadId, listResponses]);

  const loadSummary = useCallback(async () => {
    const ticket = summaryResponses.restart();
    if (!key) { setSummaryData(null); return; }
    try {
      const next = await fetchRequestSummary(key);
      if (!summaryResponses.isCurrent(ticket)) return;
      setSummaryData({ key, value: next });
      setErrorData(current => current?.key === key ? null : current);
    } catch (cause) {
      if (summaryResponses.isCurrent(ticket)) setErrorData({ threadId, key, text: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [key, threadId, summaryResponses]);

  // A new chat starts empty; its activity (refreshKey) brings the requests in.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setPicked(null); }, [threadId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); return () => { listResponses.restart(); }; }, [load, refreshKey, listResponses]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadSummary(); return () => { summaryResponses.restart(); }; }, [loadSummary, refreshKey, summaryResponses]);
  useVisiblePolling(() => { if (summary?.open || error) void loadSummary(); if (error) void load(); }, POLL_MS);

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

const OPEN_KEY = "agentsdr-request-panel-open";

/**
 * Whether the request panel is open: closed unless the person opened it on
 * this browser (remembered; read after mount, so the server and the first
 * client render agree).
 */
export function useRequestPanelOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try { setOpen(window.localStorage.getItem(OPEN_KEY) === "true"); } catch { /* blocked storage: closed */ }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const change = useCallback((next: boolean) => {
    setOpen(next);
    try { window.localStorage.setItem(OPEN_KEY, String(next)); } catch { /* blocked storage: the choice lasts this visit */ }
  }, []);
  return [open, change];
}

/** The mascot looks around while the request's searches run, and rests otherwise. */
function moodOf(summary: RequestSummary | null) {
  return summary?.open && summary.children.searches.some((item) => item.open && item.kind !== "objective") ? "searching" as const : "idle" as const;
}

const iconButton = "flex size-9 items-center justify-center rounded-lg text-text-sub-600 outline-none transition hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base";

function RequestStatusError({ error, stale, onRetry }: { error: string; stale: boolean; onRetry: () => void }) {
  return <div role="alert" className="mb-3 rounded-lg border border-warning-light bg-bg-white-0 px-3 py-2 text-paragraph-xs text-text-sub-600">
    <p className="leading-5">{stale ? "Status may be out of date." : "Request status couldn’t load."}</p>
    <div className="mt-1 flex items-center justify-between gap-2"><details className="min-w-0"><summary className="cursor-pointer">Details</summary><p className="mt-1 leading-5 [overflow-wrap:anywhere]">{error}</p></details><button type="button" onClick={onRetry} className="min-h-9 shrink-0 rounded-md px-2 text-label-xs text-text-strong-950 hover:bg-bg-weak-50">Refresh</button></div>
  </div>;
}

export const REQUEST_PANEL_ID = "request-panel";

function focusToggle() {
  document.querySelector<HTMLElement>(`[aria-controls="${REQUEST_PANEL_ID}"]`)?.focus();
}

/**
 * The header button that opens and closes the request panel: named for
 * screen readers on every width, its state in aria-expanded, a dot while the
 * request is still going. Nothing until the chat has started a request.
 */
export function RequestPanelToggle({ state, open, onToggle }: { state: ReturnType<typeof useThreadRequest>; open: boolean; onToggle: () => void }) {
  if (!state.requests.length && !state.error) return null;
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={REQUEST_PANEL_ID} aria-label="This request" title={open ? "Hide this request" : "Show this request"} data-testid="request-panel-toggle"
      className={cn("relative inline-flex size-11 items-center justify-center gap-1.5 rounded-lg text-label-xs text-text-sub-600 outline-none hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-primary-base sm:size-9 2xl:w-auto 2xl:px-2.5", open && "bg-bg-weak-50 text-text-strong-950")}>
      <RiListCheck3 className="size-4" aria-hidden="true" /><span className="hidden 2xl:inline">This request</span>
      {state.summary?.open && <span className="absolute right-2 top-2 size-2 rounded-full bg-primary-base 2xl:static" aria-hidden="true" />}
    </button>
  );
}

/**
 * The request beside the chat, closed by default and opened from the
 * header's "This request" button: a column on wide screens, a sheet over the
 * chat on a phone (the conversation keeps its one scroll; the panel scrolls
 * on its own surface). Escape or the close button closes it and returns
 * focus to the toggle.
 */
export function RequestPanel({ state, labels, open, onClose }: { state: ReturnType<typeof useThreadRequest>; labels?: Record<string, string>; open: boolean; onClose: () => void }) {
  const { requests, key, pick, summary, error, reload } = state;
  const close = useRef<HTMLButtonElement>(null);
  const visible = open && (requests.length > 0 || Boolean(error));
  useEffect(() => {
    if (!visible) return;
    close.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
      focusToggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, onClose]);
  if (!visible) return null;
  const dismiss = () => {
    onClose();
    focusToggle();
  };
  return (
    <>
      <div className="fixed inset-0 z-30 bg-static-black/30 lg:hidden" aria-hidden="true" onClick={dismiss} />
      <aside id={REQUEST_PANEL_ID} aria-label="This request" data-testid="request-panel"
        className="fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col overflow-y-auto overscroll-contain border-l border-stroke-soft-200 bg-bg-white-0 shadow-regular-md lg:static lg:z-auto lg:w-[320px] lg:max-w-none lg:shrink-0 lg:shadow-none xl:w-[360px]">
        <div className="border-b border-stroke-soft-200 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-label-sm text-text-strong-950">This request</h2>
            <div className="flex items-center gap-1">
              <Link href="/assistant/requests" className="rounded-md px-1.5 py-1 text-label-xs text-text-sub-600 hover:text-text-strong-950">All requests</Link>
              <button ref={close} type="button" onClick={dismiss} aria-label="Close this request" title="Close" className={iconButton}>
                <RiCloseLine className="size-5" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="mt-2 flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-bg-weak-50"><Mascot mood={moodOf(summary)} className="size-9" /></span>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-paragraph-sm text-text-strong-950">{summary?.title ?? requests.find((request) => request.key === key)?.title}</p>
              {summary && (
                <p className="mt-1 inline-flex items-center gap-1.5 text-paragraph-xs text-text-sub-600">
                  <span className={cn("size-1.5 rounded-full", summary.open ? "bg-success-base" : "bg-text-soft-400")} aria-hidden="true" />{summary.stateLabel}
                </p>
              )}
            </div>
          </div>
          <Picker requests={requests} value={key} onPick={pick} />
        </div>
        <div className="px-4 py-4">
          {error && <RequestStatusError error={error} stale={Boolean(summary)} onRetry={reload} />}
          {summary ? <RequestSummaryView summary={summary} compact onChanged={reload} labels={labels} /> : !error && <p className="text-paragraph-xs text-text-soft-400">Loading…</p>}
        </div>
      </aside>
    </>
  );
}
