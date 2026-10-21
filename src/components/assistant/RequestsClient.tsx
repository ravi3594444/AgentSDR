"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RiArrowDownSLine, RiChat3Line, RiListCheck3, RiRefreshLine } from "@remixicon/react";
import type { RequestRow, RequestSummary } from "@/lib/assistant/requests.server";
import { CONVERSATION_CHANNEL_META } from "@/components/analytics/theme";
import { Badge, ErrorState, LoadingRows, secondaryButtonClass } from "@/components/crm/CrmLayout";
import { timeAgo } from "@/components/crm/crm-utils";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { WorkspaceNavigation } from "@/components/page/WorkspaceNavigation";
import { chatHref, WORK_TONE } from "@/components/activity/WorkRow";
import { useVisiblePolling } from "@/components/whatsapp/usePolling";
import { cn } from "@/utils/cn";
import { fetchRequestSummary, RequestSummaryView } from "./RequestSummaryView";
import type { WorkState } from "@/lib/activity/status";

/**
 * Requests: every piece of outreach work, by what started it — a chat
 * request with its searches and plans underneath, an older plan or search on
 * its own — open first, then the last 30 days. Opening one shows its
 * summary (figures, blocker, next step). Campaigns made by hand that no run
 * owns are listed apart. Refreshes every 15 s while visible; reading never
 * starts or sends anything.
 */

type Channel = "" | "email" | "whatsapp" | "linkedin" | "instagram";
type StateFilter = "" | "open" | "done";
const CHANNELS: Channel[] = ["", "email", "whatsapp", "linkedin", "instagram"];
const POLL_MS = 15_000;

function tone(row: RequestRow): "neutral" | "success" | "info" | "danger" | "warning" {
  return (WORK_TONE as Record<string, "neutral" | "success" | "info" | "danger" | "warning">)[row.state as WorkState] ?? (row.open ? "info" : "neutral");
}

