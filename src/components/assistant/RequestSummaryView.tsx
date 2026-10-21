"use client";

import Link from "next/link";
import { useState } from "react";
import { RiAlertLine, RiArrowRightLine, RiExternalLinkLine } from "@remixicon/react";
import type { WorkItem } from "@/lib/activity/activity.server";
import type { RequestSummary } from "@/lib/assistant/requests.server";
import { requestSpendLine } from "@/lib/assistant/objective";
import { CONVERSATION_CHANNEL_META } from "@/components/analytics/theme";
import { ErrorState, primaryButtonClass } from "@/components/crm/CrmLayout";
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

export async function fetchRequestSummary(key: string): Promise<RequestSummary> {
  return readJson<RequestSummary>(await fetch(`/api/assistant/requests/${encodeURIComponent(key)}`, { cache: "no-store" }));
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

export function RequestSummaryView({ summary, compact = false, onChanged }: { summary: RequestSummary; compact?: boolean; onChanged?: () => void }) {
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
  return (
    <div className="space-y-4" data-testid="request-summary">
      <dl className={cn("grid gap-x-4 gap-y-3", compact ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-5")}>
        <Figure label="Matching" value={n.matching === null ? "—" : n.matching.toLocaleString()} detail={summary.target ? `of ${summary.target} wanted` : null} />
        <Figure label="Contacted" value={n.contacted.toLocaleString()} />
        <Figure label="Replied" value={n.replied.toLocaleString()} />
        <Figure label="Interested" value={n.interested.toLocaleString()} />
        <Figure label="Failed" value={n.failed.toLocaleString()} />
      </dl>

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
            <p>{objective.leads} of {objective.leadTarget} leads found · {requestSpendLine(objective.spentUsd, objective.spendCapUsd)}{objective.status === "active" ? ` · ${Math.max(0, Math.round(objective.msLeft / 60_000))} min left` : ""}</p>
            {objective.waiting && <p>Waiting: {objective.waiting}</p>}
            {objective.sources.length > 0 && (
              <ul className="space-y-1">
                {objective.sources.map((source) => (
                  <li key={source.label} className="[overflow-wrap:anywhere]">
                    <span className="text-text-strong-950">{source.label}</span>: {source.searches} {source.searches === 1 ? "search" : "searches"}, {source.found} found, {source.eligible} contactable{source.judged ? `, ${source.matched} of ${source.judged} match` : ""}{source.failed ? `, ${source.failed} failed` : ""}{source.notes.length ? ` (${source.notes.join("; ")})` : ""}
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
