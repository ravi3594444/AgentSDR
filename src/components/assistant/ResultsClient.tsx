"use client";

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { RiArrowRightLine, RiMailSendLine } from "@remixicon/react";

import { EmptyState } from "@/components/page/EmptyState";
import { WorkspaceNavigation, WorkspaceStats } from "@/components/page/WorkspaceNavigation";
import { useRecordChanged } from "@/components/crm/recordEvents";
import type { NeedsYouPayload } from "@/components/assistant/NeedsYouList";
import { LeadSourcesTable } from "@/components/reporting/LeadSourcesTable";
import { MetricDefinitions, SHARED_METRIC_KEYS } from "@/components/reporting/MetricDefinitions";
import { describeChannelSending, figure, money, percent, PERIOD_KINDS, type PeriodKind } from "@/lib/assistant/results";
import type { Results } from "@/lib/assistant/results.server";
import { cn } from "@/utils/cn";

/**
 * Reports: the owner's results — leads, outreach, replies, what waits for
 * them, failures, spending and limits, for a period in the business's time
 * zone — as summary numbers with the details folded below, plus the daily
 * summaries. `children` (Reports' per-channel section) sits under the numbers. Every figure comes from recorded events; one
 * the app does not measure says so. The figures Analytics shows too come
 * from the shared definitions (src/lib/reporting/metrics.ts), and what waits
 * right now is labelled apart from the period's totals. Loading or
 * refreshing reads only.
 */

type Decision = { id: string; kind: string; reason: string; decision: string; crmRecordId: string | null; createdAt: string };
type Summary = { day: string; timeZone: string; data: { text?: string } };

export type ResultsPayload = { results: Results; decisions: Decision[]; summaries: Summary[]; needsYou?: NeedsYouPayload };

const PERIOD_LABEL: Record<PeriodKind, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7_days: "7 days",
  last_30_days: "30 days",
  all_time: "All time",
};

/** The Analytics preset that covers the same days (src/lib/analytics/range.ts); all time has none. */
export const ANALYTICS_RANGE: Partial<Record<PeriodKind, string>> = {
  today: "today",
  yesterday: "yesterday",
  last_7_days: "7d",
  last_30_days: "30d",
};

function Section({ title, children, className, collapsible = false }: { title: string; children: React.ReactNode; className?: string; collapsible?: boolean }) {
  const content = <div className="mt-4 text-paragraph-sm leading-relaxed text-text-sub-600">{children}</div>;
  const classes = cn("min-w-0 border-b border-stroke-soft-200 py-5", className);
  if (collapsible) return <details className={classes}><summary className="cursor-pointer text-label-md text-text-strong-950">{title}</summary>{content}</details>;
  return <section className={classes}><h2 className="text-label-md text-text-strong-950">{title}</h2>{content}</section>;
}

