"use client";

import { RiArrowDownSLine, RiCalendarLine, RiCheckLine, RiDashboard3Line, RiRefreshLine } from "@remixicon/react";
import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import * as Popover from "@/components/alignui/popover";
import { ANALYTICS_CHANNELS, dayCount, MAX_ANALYTICS_RANGE_DAYS, type AnalyticsResponse, type AnalyticsView } from "@/lib/analytics/contract";
import { cn } from "@/utils/cn";
import { WorkspaceNavigation } from "@/components/page/WorkspaceNavigation";
import { ErrorState } from "./kit/ErrorState";
import { parseRange, RANGE_PRESETS, resolveRange, serializeRange, type RangeSelection } from "./range";
import { CHANNEL_META, formatDay } from "./theme";
import { views, type ViewProps } from "./views";

/**
 * The Analytics shell: title, view tabs, one date-range control, and the
 * active view. Fetches /api/analytics/{view} client-side (the time zone is the
 * browser's), keeps the previous data on screen (dimmed) while refetching, and
 * mirrors ?view= and ?range= into the URL with history.replaceState.
 */

/** Channel tabs carry their channel's icon and colour; Overview a neutral one. */
const VIEW_TABS: Array<{ view: AnalyticsView; label: string; icon: ComponentType<{ className?: string }>; color?: string }> = [
  { view: "overview", label: "Overview", icon: RiDashboard3Line },
  ...ANALYTICS_CHANNELS.map((channel) => ({ view: channel, label: CHANNEL_META[channel].label, icon: CHANNEL_META[channel].icon, color: CHANNEL_META[channel].color })),
];

/** "tz|YYYY-MM-DD" in the browser, or null on the server (avoids a hydration mismatch). */
function readEnv(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return `${tz}|${today}`;
}
const noopSubscribe = () => () => {};

type Cached = { data: AnalyticsResponse; key: string; updatedAt: number };

