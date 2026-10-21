"use client";

import {
  RiAlarmWarningLine,
  RiArrowRightSLine,
  RiCalendarEventLine,
  RiCheckboxCircleLine,
  RiDraftLine,
  RiFlagLine,
  RiInboxLine,
  RiLinkedinBoxLine,
  RiMailForbidLine,
  RiPercentLine,
  RiReplyLine,
  RiSendPlaneLine,
  RiThumbUpLine,
  RiTimerLine,
  RiTrophyLine,
  RiUserFollowLine,
  RiWhatsappLine,
} from "@remixicon/react";
import * as Table from "@/components/alignui/table";
import { LeadSourcesTable } from "@/components/reporting/LeadSourcesTable";
import { MetricDefinitions, SHARED_METRIC_KEYS } from "@/components/reporting/MetricDefinitions";
import { ANALYTICS_CHANNELS, type AnalyticsChannel, type AnalyticsView, type OverviewAnalytics } from "@/lib/analytics/contract";
import { METRICS } from "@/lib/reporting/metrics";
import { cn } from "@/utils/cn";
import { ChartCard } from "../kit/ChartCard";
import { Frame, FrameHeader, FramePanel } from "../kit/Frame";
import { FunnelChart } from "../kit/FunnelChart";
import { KpiCell, KpiStrip } from "../kit/KpiStrip";
import { ProgressList, type ProgressTone } from "../kit/ProgressList";
import { SectionHeading } from "../kit/SectionHeading";
import { CONVERSATION_CHANNEL_META, formatCompact, formatMinutes, formatPercent } from "../theme";
import { AiAssistantCard, PipelineCard, SentimentCard, StageMovesCard, WorkflowCard } from "./CrmCards";
import type { ViewProps } from "./types";

/**
 * Overview, CRM first: conversation KPIs, replies by sentiment, what needs
 * attention right now, the pipeline and stage moves, the AI assistant and
 * workflow. Then, smaller, the outreach that fed it: a channel table, the
 * period funnel from first contact to customer, and where leads came from.
 * Contacted, replies, the reply rate, sends, lead sources and the "now"
 * counts are the shared definitions Overview (/assistant/results) shows too.
 */

const HINTS = {
  contacted: METRICS.peopleContacted.definition,
  replies: METRICS.replies.definition,
  replyRate: METRICS.replyRate.definition,
  positive: "Distinct CRM records moved into Interested or Customer at any point in this period, by the AI or by a person, even if they were moved again later. Pipeline's Interested filter shows who is Interested now; Overview's Interested counts replies the AI classified Interested.",
  meetings: "Distinct CRM records moved into a meeting or demo subcategory in this period. No-shows are not counted.",
  customers: "Distinct CRM records moved into Customer in this period.",
  response: "Median time from a lead's message to your next reply in that conversation.",
};

const isAnalyticsChannel = (channel: string): channel is AnalyticsChannel => (ANALYTICS_CHANNELS as readonly string[]).includes(channel);