function List({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-paragraph-xs text-text-soft-400">{empty}</p>;
  return <ul className="space-y-1 text-paragraph-xs">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
}

export default function ResultsClient({ initial, onPeriodChange, children }: { initial: ResultsPayload; onPeriodChange?: (period: PeriodKind) => void; children?: ReactNode }) {
  const [payload, setPayload] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const selectedPeriod = useRef(initial.results.period.kind);
  const r = payload.results;
  const o = r.outreach;

  async function load(period: PeriodKind) {
    if (period !== selectedPeriod.current) onPeriodChange?.(period);
    selectedPeriod.current = period;
    const mine = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/assistant/results?period=${period}`, { cache: "no-store" });
      const body = (await response.json()) as ResultsPayload & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      if (mine !== request.current) return;
      setPayload((current) => ({ ...body, needsYou: current.needsYou }));
    } catch (cause) {
      if (mine === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mine === request.current) setLoading(false);
    }
  }

  useRecordChanged(() => { void load(selectedPeriod.current); });

  return (
    <div aria-busy={loading} className="mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[26px] font-semibold tracking-[-0.035em] text-text-strong-950">Reports</h1>
        <p className="text-paragraph-xs text-text-soft-400">{r.period.label} · {r.period.timeZone} (business time zone)</p>
        <div role="group" aria-label="Filter results by period" className="ml-auto flex flex-wrap gap-1 rounded-lg bg-bg-weak-50 p-1">
          {PERIOD_KINDS.map((kind) => (
            <button key={kind} type="button" aria-pressed={r.period.kind === kind} disabled={loading} onClick={() => void load(kind)}
              className={cn("rounded-md px-3 py-2 text-label-xs transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-base disabled:opacity-60", r.period.kind === kind ? "bg-bg-strong-950 text-text-white-0" : "text-text-sub-600 hover:text-text-strong-950")}>
              {PERIOD_LABEL[kind]}
            </button>
          ))}
        </div>
      </header>
      <WorkspaceNavigation area="outreach" active="/assistant/reports" />
      {error && <p role="alert" className="text-paragraph-sm text-error-base">{error}</p>}

      {r.now.needsYou + r.now.actionRequired > 0 && (
        <Link href="/inbox?view=needs_you" className="flex items-center gap-2 rounded-xl bg-bg-weak-50 px-3.5 py-3 text-label-xs text-text-strong-950 hover:bg-bg-soft-200">
          <span className="min-w-0 flex-1">{r.now.needsYou} {r.now.needsYou === 1 ? "decision" : "decisions"} and {r.now.actionRequired} {r.now.actionRequired === 1 ? "conversation" : "conversations"} wait for you in the Inbox</span>
          <RiArrowRightLine className="size-4 shrink-0" aria-hidden="true" />
        </Link>
      )}

      <section aria-labelledby="results-now" className="border-b border-stroke-soft-200 pb-1">
        <h2 id="results-now" className="text-label-sm text-text-strong-950">Right now <span className="ml-1 text-paragraph-xs font-normal text-text-soft-400">current counts, not limited to the period</span></h2>
        <WorkspaceStats className="py-3" items={[
          { label: "Needs you", value: r.now.needsYou, detail: "Open decisions" },
          { label: "Drafts to review", value: r.now.draftsAwaitingReview, detail: "Replies waiting" },
          { label: "Action required", value: r.now.actionRequired, detail: `${r.now.followUpsDue} follow-ups due` },
          { label: "Plans waiting", value: r.now.plansAwaitingStart, detail: "For your Start" },
          { label: "Still to send", value: r.now.stillToSend.email + r.now.stillToSend.whatsapp + r.now.stillToSend.linkedin + r.now.stillToSend.instagram, detail: "Leads in sequences" },
        ]} />
      </section>

      <section aria-labelledby="results-period">
        <h2 id="results-period" className="text-label-sm text-text-strong-950">In this period <span className="ml-1 text-paragraph-xs font-normal text-text-soft-400">{r.period.label}</span></h2>
        <WorkspaceStats className="py-3" items={[
          { label: "Leads found", value: r.leads.found, detail: `${r.leads.qualified} qualified · ${r.leads.contactable} contactable` },
          { label: "People contacted", value: o.peopleContacted, detail: "At least one accepted send" },
          { label: "Replies", value: o.repliesReceived, detail: `From ${o.peopleReplied} people` },
          { label: "Reply rate", value: percent(o.replyRate), detail: `${o.contactedWhoReplied} of ${o.peopleContacted} contacted replied` },
          { label: "Classified interested", value: o.interested, detail: "Replies the AI marked Interested in this period" },
        ]} />
      </section>
      <div className="flex flex-wrap gap-x-6 gap-y-2 border-y border-stroke-soft-200 py-3 text-paragraph-xs text-text-sub-600">
        <span>Email sent <strong className="ml-1 text-text-strong-950">{o.emailsSent}</strong></span>
        <span>WhatsApp sent <strong className="ml-1 text-text-strong-950">{o.whatsappSent}</strong>{o.whatsappSent > 0 && <span className="ml-1">({o.whatsappDelivered} delivered · {o.whatsappRead} read)</span>}</span>
        <span>LinkedIn <strong className="ml-1 text-text-strong-950">{o.linkedinInvitations} requests · {o.linkedinMessages} messages</strong></span>
        <span>Instagram DMs <strong className="ml-1 text-text-strong-950">{o.instagramSent}</strong></span>
        <span>Answered <strong className="ml-1 text-text-strong-950">{o.automaticReplies} by AI · {o.repliesByYou} by you</strong></span>
      </div>

      {children}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Interested people" collapsible>
          <p className="mb-3 text-paragraph-xs text-text-soft-400">Replies the AI classified as Interested in this period (applied or accepted). A record moved by hand is not counted here; the By channel section&apos;s Positive counts every move into Interested or Customer, and Pipeline shows who is Interested now. Open Leads to read the full conversations.</p>
          <List items={r.interestedPeople.map((p) => `${p.name}${p.what ? ` — ${p.what}` : ""} (${new Date(p.at).toLocaleString()})`)} empty="No interested replies in this period." />
          <Link href="/leads?view=board" className="mt-4 inline-block text-label-xs text-text-strong-950 underline underline-offset-4">Open the Leads board</Link>
        </Section>
        <Section title="Where leads came from" collapsible>
          <LeadSourcesTable sources={r.leads.sources} empty="No leads were found or imported in this period." />
        </Section>
        <Section title="Still to send (now)" collapsible>
          <p className="text-paragraph-xs">{r.pending.emailFollowUps} email leads, {r.pending.whatsappFollowUps} WhatsApp leads and {r.pending.linkedinSteps} LinkedIn leads are still in their sequences (active campaigns, now). {r.pending.instagramDms} initial Instagram DMs are queued or being submitted.</p>
          <p className="mt-1 text-paragraph-xs text-text-soft-400">Email {describeChannelSending(r.sending.email)}.</p>
          <p className="text-paragraph-xs text-text-soft-400">WhatsApp {describeChannelSending(r.sending.whatsapp)}.</p>
        </Section>
        <Section title="Stopped and held" collapsible>
          <List
            items={[
              `${r.stopped.optedOut} asked not to be contacted`,
              ...r.stopped.suppressed.map((x) => `${x.count} email addresses suppressed (${x.reason})`),
              `${r.stopped.runLeadsStopped} ${r.stopped.runLeadsStopped === 1 ? "lead" : "leads"} stopped in runs`,
              ...r.attention.heldByAutopilot.map((x) => `${x.count} automatic ${x.count === 1 ? "reply" : "replies"} held: ${x.reason}`),
            ]}
            empty="Nothing stopped."
          />
        </Section>
        <Section title="Failures" collapsible>
          <List items={r.failures.map((f) => `${f.count} × ${f.channel}: ${f.reason}`)} empty="No failures recorded in this period." />
        </Section>
        <Section title="Spending and limits" collapsible>
          <ul className="space-y-1 text-paragraph-xs">
            <li>AI spending recorded: <span className="text-text-strong-950">{money(r.spending.aiRecordedUsd)}</span> over {r.spending.aiCalls} assistant calls{r.spending.aiCallsWithoutCost ? ` (${r.spending.aiCallsWithoutCost} without a reported cost)` : ""}.</li>
            {r.spending.byKind.map((k) => <li key={k.kind} className="pl-3">{k.kind.replace(/_/g, " ")}: {money(k.usd)} ({k.calls} calls)</li>)}
            <li>Company research: {money(r.spending.researchUsd)}.</li>
            <li className="text-text-soft-400">{r.spending.dataSources} Plan cards show estimates; these are recorded costs.</li>
            <li className="pt-1">Automatic replies left in the next 24 hours: <span className="text-text-strong-950">{r.limits.automaticRepliesLeft24h}</span></li>
            <li>Emails left today across connected mailboxes: <span className="text-text-strong-950">{figure(r.limits.emailsLeftToday)}</span></li>
            <li>Research runs left today: <span className="text-text-strong-950">{figure(r.limits.researchLeftToday)}</span></li>
            <li>WhatsApp new chats left today: <span className="text-text-strong-950">{figure(r.limits.whatsappNewChatsLeftToday)}</span></li>
          </ul>
        </Section>
      </div>

      <Section title="Outreach runs" collapsible>
        {r.attention.plansAwaitingStart > 0 && (
          <p className="mb-2 text-paragraph-xs text-text-sub-600">
            {r.attention.plansAwaitingStart} {r.attention.plansAwaitingStart === 1 ? "plan waits" : "plans wait"} for your Start
            {r.attention.plansAwaiting.length ? ` (${r.attention.plansAwaiting.map((plan) => `“${plan.name}”`).join(", ")}${r.attention.plansAwaitingStart > r.attention.plansAwaiting.length ? ", …" : ""})` : ""}. Nothing is sent for {r.attention.plansAwaitingStart === 1 ? "it" : "them"} until then; open the chat to review.
          </p>
        )}
        {r.runs.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-paragraph-xs">
              <thead><tr className="text-text-soft-400"><th className="py-1 pr-3 font-normal">Run</th><th className="pr-3 font-normal">Status</th><th className="pr-3 font-normal">Reply mode</th><th className="font-normal">Per channel (people contacted / messages sent / replied / stopped or failed now)</th></tr></thead>
              <tbody>
                {r.runs.map((run) => (
                  <tr key={run.id} className="border-t border-stroke-soft-200 text-text-strong-950">
                    <td className="py-1.5 pr-3">{run.name}</td>
                    <td className="pr-3">{run.status}</td>
                    <td className="pr-3">{run.mode}</td>
                    <td>{run.channels.map((c) => `${c.channel}: ${c.contacted} / ${c.messagesSent ?? "—"} / ${c.replied} / ${c.stopped}`).join(" · ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState compact icon={RiMailSendLine} title="No outreach runs in this period" description="Try another date range, or open the assistant to plan your next outreach." action={<Link href="/assistant" className="rounded-lg bg-bg-strong-950 px-4 py-2 text-label-xs text-text-white-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-base">Open the chat</Link>} />}
      </Section>

      <Section title="How these figures are counted" collapsible>
        <p className="mb-3 text-paragraph-xs text-text-soft-400">
          The same definitions as the By channel section, for whole local days in {r.period.timeZone}. A send counts once its provider accepted it; queued, failed and uncertain sends never do.
        </p>
        <MetricDefinitions keys={SHARED_METRIC_KEYS} />
      </Section>

      <Section title="Daily summaries" collapsible>
        {payload.summaries.length ? (
          <div className="space-y-2">
            {payload.summaries.map((s) => (
              <details key={s.day} className="rounded-lg bg-bg-weak-50 px-3 py-2">
                <summary className="cursor-pointer text-label-xs text-text-strong-950">{s.day} ({s.timeZone})</summary>
                <p className="mt-1 whitespace-pre-wrap text-paragraph-xs">{s.data.text}</p>
              </details>
            ))}
          </div>
        ) : <p className="text-paragraph-xs text-text-soft-400">The first summary is written at the start of your next day.</p>}
      </Section>
    </div>
  );
}