export default function AnalyticsClient({ initialView, initialRange }: { initialView: AnalyticsView; initialRange: string }) {
  const [view, setView] = useState<AnalyticsView>(initialView);
  const [selection, setSelection] = useState<RangeSelection>(() => parseRange(initialRange));
  const env = useSyncExternalStore(noopSubscribe, readEnv, () => null);
  const [tz, today] = env ? env.split("|") : [null, null];

  const [cache, setCache] = useState<Partial<Record<AnalyticsView, Cached>>>({});
  const [settled, setSettled] = useState<{ id: string; error: string | null } | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const resolved = today ? resolveRange(selection, today) : null;
  const fetchKey = resolved && tz ? `${resolved.from}|${resolved.to}|${tz}` : null;

  const requestId = fetchKey ? `${view}|${fetchKey}|${reloadTick}` : null;
  const loading = requestId !== null && settled?.id !== requestId;
  const error = settled?.id === requestId ? settled.error : null;

  useEffect(() => {
    if (!fetchKey || !requestId) return;
    const [from, to, zone] = fetchKey.split("|");
    // A superseded request is ignored rather than aborted: aborting surfaced as
    // an uncaught AbortError in dev, and it never stopped the query server-side.
    let current = true;
    fetch(`/api/analytics/${view}?${new URLSearchParams({ from, to, tz: zone })}`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as (AnalyticsResponse & { error?: string }) | { error?: string } | null;
        if (!current) return;
        if (!response.ok || !body || "error" in body) throw new Error((body && "error" in body && body.error) || `Request failed (${response.status})`);
        setCache((prev) => ({ ...prev, [view]: { data: body as AnalyticsResponse, key: fetchKey, updatedAt: Date.now() } }));
        setNow(Date.now());
        setSettled({ id: requestId, error: null });
      })
      .catch((err: unknown) => {
        if (!current) return;
        setSettled({ id: requestId, error: err instanceof Error ? err.message : "Could not load analytics" });
      });
    return () => {
      current = false;
    };
  }, [view, fetchKey, requestId]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const syncUrl = useCallback((nextView: AnalyticsView, nextSelection: RangeSelection) => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", nextView);
    url.searchParams.set("range", serializeRange(nextSelection));
    window.history.replaceState(null, "", url);
  }, []);

  const changeView = (next: AnalyticsView) => {
    setView(next);
    syncUrl(next, selection);
  };
  const changeRange = (next: RangeSelection) => {
    setSelection(next);
    syncUrl(view, next);
  };

  const entry = cache[view];
  const showData = entry && !(error && !entry);
  const View = views[view] as unknown as ComponentType<ViewProps<AnalyticsView>>;

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-title-h5 text-text-strong-950">Analytics</h1>
          <p className="mt-1 max-w-2xl text-paragraph-sm text-text-sub-600">How conversations turn into meetings and customers, and which channels bring them in.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start">
          <DateRangeControl selection={selection} resolved={resolved} today={today} onChange={changeRange} />
          <button type="button" onClick={() => setReloadTick((n) => n + 1)} disabled={loading} aria-label="Refresh" title="Refresh" className="flex size-9 items-center justify-center rounded-lg bg-bg-white-0 text-text-sub-600 shadow-regular-xs outline-none ring-1 ring-inset ring-stroke-soft-200 hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-primary-base disabled:opacity-50">
            <RiRefreshLine className={cn("size-4", loading && "animate-spin")} aria-hidden="true" />
          </button>
        </div>
      </header>
      <WorkspaceNavigation area="reporting" active="/analytics" />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-stroke-soft-200">
        <div role="tablist" aria-label="Analytics views" className="-mb-px flex gap-5 overflow-x-auto">
          {VIEW_TABS.map(({ view: tabView, label, icon: Icon, color }) => {
            const active = tabView === view;
            return (
              <button key={tabView} role="tab" type="button" aria-selected={active} onClick={() => changeView(tabView)} className={cn("relative flex h-10 shrink-0 items-center gap-2 text-label-sm outline-none transition-colors focus-visible:text-text-strong-950", active ? "text-text-strong-950" : "text-text-sub-600 hover:text-text-strong-950")}>
                <span aria-hidden="true" className={cn("flex transition-opacity", color ? !active && "opacity-70" : active ? "text-text-strong-950" : "text-text-soft-400")} style={color ? { color } : undefined}>
                  <Icon className="size-[18px] shrink-0" />
                </span>
                {label}
                <span className={cn("absolute inset-x-0 bottom-0 h-0.5 rounded-full", active ? "bg-primary-base" : "bg-transparent")} />
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 pb-2 text-paragraph-xs text-text-soft-400">
          {entry && <span>{updatedLabel(entry.updatedAt, now)}</span>}
        </div>
      </div>

      <div role="tabpanel" className="mt-6">
        {error && entry && <p role="alert" className="mb-4 rounded-lg bg-error-lighter px-3 py-2 text-paragraph-sm text-error-dark">Couldn&apos;t refresh: {error}. Showing the last loaded data.</p>}
        {showData ? (
          createElement(View, { data: entry.data, loading, onSelectView: changeView })
        ) : error ? (
          <ErrorState message={error} onRetry={() => setReloadTick((n) => n + 1)} />
        ) : (
          <LoadingBlock />
        )}
      </div>
    </div>
  );
}

function updatedLabel(updatedAt: number, now: number): string {
  const minutes = Math.floor((now - updatedAt) / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  return `Updated ${Math.floor(minutes / 60)}h ago`;
}

/** First load of a view only; refetches keep the previous render instead. */
function LoadingBlock() {
  return (
    <div aria-busy="true" aria-label="Loading analytics" className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <div className="h-32 animate-pulse rounded-2xl bg-bg-weak-50 lg:col-span-12" />
      <div className="h-80 animate-pulse rounded-2xl bg-bg-weak-50 lg:col-span-8" />
      <div className="h-80 animate-pulse rounded-2xl bg-bg-weak-50 lg:col-span-4" />
    </div>
  );
}

function DateRangeControl({ selection, resolved, today, onChange }: { selection: RangeSelection; resolved: { from: string; to: string } | null; today: string | null; onChange: (selection: RangeSelection) => void }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const wasOpen = useRef(false);
  const label = selection.kind === "preset" ? RANGE_PRESETS.find((p) => p.key === selection.key)?.label : "Custom range";
  const span = resolved ? `${formatDay(resolved.from)} – ${formatDay(resolved.to)}` : "";
  const customError = from && to ? (from > to ? "Start must be before the end." : dayCount(from, to) > MAX_ANALYTICS_RANGE_DAYS ? `Pick at most ${MAX_ANALYTICS_RANGE_DAYS} days.` : null) : null;

  useEffect(() => {
    if (open && !wasOpen.current && resolved) {
      setFrom(resolved.from);
      setTo(resolved.to);
    }
    wasOpen.current = open;
  }, [open, resolved]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className="flex h-9 shrink-0 items-center gap-2 self-start rounded-lg bg-bg-white-0 px-3 text-label-sm text-text-strong-950 shadow-regular-xs outline-none ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-primary-base">
          <RiCalendarLine className="size-4 text-text-sub-600" aria-hidden="true" />
          {label}
          {span && <span className="hidden text-text-sub-600 sm:inline">· {span}</span>}
          <RiArrowDownSLine className="size-4 text-text-soft-400" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Content align="end" sideOffset={8} showArrow={false} className="w-64 p-1.5">
        <ul>
          {RANGE_PRESETS.map((preset) => {
            const active = selection.kind === "preset" && selection.key === preset.key;
            return (
              <li key={preset.key}>
                <button type="button" onClick={() => { onChange({ kind: "preset", key: preset.key }); setOpen(false); }} className={cn("flex h-9 w-full items-center justify-between rounded-lg px-3 text-label-sm outline-none transition hover:bg-bg-weak-50 focus-visible:bg-bg-weak-50", active ? "text-text-strong-950" : "text-text-sub-600")}>
                  {preset.label}
                  {active && <RiCheckLine className="size-4 text-text-strong-950" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-1.5 border-t border-stroke-soft-200 p-2 pt-3">
          <p className={cn("mb-2 flex items-center justify-between text-label-xs", selection.kind === "custom" ? "text-text-strong-950" : "text-text-soft-400")}>
            Custom range {selection.kind === "custom" && <RiCheckLine className="size-4" aria-hidden="true" />}
          </p>
          <div className="flex items-center gap-2">
            <input type="date" aria-label="Start date" value={from} max={today ?? undefined} onChange={(e) => setFrom(e.target.value)} className="h-8 min-w-0 flex-1 rounded-lg bg-bg-white-0 px-2 text-paragraph-xs text-text-strong-950 outline-none ring-1 ring-inset ring-stroke-soft-200 focus:ring-primary-base" />
            <span className="text-text-soft-400" aria-hidden="true">–</span>
            <input type="date" aria-label="End date" value={to} max={today ?? undefined} onChange={(e) => setTo(e.target.value)} className="h-8 min-w-0 flex-1 rounded-lg bg-bg-white-0 px-2 text-paragraph-xs text-text-strong-950 outline-none ring-1 ring-inset ring-stroke-soft-200 focus:ring-primary-base" />
          </div>
          {customError && <p role="alert" className="mt-2 text-paragraph-xs text-error-base">{customError}</p>}
          <button type="button" disabled={!from || !to || Boolean(customError)} onClick={() => { onChange({ kind: "custom", from, to }); setOpen(false); }} className="mt-3 h-8 w-full rounded-lg bg-bg-strong-950 text-label-xs text-text-white-0 outline-none transition hover:bg-bg-surface-800 focus-visible:ring-2 focus-visible:ring-primary-base disabled:cursor-not-allowed disabled:bg-bg-weak-50 disabled:text-text-disabled-300">
            Apply range
          </button>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