export function OverviewView({ data, loading, onSelectView }: ViewProps<"overview">) {
  const { kpis, range, crm } = data;
  const vsPrevious = (m: { previous: number | null }) => (m.previous === null ? undefined : `vs ${formatCompact(m.previous)} previous period`);
  const replySpark = crm.repliesByCategory.points.map((p) => crm.repliesByCategory.keys.reduce((sum, k) => sum + p[k], 0));
  const response = crm.kpis.medianFirstResponseMinutes;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
      <KpiStrip className="lg:col-span-12" columns={7} compact>
        <KpiCell icon={RiUserFollowLine} label="Contacted" value={formatCompact(kpis.contacted.value)} metric={kpis.contacted} hint={HINTS.contacted} context={`${formatCompact(kpis.sent.value)} sent, accepted by the provider`} />
        <KpiCell icon={RiReplyLine} label="Replies" value={formatCompact(crm.kpis.replies.value)} metric={crm.kpis.replies} hint={HINTS.replies} context={`from ${formatCompact(kpis.replied.value)} ${kpis.replied.value === 1 ? "person" : "people"}`} spark={replySpark} />
        <KpiCell icon={RiPercentLine} label="Reply rate" value={formatPercent(kpis.replyRate.value)} metric={kpis.replyRate} hint={HINTS.replyRate} context={`${formatCompact(kpis.contactedWhoReplied.value)} of ${formatCompact(kpis.contacted.value)} contacted replied`} />
        <KpiCell icon={RiThumbUpLine} label="Positive in period" value={formatCompact(kpis.positive.value)} metric={kpis.positive} hint={HINTS.positive} context={kpis.replied.value > 0 ? `${formatPercent(kpis.positive.value / kpis.replied.value)} of people who replied` : vsPrevious(kpis.positive)} />
        <KpiCell icon={RiCalendarEventLine} label="Meetings" value={formatCompact(kpis.meetings.value)} metric={kpis.meetings} hint={HINTS.meetings} context={vsPrevious(kpis.meetings)} />
        <KpiCell icon={RiTrophyLine} label="Customers" value={formatCompact(kpis.customers.value)} metric={kpis.customers} hint={HINTS.customers} context={vsPrevious(kpis.customers)} />
        <KpiCell icon={RiTimerLine} label="Median first response" value={formatMinutes(response.value)} metric={response} upIsGood={false} hint={HINTS.response} context={response.previous === null ? undefined : `vs ${formatMinutes(response.previous)} previous period`} />
      </KpiStrip>

      <SentimentCard className="lg:col-span-8" series={crm.repliesByCategory} bucket={range.bucket} loading={loading} />
      <AttentionCard attention={data.attention} loading={loading} />

      <details className="border-y border-stroke-soft-200 py-4 lg:col-span-12">
        <summary className="cursor-pointer text-label-sm text-text-strong-950">CRM details &amp; assistant activity</summary>
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-12">
      <PipelineCard className="lg:col-span-6 lg:self-start" value={crm.pipeline} loading={loading} />
      {/* Pipeline runs long; the two shorter cards stack beside it. */}
      <div className="flex flex-col gap-4 lg:col-span-6 lg:gap-5">
        <StageMovesCard value={crm.stageEntries} loading={loading} />
        <WorkflowCard value={crm.workflow} loading={loading} />
      </div>

      <AiAssistantCard className="lg:col-span-12" crm={crm} loading={loading} />
        </div>
      </details>

      <SectionHeading className="mt-2 lg:col-span-12" title="Outreach" description="Where these conversations came from. Open a channel for its detail." />
      <ChannelTable data={data} loading={loading} onSelectView={onSelectView} />
      <ChartCard className="lg:col-span-4" title="Conversion funnel" description="From first contact to customer." loading={loading} footer="Counts for this period — not one cohort followed through.">
        <FunnelChart stages={data.funnel} />
      </ChartCard>

      <Frame className="lg:col-span-12">
        <FrameHeader title="Where leads came from" description="Qualified and contactable people per source and provider, in this period. Each person counts once in the total." />
        <FramePanel className={cn("transition-opacity", loading && "opacity-60")}>
          <LeadSourcesTable sources={data.sources} empty="No leads were found or imported in this period." />
        </FramePanel>
      </Frame>

      <details className="border-y border-stroke-soft-200 py-4 lg:col-span-12">
        <summary className="cursor-pointer text-label-sm text-text-strong-950">How these figures are counted</summary>
        <p className="mb-3 mt-3 text-paragraph-xs text-text-soft-400">
          The same definitions as Overview, for whole local days in {range.tz}{range.tzSource === "override" ? " (an override of the business time zone)" : ""}. A send counts once its provider accepted it; queued, failed and uncertain sends never do.
        </p>
        <MetricDefinitions keys={SHARED_METRIC_KEYS} />
      </details>
    </div>
  );
}

function ChannelTable({ data, loading, onSelectView }: { data: OverviewAnalytics; loading: boolean; onSelectView?: (view: AnalyticsView) => void }) {
  const maxRate = Math.max(...data.channels.map((c) => c.replyRate ?? 0), 0.0001);
  return (
    <Frame className="lg:col-span-8">
      <FrameHeader title="Channels" description="Outreach per channel in this period: people contacted, and of them, who replied on that channel. Select a row to open it." />
      <FramePanel className={cn("p-2 transition-opacity sm:p-3", loading && "opacity-60")}>
      <Table.Root>
        <Table.Caption className="sr-only">Channel comparison</Table.Caption>
        <Table.Header>
          <Table.Row>
            <Table.Head scope="col">Channel</Table.Head>
            <Table.Head scope="col" className="text-right">Sent</Table.Head>
            <Table.Head scope="col" className="text-right">Contacted</Table.Head>
            <Table.Head scope="col" className="text-right">Replied</Table.Head>
            <Table.Head scope="col">Reply rate</Table.Head>
            <Table.Head scope="col" className="text-right">Positive</Table.Head>
            <Table.Head scope="col" className="w-8"><span className="sr-only">Open</span></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body spacing={4}>
          {data.channels.map((row) => {
            const meta = CONVERSATION_CHANNEL_META[row.channel];
            const Icon = meta.icon;
            const view = isAnalyticsChannel(row.channel) ? row.channel : null;
            return (
              <Table.Row key={row.channel} className={cn(view && "cursor-pointer")} onClick={view ? () => onSelectView?.(view) : undefined}>
                <Table.Cell className="h-12">
                  {view ? (
                    <button type="button" onClick={(e) => { e.stopPropagation(); onSelectView?.(view); }} className="flex items-center gap-2.5 rounded-md text-label-sm text-text-strong-950 outline-none focus-visible:ring-2 focus-visible:ring-primary-base">
                      <span className="flex size-6 items-center justify-center rounded-md" style={{ backgroundColor: meta.color }}>
                        <Icon className="size-4 text-white" />
                      </span>
                      {meta.label}
                    </button>
                  ) : (
                    <span className="flex items-center gap-2.5 text-label-sm text-text-strong-950">
                      <span className="flex size-6 items-center justify-center rounded-md" style={{ backgroundColor: meta.color }}>
                        <Icon className="size-4 text-white" />
                      </span>
                      {meta.label}
                    </span>
                  )}
                </Table.Cell>
                <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(row.sent)}</Table.Cell>
                <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(row.contacted)}</Table.Cell>
                <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(row.replied)}</Table.Cell>
                <Table.Cell className="h-12">
                  <div className="flex items-center gap-3">
                    <span className="w-12 text-paragraph-sm tabular-nums text-text-strong-950">{formatPercent(row.replyRate)}</span>
                    <span aria-hidden="true" className="h-1.5 w-24 rounded-full bg-bg-weak-50">
                      <span className="block h-full rounded-full" style={{ width: `${((row.replyRate ?? 0) / maxRate) * 100}%`, backgroundColor: meta.color }} />
                    </span>
                  </div>
                </Table.Cell>
                <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(row.positive)}</Table.Cell>
                <Table.Cell className="h-12 w-8 text-text-soft-400">{view && <RiArrowRightSLine className="size-4" aria-hidden="true" />}</Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
      </FramePanel>
    </Frame>
  );
}