function Chips<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((option) => (
        <button key={option.value || "all"} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}
          className={cn("h-8 rounded-full px-3 text-label-xs ring-1 ring-inset transition-colors", value === option.value ? "bg-bg-strong-950 text-text-white-0 ring-bg-strong-950" : "bg-bg-white-0 text-text-sub-600 ring-stroke-soft-200 hover:text-text-strong-950")}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function RequestItem({ row, expanded, onToggle }: { row: RequestRow; expanded: boolean; onToggle: () => void }) {
  const [summary, setSummary] = useState<RequestSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setSummary(await fetchRequestSummary(row.key));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [row.key]);
  // Opening a request reads its summary; it refreshes with the list while open.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (expanded) void load(); }, [expanded, load, row.stateLabel, row.counts?.contacted, row.counts?.replied]);
  const counts = row.counts ? `${row.counts.leads} ${row.counts.leads === 1 ? "lead" : "leads"} · ${row.counts.contacted} contacted · ${row.counts.replied} replied${row.counts.failed ? ` · ${row.counts.failed} failed` : ""}` : null;
  const parts = [row.searches ? `${row.searches} ${row.searches === 1 ? "search" : "searches"}` : null, row.plans ? `${row.plans} ${row.plans === 1 ? "plan" : "plans"}` : null].filter(Boolean).join(" · ");
  return (
    <li data-testid="request-row">
      <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-bg-weak-50">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-words text-label-sm text-text-strong-950">{row.title}</span>
            <Badge tone={tone(row)}>{row.stateLabel}</Badge>
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-paragraph-xs text-text-soft-400">
            {row.channels.map((channel) => {
              const meta = CONVERSATION_CHANNEL_META[channel as keyof typeof CONVERSATION_CHANNEL_META];
              const Icon = meta?.icon;
              return <span key={channel} className="inline-flex items-center gap-1">{Icon && <span className="flex" style={{ color: meta.color }}><Icon className="size-3.5" aria-hidden="true" /></span>}{meta?.label ?? channel}</span>;
            })}
            {parts && <span>{parts}</span>}
            {counts && <span>{counts}</span>}
            <span title={new Date(row.startedAt).toLocaleString()}>Started {timeAgo(row.startedAt)}</span>
            {row.threadTitle ? <span className="inline-flex items-center gap-1"><RiChat3Line className="size-3.5" aria-hidden="true" />{row.threadTitle}</span> : row.kind !== "campaign" ? <span>Not from a chat</span> : null}
          </p>
        </div>
        <RiArrowDownSLine className={cn("mt-0.5 size-5 shrink-0 text-text-soft-400 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
      </button>
      {expanded && (
        <div className="border-t border-stroke-soft-200 bg-bg-white-0 px-4 py-4">
          {row.threadId && (
            <Link href={chatHref(row.threadId)} className="mb-3 inline-flex items-center gap-1 text-label-xs text-text-sub-600 hover:text-text-strong-950">
              <RiChat3Line className="size-3.5" aria-hidden="true" />{row.threadTitle ?? "Open the chat"}
            </Link>
          )}
          {error && <ErrorState message={error} onRetry={() => void load()} />}
          {summary ? <RequestSummaryView summary={summary} onChanged={() => void load()} /> : !error && <LoadingRows />}
        </div>
      )}
    </li>
  );
}

export function RequestsClient() {
  const [channel, setChannel] = useState<Channel>("");
  const [state, setState] = useState<StateFilter>("");
  const [data, setData] = useState<{ requests: RequestRow[]; manualCampaigns: RequestRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Filters and the open request live in the URL, so a link opens the same view.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const c = params.get("channel") ?? "";
    const s = params.get("state") ?? "";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if ((CHANNELS as string[]).includes(c)) setChannel(c as Channel);
    if (s === "open" || s === "done") setState(s);
    setExpanded(params.get("request"));
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    for (const [key, value] of [["channel", channel], ["state", state], ["request", expanded ?? ""]] as const) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [channel, state, expanded]);

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      if (channel) query.set("channel", channel);
      if (state) query.set("state", state);
      const response = await fetch(`/api/assistant/requests?${query}`, { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { requests?: RequestRow[]; manualCampaigns?: RequestRow[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (HTTP ${response.status})`);
      setData({ requests: body.requests ?? [], manualCampaigns: body.manualCampaigns ?? [] });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [channel, state]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  useVisiblePolling(() => void load(), POLL_MS);

  const toggle = (key: string) => setExpanded((current) => (current === key ? null : key));
  const list = (rows: RequestRow[]) => (
    <ul className="divide-y divide-stroke-soft-200 overflow-hidden rounded-xl bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200">
      {rows.map((row) => <RequestItem key={row.key} row={row} expanded={expanded === row.key} onToggle={() => toggle(row.key)} />)}
    </ul>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Requests"
        description="Everything you asked the assistant to do, with its searches and plans, what it has done so far and what comes next."
        actions={<button type="button" className={secondaryButtonClass} onClick={() => void load()}><RiRefreshLine className="size-4" aria-hidden="true" />Refresh</button>}
      />
      <WorkspaceNavigation area="outreach" active="/assistant/requests" />
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Chips label="Channel" value={channel} onChange={setChannel} options={CHANNELS.map((value) => ({ value, label: value ? CONVERSATION_CHANNEL_META[value].label : "All channels" }))} />
        <Chips label="State" value={state} onChange={setState} options={[{ value: "" as StateFilter, label: "All" }, { value: "open" as StateFilter, label: "In progress" }, { value: "done" as StateFilter, label: "Finished" }]} />
      </div>
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {data === null ? <LoadingRows /> : (
        <>
          {data.requests.length ? list(data.requests) : (
            <EmptyState icon={RiListCheck3} title={channel || state ? "Nothing matches these filters" : "No requests yet"} description="Ask the assistant for leads or outreach in the chat; each request shows here with its progress for 30 days, and for as long as it is still open." />
          )}
          {data.manualCampaigns.length > 0 && (
            <section aria-labelledby="manual-campaigns" className="space-y-2">
              <h2 id="manual-campaigns" className="text-label-sm text-text-sub-600">Campaigns made by hand</h2>
              <p className="text-paragraph-xs text-text-soft-400">Campaigns created on a channel&apos;s own page (Advanced in the sidebar), not from a chat.</p>
              {list(data.manualCampaigns)}
            </section>
          )}
        </>
      )}
    </div>
  );
}
