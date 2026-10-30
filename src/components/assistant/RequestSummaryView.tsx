"use client";

import Link from "next/link";
import { useState } from "react";
import { RiAlertLine, RiArrowRightLine, RiCheckLine, RiCloseCircleLine, RiCloseLine, RiExternalLinkLine, RiLoader4Line, RiSubtractLine, RiTimeLine, RiUserLine } from "@remixicon/react";
import type { WorkItem } from "@/lib/activity/activity.server";
import { nextAtPhrase, OPEN_STATES } from "@/lib/activity/status";
import { displayTime } from "@/lib/assistant/displayTime";
import { searchListOf, workCounts } from "@/lib/assistant/leadLists";
import { ProspectsList } from "@/components/assistant/ProspectsList";
import type { RequestSummary } from "@/lib/assistant/requests.server";
import { requestSpendLine } from "@/lib/assistant/objective";
import { outreachShown } from "@/lib/assistant/requests";
import { CONVERSATION_CHANNEL_META } from "@/components/analytics/theme";
import { ErrorState, primaryButtonClass } from "@/components/crm/CrmLayout";
import { readRequestJson } from "./requestRead";
import { WorkRow } from "@/components/activity/WorkRow";
import { cn } from "@/utils/cn";

/**
 * One request at a glance (src/lib/assistant/requests.server.ts): its
 * figures, what blocks it, the one next step as a button, and the searches,
 * plans and campaigns underneath with their own controls. `compact` is the
 * panel beside the chat; the Requests page shows it full width.
 */

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (HTTP ${response.status})`);
  return body;
}

export function parseRequestSummary(value: unknown): RequestSummary {
  const body = value as Partial<RequestSummary> | null;
  if (!body || !body.numbers || !body.children || !body.nextAction || typeof body.stateLabel !== "string") throw new Error("The saved request details could not be read. Try again.");
  return body as RequestSummary;
}

export async function fetchRequestSummary(key: string): Promise<RequestSummary> {
  return readRequestJson(`/api/assistant/requests/${encodeURIComponent(key)}`, parseRequestSummary);
}

function Figure({ label, value, detail }: { label: string; value: string; detail?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-paragraph-xs text-text-sub-600">{label}</dt>
      <dd className="mt-0.5 text-[20px] font-semibold leading-tight tracking-tight text-text-strong-950 tabular-nums">{value}</dd>
      {detail && <dd className="truncate text-paragraph-xs text-text-soft-400">{detail}</dd>}
    </div>
  );
}

/** Matching leads against the request's target, as a ring; a request with no number shows the count alone. */
function MatchRing({ value, target }: { value: number | null; target: number | null }) {
  const r = 25;
  const length = 2 * Math.PI * r;
  const share = target && value !== null ? Math.min(1, value / target) : 0;
  return (
    <div className="relative size-16 shrink-0">
      <svg viewBox="0 0 60 60" className="size-16 -rotate-90" aria-hidden="true">
        <circle cx="30" cy="30" r={r} fill="none" strokeWidth="5" className="stroke-bg-soft-200" />
        {target !== null && <circle cx="30" cy="30" r={r} fill="none" strokeWidth="5" strokeLinecap="round" className={cn("research-bar", share >= 1 ? "stroke-success-base" : "stroke-text-strong-950")} strokeDasharray={length} strokeDashoffset={length * (1 - share)} style={{ transition: "stroke-dashoffset 600ms cubic-bezier(.22,1,.36,1)" }} />}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-label-md tabular-nums text-text-strong-950">{value === null ? "—" : value.toLocaleString()}</span>
    </div>
  );
}

/** Ordinary work (queued, searching, waiting for a provider, retrying) is never drawn as a warning; only what waits for the owner is. */
function SearchStateIcon({ item }: { item: WorkItem }) {
  if (item.state === "needs_you") return <RiUserLine className="size-4 shrink-0 text-warning-base" aria-label={item.stateLabel} />;
  if (item.state === "executing") return <RiLoader4Line className="size-4 shrink-0 animate-spin text-text-soft-400" aria-label={item.stateLabel} />;
  if (item.state === "completed") return <RiCheckLine className="size-4 shrink-0 text-success-base" aria-label={item.stateLabel} />;
  if (item.state === "failed") return <RiCloseCircleLine className="size-4 shrink-0 text-error-base" aria-label={item.stateLabel} />;
  if (OPEN_STATES.has(item.state)) return <RiTimeLine className="size-4 shrink-0 text-text-soft-400" aria-label={item.stateLabel} />;
  return <RiSubtractLine className="size-4 shrink-0 text-text-soft-400" aria-label={item.stateLabel} />;
}

/** One search in the narrow column: its state, what it searched, its counts; a finished one opens its lead list. */
function CompactSearch({ item, label, busy, timeZone, onCancel }: { item: WorkItem; label: string | undefined; busy: boolean; timeZone: string; onCancel: (item: WorkItem) => void }) {
  const [open, setOpen] = useState(false);
  const list = searchListOf(item);
  const counts = workCounts(item);
  const source = item.source;
  const detail = [source, item.open ? item.stateLabel : null, counts || (item.open ? null : item.stateLabel)].filter(Boolean).join(" · ");
  const body = (
    <>
      <SearchStateIcon item={item} />
      <span className="min-w-0 flex-1">
        <span className="block line-clamp-2 text-label-xs text-text-strong-950 [overflow-wrap:anywhere]" title={label ?? item.title}>{label ?? item.title}</span>
        <span className="block text-paragraph-xs text-text-soft-400 [overflow-wrap:anywhere]">{detail}</span>
      </span>
    </>
  );
  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        {list
          ? <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-base">{body}</button>
          : <div className="flex min-w-0 flex-1 items-center gap-2.5">{body}</div>}
        {item.canCancel && (
          <button type="button" disabled={busy} onClick={() => onCancel(item)} aria-label={`Cancel ${label ?? item.title}`} title="Cancel this search" className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-soft-400 outline-none hover:bg-bg-weak-50 hover:text-text-strong-950 focus-visible:ring-2 focus-visible:ring-primary-base disabled:opacity-50">
            <RiCloseLine className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>
      {item.reason && <p className="mt-1 pl-[26px] text-paragraph-xs text-text-sub-600 [overflow-wrap:anywhere]">{item.reason}</p>}
      {item.open && item.nextAt && <p className="mt-1 pl-[26px] text-paragraph-xs text-text-sub-600">{nextAtPhrase(item.state)} <time dateTime={item.nextAt}>{displayTime(new Date(item.nextAt), new Date(), timeZone, { seconds: true })}</time></p>}
      {open && list && <div className="research-in mt-2 pl-[26px]"><ProspectsList audienceId={list.audienceId} count={list.count} timeZone={timeZone} /></div>}
    </li>
  );
}

/** A source's yield as one bar: contactable within found, and the matches within those. */
function SourceBar({ source }: { source: NonNullable<RequestSummary["objective"]>["sources"][number] }) {
  const found = Math.max(1, source.found);
  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-label-xs text-text-strong-950">{source.label}</span>
        <span className="shrink-0 text-paragraph-xs tabular-nums text-text-soft-400">{source.found} Found · {source.eligible} Contactable{source.judged ? ` · ${source.matched} Matching` : ""}</span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-bg-soft-200" aria-hidden="true">
        <span className="research-bar absolute inset-y-0 left-0 rounded-full bg-text-strong-950/30" style={{ width: `${Math.round((source.eligible / found) * 100)}%` }} />
        {source.judged > 0 && <span className="research-bar absolute inset-y-0 left-0 rounded-full bg-success-base" style={{ width: `${Math.round((source.matched / found) * 100)}%` }} />}
      </div>
      {(source.failed > 0 || source.notes.length > 0) && <p className="text-paragraph-xs text-text-soft-400 [overflow-wrap:anywhere]">{source.searches} {source.searches === 1 ? "search" : "searches"}{source.failed ? `, ${source.failed} failed` : ""}{source.notes.length ? ` (${source.notes.join("; ")})` : ""}</p>}
    </li>
  );
}

/**
 * The request's figures under the names used everywhere (requests.ts):
 * Found, Contactable, Matching, then Contacted, Replied, Interested only
 * once outreach is relevant; "—" for one nothing measured.
 */
function figuresOf(summary: RequestSummary): { label: string; value: string }[] {
  const n = summary.numbers;
  const format = (value: number | null) => (value === null ? "—" : value.toLocaleString("en-US"));
  const figures = [
    { label: "Found", value: format(n.found) },
    { label: "Contactable", value: format(n.contactable) },
    { label: "Matching", value: n.matching !== null && summary.target !== null ? `${format(n.matching)} of ${summary.target}` : format(n.matching) },
  ];
  if (outreachShown({ plans: summary.children.plans.length, campaigns: summary.children.campaigns.length, numbers: n })) {
    figures.push({ label: "Contacted", value: format(n.contacted) }, { label: "Replied", value: format(n.replied) }, { label: "Interested", value: format(n.interested) });
  }
  return figures;
}

export function RequestSummaryView({ summary, compact = false, onChanged, labels }: { summary: RequestSummary; compact?: boolean; onChanged?: () => void; labels?: Record<string, string> }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const n = summary.numbers;
  const next = summary.nextAction;
  const objective = summary.objective;

  const act = async (id: string, request: () => Promise<Response>) => {
    setBusyId(id);
    setActionError(null);
    try {
      await readJson(await request());
      onChanged?.();
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

  const children = [...summary.children.searches, ...summary.children.plans];
  if (compact) {
    // The request itself (its driver job) is this panel, not a row in it.
    const searches = summary.children.searches.filter((item) => item.kind !== "objective");
    const running = searches.filter((item) => item.open).length;
    return (
      <div className="space-y-4" data-testid="request-summary">
        {summary.target !== null && (
          <div className="flex items-center gap-4 rounded-2xl bg-bg-weak-50 p-3">
            <MatchRing value={n.matching} target={summary.target} />
            <div className="min-w-0">
              <p className="text-label-sm text-text-strong-950">Matching</p>
              <p className="mt-0.5 text-paragraph-xs text-text-sub-600">{n.matching ?? 0} of the {summary.target} you asked for</p>
            </div>
          </div>
        )}
        <dl className="grid grid-cols-3 gap-2" data-testid="request-figures">
          {figuresOf(summary).map(({ label, value }) => (
            <div key={label} className="min-w-0 rounded-xl px-2.5 py-2 ring-1 ring-inset ring-stroke-soft-200">
              <dt className="text-paragraph-xs text-text-sub-600 [overflow-wrap:anywhere]">{label}</dt>
              <dd className="text-label-lg tabular-nums text-text-strong-950">{value}</dd>
            </div>
          ))}
        </dl>
        {n.failed > 0 && <p className="text-paragraph-xs text-error-base">{n.failed.toLocaleString()} failed to send</p>}

        {summary.blocker && (
          <p className="flex gap-2 rounded-xl bg-warning-lighter px-3 py-2 text-paragraph-xs text-warning-dark" data-testid="request-blocker">
            <RiAlertLine className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span className="min-w-0 [overflow-wrap:anywhere]">{summary.blocker}</span>
          </p>
        )}

        {next.kind === "research" ? <p className="text-paragraph-xs text-text-sub-600 [overflow-wrap:anywhere]" data-testid="request-next">{next.detail}</p> : <div className="rounded-xl p-3 ring-1 ring-inset ring-stroke-soft-200" data-testid="request-next">
          <p className="text-paragraph-xs text-text-soft-400">Next step</p>
          {next.href
            ? <Link href={next.href} className={cn(primaryButtonClass, "mt-1.5 inline-flex h-9 max-w-full items-center gap-1.5")}><span className="truncate">{next.label}</span><RiArrowRightLine className="size-4 shrink-0" aria-hidden="true" /></Link>
            : <p className="mt-0.5 text-label-sm text-text-strong-950">{next.label}</p>}
          {next.detail && <p className="mt-1 text-paragraph-xs text-text-sub-600 [overflow-wrap:anywhere]">{next.detail}</p>}
        </div>}

        {actionError && <ErrorState message={actionError} />}

        {searches.length > 0 && (
          <section>
            <h3 className="mb-2 flex items-baseline justify-between text-label-xs text-text-sub-600">
              <span>Searches</span>
              <span className="text-paragraph-xs text-text-soft-400">{running ? `${running} running · ` : ""}{searches.length} in all</span>
            </h3>
            <ul className="divide-y divide-stroke-soft-200 overflow-hidden rounded-xl ring-1 ring-inset ring-stroke-soft-200">
              {searches.map((item) => <CompactSearch key={item.id} item={item} label={labels?.[item.id]} busy={busyId === item.id} timeZone={summary.timeZone} onCancel={cancelJob} />)}
            </ul>
          </section>
        )}

        {summary.children.plans.length > 0 && (
          <section>
            <h3 className="mb-2 text-label-xs text-text-sub-600">Outreach plans</h3>
            <ul className="divide-y divide-stroke-soft-200 overflow-hidden rounded-xl ring-1 ring-inset ring-stroke-soft-200">
              {summary.children.plans.map((item) => <WorkRow key={item.id} item={item} busy={busyId === item.id} timeZone={summary.timeZone} onCancel={cancelJob} onRun={runAction} compact />)}
            </ul>
          </section>
        )}

        {summary.children.campaigns.length > 0 && (
          <section>
            <h3 className="mb-2 text-label-xs text-text-sub-600">Campaigns</h3>
            <ul className="flex flex-wrap gap-2">
              {summary.children.campaigns.map((campaign) => {
                const meta = CONVERSATION_CHANNEL_META[campaign.channel];
                const Icon = meta.icon;
                return (
                  <li key={campaign.id}>
                    <Link href={campaign.href} className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg px-2.5 text-label-xs text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200 hover:bg-bg-weak-50">
                      <span className="flex shrink-0" style={{ color: meta.color }}><Icon className="size-4" aria-hidden="true" /></span>
                      <span className="truncate">{campaign.name}</span>
                      <span className="shrink-0 text-text-soft-400">· {campaign.status}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {objective && (
          <details className="group rounded-xl ring-1 ring-inset ring-stroke-soft-200">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-label-xs text-text-strong-950 [&::-webkit-details-marker]:hidden">
              Research details
              <span className="text-paragraph-xs text-text-soft-400 group-open:hidden">{objective.sources.length} {objective.sources.length === 1 ? "source" : "sources"}</span>
            </summary>
            <div className="space-y-3 border-t border-stroke-soft-200 px-3 py-3 text-paragraph-xs text-text-sub-600">
              <p>{objective.leads}{summary.target !== null ? ` of ${summary.target}` : ""} Matching · {requestSpendLine(objective.spentUsd, objective.spendCapUsd)}{objective.status === "active" ? ` · ${Math.max(0, Math.round(objective.msLeft / 60_000))} min left` : ""}</p>
              {objective.waiting && <p>Waiting: {objective.waiting}</p>}
              {objective.sources.length > 0 && <ul className="space-y-2.5">{objective.sources.map((source) => <SourceBar key={source.label} source={source} />)}</ul>}
              {objective.stopDetail && <p>Ended: {objective.stopDetail}</p>}
              {summary.threadId && <p className="text-text-soft-400">The full report is in the chat.</p>}
            </div>
          </details>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-4" data-testid="request-summary">
      <dl className="grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-6" data-testid="request-figures">
        {figuresOf(summary).map(({ label, value }) => <Figure key={label} label={label} value={value} />)}
      </dl>
      {n.failed > 0 && <p className="text-paragraph-xs text-error-base">{n.failed.toLocaleString()} failed to send</p>}

      {summary.blocker && (
        <p className="flex gap-2 rounded-lg bg-warning-lighter px-3 py-2 text-paragraph-xs text-warning-dark" data-testid="request-blocker">
          <RiAlertLine className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><span className="min-w-0 [overflow-wrap:anywhere]">{summary.blocker}</span>
        </p>
      )}

      <div className="rounded-xl bg-bg-weak-50 p-3" data-testid="request-next">
        <p className="text-paragraph-xs text-text-sub-600">Next step</p>
        {next.href
          ? <Link href={next.href} className={cn(primaryButtonClass, "mt-1.5 inline-flex h-9 max-w-full items-center gap-1.5")}><span className="truncate">{next.label}</span><RiArrowRightLine className="size-4 shrink-0" aria-hidden="true" /></Link>
          : <p className="mt-1 text-label-sm text-text-strong-950">{next.label}</p>}
        {next.detail && <p className="mt-1.5 text-paragraph-xs text-text-sub-600 [overflow-wrap:anywhere]">{next.detail}</p>}
      </div>

      {actionError && <ErrorState message={actionError} />}

      {children.length > 0 && (
        <section>
          <h3 className="mb-2 text-label-xs text-text-sub-600">Searches and plans</h3>
          <ul className="divide-y divide-stroke-soft-200 overflow-hidden rounded-xl bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200">
            {children.map((item) => <WorkRow key={`${item.type}:${item.id}`} item={item} busy={busyId === item.id} timeZone={summary.timeZone} onCancel={cancelJob} onRun={runAction} compact={compact} />)}
          </ul>
        </section>
      )}

      {summary.children.campaigns.length > 0 && (
        <section>
          <h3 className="mb-2 text-label-xs text-text-sub-600">Campaigns</h3>
          <ul className="flex flex-wrap gap-2">
            {summary.children.campaigns.map((campaign) => {
              const meta = CONVERSATION_CHANNEL_META[campaign.channel];
              const Icon = meta.icon;
              return (
                <li key={campaign.id}>
                  <Link href={campaign.href} className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-lg px-2.5 text-label-xs text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200 hover:bg-bg-weak-50">
                    <span className="flex shrink-0" style={{ color: meta.color }}><Icon className="size-4" aria-hidden="true" /></span>
                    <span className="truncate">{campaign.name}</span>
                    <span className="shrink-0 text-text-soft-400">· {campaign.status}</span>
                    <RiExternalLinkLine className="size-3.5 shrink-0 text-text-soft-400" aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {objective && (
        <details className="rounded-xl ring-1 ring-inset ring-stroke-soft-200">
          <summary className="cursor-pointer px-3 py-2.5 text-label-xs text-text-strong-950">Research details</summary>
          <div className="space-y-2 border-t border-stroke-soft-200 px-3 py-3 text-paragraph-xs text-text-sub-600">
            <p>{objective.leads}{summary.target !== null ? ` of ${summary.target}` : ""} Matching · {requestSpendLine(objective.spentUsd, objective.spendCapUsd)}{objective.status === "active" ? ` · ${Math.max(0, Math.round(objective.msLeft / 60_000))} min left` : ""}</p>
            {objective.waiting && <p>Waiting: {objective.waiting}</p>}
            {objective.sources.length > 0 && (
              <ul className="space-y-1">
                {objective.sources.map((source) => (
                  <li key={source.label} className="[overflow-wrap:anywhere]">
                    <span className="text-text-strong-950">{source.label}</span>: {source.searches} {source.searches === 1 ? "search" : "searches"}, {source.found} Found, {source.eligible} Contactable{source.judged ? `, ${source.matched} Matching of ${source.judged} judged` : ""}{source.failed ? `, ${source.failed} failed` : ""}{source.notes.length ? ` (${source.notes.join("; ")})` : ""}
                  </li>
                ))}
              </ul>
            )}
            {objective.stopDetail && <p>Ended: {objective.stopDetail}</p>}
            {summary.threadId && <p>The full report is in the chat.</p>}
          </div>
        </details>
      )}
    </div>
  );
}
