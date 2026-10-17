"use client";

import { useState } from "react";
import Link from "next/link";
import {
  RiArrowLeftLine,
  RiChat3Line,
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiLinkedinBoxLine,
  RiMailSendLine,
  RiSearchLine,
  RiStarLine,
  RiUserFollowLine,
  RiWhatsappLine,
} from "@remixicon/react";

import { EmptyState } from "@/components/page/EmptyState";
import { KpiCell, KpiStrip } from "@/components/analytics/kit/KpiStrip";
import NeedsYouList, { type NeedsYouPayload } from "@/components/assistant/NeedsYouList";
import { describeChannelSending, figure, money, PERIOD_KINDS, type PeriodKind } from "@/lib/assistant/results";
import type { Results } from "@/lib/assistant/results.server";
import { cn } from "@/utils/cn";

/**
 * The owner's results: leads, outreach, replies, what waits for them,
 * failures, spending and limits, for a period in the business's time zone,
 * plus the daily summaries. Every figure comes from recorded events; one
 * the app does not measure says so.
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

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-4", className)}>
      <h2 className="text-label-md text-text-strong-950">{title}</h2>
      <div className="mt-2 text-paragraph-sm text-text-sub-600">{children}</div>
    </section>
  );
}

function List({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-paragraph-xs text-text-soft-400">{empty}</p>;
  return <ul className="space-y-1 text-paragraph-xs">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
}

export default function ResultsClient({ initial }: { initial: ResultsPayload }) {
  const [payload, setPayload] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = payload.results;
  const o = r.outreach;

  async function load(period: PeriodKind) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/assistant/results?period=${period}`, { cache: "no-store" });
      const body = (await response.json()) as ResultsPayload & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setPayload((current) => ({ ...body, needsYou: current.needsYou }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div aria-busy={loading} className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link href="/assistant" className="inline-flex items-center gap-1 text-label-xs text-text-sub-600 hover:text-text-strong-950"><RiArrowLeftLine className="size-4" /> Assistant</Link>
        <h1 className="text-[26px] font-semibold tracking-[-0.035em] text-text-strong-950">Results</h1>
        <p className="text-paragraph-xs text-text-soft-400">{r.period.label} · {r.period.timeZone}</p>
        <div role="group" aria-label="Filter results by period" className="ml-auto flex flex-wrap gap-1 rounded-lg bg-bg-weak-50 p-1">
          {PERIOD_KINDS.map((kind) => (
            <button key={kind} type="button" aria-pressed={r.period.kind === kind} disabled={loading} onClick={() => void load(kind)}
              className={cn("rounded-md px-3 py-2 text-label-xs transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-base disabled:opacity-60", r.period.kind === kind ? "bg-bg-strong-950 text-text-white-0" : "text-text-sub-600 hover:text-text-strong-950")}>
              {PERIOD_LABEL[kind]}
            </button>
          ))}
        </div>
      </header>
      {error && <p role="alert" className="text-paragraph-sm text-error-base">{error}</p>}

      <NeedsYouList initial={initial.needsYou ?? null} />

      <KpiStrip columns={5}>
        <KpiCell icon={RiSearchLine} label="Leads found" value={String(r.leads.discovered)} context={`${r.leads.imported} from your lists · ${r.leads.duplicates} duplicates merged`} hint="Businesses found by lead search, and people imported from lists, in this period." />
        <KpiCell icon={RiCheckboxCircleLine} label="Contactable" value={String(r.leads.usable)} context={`${r.leads.leftOut} left out with a reason`} hint="Leads with a usable, permitted email, phone or LinkedIn profile." />
        <KpiCell icon={RiUserFollowLine} label="People contacted" value={String(o.peopleContacted)} context="had at least one message sent" hint="Distinct people with a sent email, WhatsApp message or LinkedIn request/message in this period, from each channel's send records. Unsubscribing later does not remove them." />
        <KpiCell icon={RiChat3Line} label="Replies" value={String(o.repliesReceived)} context={`from ${o.peopleReplied} people`} hint="Inbound replies recorded by the CRM in this period." />
        <KpiCell icon={RiStarLine} label="Interested" value={String(o.interested)} context="classified interested; not a sale" hint="Conversations whose reply was classified Interested (applied automatically or by you). Interest is not a closed sale." />
      </KpiStrip>

      <KpiStrip columns={5}>
        <KpiCell icon={RiMailSendLine} label="Emails sent" value={String(o.emailsSent)} hint="Campaign emails with status sent (first messages and follow-ups). Drafts are never counted." />
        <KpiCell icon={RiWhatsappLine} label="WhatsApp sent" value={String(o.whatsappSent)} hint="WhatsApp campaign messages confirmed sent." />
        <KpiCell icon={RiLinkedinBoxLine} label="LinkedIn requests" value={String(o.linkedinInvitations)} context={`${o.linkedinMessages} LinkedIn messages`} hint="Connection requests confirmed by LinkedIn, counted apart from messages (acceptance and follow-ups)." />
        <KpiCell icon={RiChat3Line} label="Replies answered" value={String(o.automaticReplies + o.repliesByYou)} context={`${o.automaticReplies} automatically · ${o.repliesByYou} by you`} hint="CRM replies sent: by the reply autopilot or by a person." />
        <KpiCell icon={RiErrorWarningLine} label="Waiting for you" value={String(r.attention.repliesWaiting + r.attention.openDecisions)} context={`${r.attention.openDecisions} ${r.attention.openDecisions === 1 ? "decision" : "decisions"} · ${r.attention.repliesWaiting} ${r.attention.repliesWaiting === 1 ? "reply" : "replies"} to review`} hint="Open decisions from the assistant and AI reply drafts waiting in Action required (now, not just this period)." />
      </KpiStrip>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Interested people">
          <List items={r.interestedPeople.map((p) => `${p.name}${p.what ? ` — ${p.what}` : ""} (${new Date(p.at).toLocaleString()})`)} empty="No interested replies in this period." />
        </Section>
        <Section title="Still to send">
          <p className="text-paragraph-xs">{r.pending.emailFollowUps} email leads, {r.pending.whatsappFollowUps} WhatsApp leads and {r.pending.linkedinSteps} LinkedIn leads are still in their sequences (active campaigns, now).</p>
          <p className="mt-1 text-paragraph-xs text-text-soft-400">Email {describeChannelSending(r.sending.email)}.</p>
          <p className="text-paragraph-xs text-text-soft-400">WhatsApp {describeChannelSending(r.sending.whatsapp)}.</p>
        </Section>
        <Section title="Stopped and held">
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
        <Section title="Failures">
          <List items={r.failures.map((f) => `${f.count} × ${f.channel}: ${f.reason}`)} empty="No failures recorded in this period." />
        </Section>
        <Section title="Spending and limits">
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

      <Section title="Outreach runs">
        {r.runs.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-paragraph-xs">
              <thead><tr className="text-text-soft-400"><th className="py-1 pr-3 font-normal">Run</th><th className="pr-3 font-normal">Status</th><th className="pr-3 font-normal">Reply mode</th><th className="font-normal">Per channel (contacted / sent / replied / stopped)</th></tr></thead>
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
        ) : <EmptyState compact icon={RiMailSendLine} title="No outreach runs in this period" description="Try another date range, or open the assistant to plan your next outreach." action={<Link href="/assistant" className="rounded-lg bg-bg-strong-950 px-4 py-2 text-label-xs text-text-white-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-base">Open assistant</Link>} />}
      </Section>

      <Section title="Daily summaries">
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