type AttentionKey = "needsYou" | "actionRequired" | "overdue" | "draftsAwaitingReview" | "plansAwaitingStart" | "mailboxesFailing" | "linkedinDisconnected" | "whatsappDisconnected";
type AttentionItem = { key: AttentionKey; label: string; hint: string; href: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; tone: ProgressTone };

const ATTENTION: AttentionItem[] = [
  { key: "needsYou", label: METRICS.needsYouNow.label, hint: "Open decisions waiting for you", href: "/inbox?view=needs_you", icon: RiFlagLine, tone: "serious" },
  { key: "actionRequired", label: METRICS.actionRequiredNow.label, hint: "Conversations in the queue", href: "/inbox?view=needs_you", icon: RiInboxLine, tone: "serious" },
  { key: "overdue", label: METRICS.followUpsDueNow.label, hint: "Follow-ups drafted or past their time", href: "/inbox?view=needs_you&group=follow_up", icon: RiAlarmWarningLine, tone: "critical" },
  { key: "draftsAwaitingReview", label: METRICS.draftsAwaitingReviewNow.label, hint: "AI replies waiting for approval", href: "/inbox?view=needs_you", icon: RiDraftLine, tone: "warning" },
  { key: "plansAwaitingStart", label: METRICS.plansAwaitingStartNow.label, hint: "Nothing is sent until you start them", href: "/assistant", icon: RiSendPlaneLine, tone: "warning" },
  { key: "mailboxesFailing", label: "Failing mailboxes", hint: "Email accounts that can't send", href: "/settings/email-accounts", icon: RiMailForbidLine, tone: "critical" },
  { key: "linkedinDisconnected", label: "LinkedIn disconnected", hint: "Accounts that need reconnecting", href: "/settings/linkedin-accounts", icon: RiLinkedinBoxLine, tone: "critical" },
  { key: "whatsappDisconnected", label: "WhatsApp disconnected", hint: "Numbers that need relinking", href: "/settings/whatsapp-accounts", icon: RiWhatsappLine, tone: "critical" },
];

function AttentionCard({ attention, loading }: { attention: OverviewAnalytics["attention"]; loading: boolean }) {
  const anyOpen = ATTENTION.some((item) => attention[item.key] > 0);
  return (
    <Frame className="lg:col-span-4">
      <FrameHeader title="Needs attention now" description="Current counts, not limited to the date range. Overview shows the same." />
      <FramePanel className={cn("transition-opacity", loading && "opacity-60")}>
        {anyOpen ? (
          <ProgressList
            items={ATTENTION.map((item) => ({
              key: item.key,
              label: item.label,
              value: attention[item.key],
              subline: item.hint,
              tone: attention[item.key] > 0 ? item.tone : "neutral",
              icon: attention[item.key] > 0 ? item.icon : undefined,
              href: item.href,
            }))}
          />
        ) : (
          <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
            <RiCheckboxCircleLine className="size-6 text-success-base" aria-hidden="true" />
            <p className="mt-2 text-label-sm text-text-strong-950">All clear</p>
            <p className="mt-0.5 text-paragraph-xs text-text-sub-600">No replies waiting, no failing accounts.</p>
          </div>
        )}
      </FramePanel>
    </Frame>
  );
}
