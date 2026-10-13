"use client";

import Link from "next/link";
import { RiArrowRightSLine, RiChat3Line, RiChatNewLine, RiCheckLine, RiErrorWarningLine, RiLoader4Line, RiPhoneLine, RiPhoneFill, RiQuestionLine, RiTimeLine, RiUserReceived2Line, RiWhatsappLine, RiMessage2Line, RiPercentLine, RiVoiceprintLine } from "@remixicon/react";
import * as Table from "@/components/alignui/table";
import type { WhatsappAnalytics, WhatsappCallOutcome } from "@/lib/analytics/contract";
import { cn } from "@/utils/cn";
import { CapacityMeter } from "../kit/CapacityMeter";
import { ChartCard } from "../kit/ChartCard";
import { DonutChart } from "../kit/DonutChart";
import { Frame, FrameFooterLink, FrameHeader, FramePanel } from "../kit/Frame";
import { KpiCell, KpiStrip } from "../kit/KpiStrip";
import { SectionHeading } from "../kit/SectionHeading";
import { SeriesStats } from "../kit/SeriesStats";
import { Sparkline } from "../kit/Sparkline";
import { StatusDotBadge } from "../kit/StatusDotBadge";
import { seriesTotal, TimeSeriesChart, TimeSeriesTable, type SeriesKeys } from "../kit/TimeSeriesChart";
import { CHANNEL_META, formatCompact, formatDuration, formatPercent, MUTED, STATUS } from "../theme";
import type { ViewProps } from "./types";
import { BRAND } from "@/lib/brand";

/**
 * WhatsApp: two areas. Calls (KPI strip, calls chart, outcomes, campaigns) and
 * Messages (KPI strip, sent vs received, numbers).
 *
 * Colours: Connected / Sent use the WhatsApp channel colour. Received is
 * violet (categorical slot 7), not a channel colour. Call outcomes other than
 * connected are states, so they wear status colours and always carry an icon
 * and a label.
 */

const WA = CHANNEL_META.whatsapp.color;
const RECEIVED = "#7d52f4";

const CALL_KEYS: SeriesKeys<"connected" | "notConnected"> = {
  connected: { label: "Connected", color: WA },
  notConnected: { label: "Not connected", color: MUTED },
};
const MESSAGE_KEYS: SeriesKeys<"sent" | "received"> = {
  sent: { label: "Sent", color: WA },
  received: { label: "Received", color: RECEIVED },
};

type Icon = React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
const OUTCOMES: Record<WhatsappCallOutcome, { label: string; color: string; icon: Icon }> = {
  connected: { label: "Connected", color: WA, icon: RiCheckLine },
  didNotPickUp: { label: "Did not pick up", color: MUTED, icon: RiPhoneLine },
  notOnWhatsApp: { label: "Not on WhatsApp", color: STATUS.warning, icon: RiQuestionLine },
  failed: { label: "Failed", color: STATUS.critical, icon: RiErrorWarningLine },
  inProgress: { label: "In progress", color: "var(--chart-muted-strong)", icon: RiLoader4Line },
};

const HINTS = {
  calls: `WhatsApp calls placed from ${BRAND.shortName} in this period, whatever the outcome.`,
  connected: "Calls the lead picked up.",
  connectRate: "Connected calls divided by calls placed.",
  talk: "Total time on connected calls.",
  avg: "Talk time divided by connected calls.",
  sent: `Outbound messages: sent by ${BRAND.shortName}, or typed on the phone or in WhatsApp Web.`,
  received: "Inbound messages from leads.",
  replyRate: "Of chats where you sent a message in this period, the share that got a later reply from the lead.",
  newChats: `Chats ${BRAND.shortName} started in this period (the first message was sent from ${BRAND.shortName}).`,
};

const vsPrevious = (m: { previous: number | null }, format: (n: number) => string = formatCompact) => (m.previous === null ? undefined : `vs ${format(m.previous)} previous period`);

export function WhatsappView({ data, loading }: ViewProps<"whatsapp">) {
  const { kpis, range } = data;
  const unit = range.bucket === "week" ? "week" : "day";
  const placedSpark = data.calls.points.map((p) => p.connected + p.notConnected);
  const connectedSpark = data.calls.points.map((p) => p.connected);
  const totalCalls = kpis.calls.value;
  const nullable = (m: { value: number | null; previous: number | null }) => ({ value: m.value, previous: m.previous });

  const callStats = [
    { label: "Connected", color: WA, value: formatCompact(seriesTotal(data.calls, "connected")), metric: kpis.connected },
    { label: "Not connected", color: MUTED, value: formatCompact(seriesTotal(data.calls, "notConnected")) },
  ];
  const messageStats = [
    { label: "Sent", color: WA, value: formatCompact(kpis.messagesSent.value), metric: kpis.messagesSent },
    { label: "Received", color: RECEIVED, value: formatCompact(kpis.messagesReceived.value), metric: kpis.messagesReceived },
  ];


  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
      <SectionHeading title="Calls" description={`Voice calls placed from ${BRAND.shortName} and recorded in WhatsApp Web.`} />
      <KpiStrip className="lg:col-span-12" columns={5}>
        <KpiCell icon={RiPhoneLine} label="Calls placed" value={formatCompact(kpis.calls.value)} metric={kpis.calls} hint={HINTS.calls} context={vsPrevious(kpis.calls)} spark={placedSpark} />
        <KpiCell icon={RiPhoneFill} label="Connected" value={formatCompact(kpis.connected.value)} metric={kpis.connected} hint={HINTS.connected} context={vsPrevious(kpis.connected)} spark={connectedSpark} />
        <KpiCell icon={RiPercentLine} label="Connect rate" value={formatPercent(kpis.connectRate.value)} metric={nullable(kpis.connectRate)} hint={HINTS.connectRate} context={`of ${formatCompact(totalCalls)} calls`} />
        <KpiCell icon={RiTimeLine} label="Talk time" value={formatDuration(kpis.talkTimeMs.value)} metric={kpis.talkTimeMs} hint={HINTS.talk} context={vsPrevious(kpis.talkTimeMs, formatDuration)} />
        <KpiCell icon={RiVoiceprintLine} label="Avg call" value={formatDuration(kpis.avgCallMs.value)} metric={nullable(kpis.avgCallMs)} hint={HINTS.avg} context="per connected call" />
      </KpiStrip>

      <ChartCard
        className="lg:col-span-8"
        title="Calls"
        description={`Calls placed each ${unit}, connected or not.`}
        legend={<SeriesStats items={callStats} />}
        loading={loading}
        footer="Calls aren't attributed to a rep or number yet."
        table={<TimeSeriesTable series={data.calls} keys={CALL_KEYS} bucket={range.bucket} caption="Calls by outcome" />}
      >
        <TimeSeriesChart series={data.calls} keys={CALL_KEYS} type="stackedBar" bucket={range.bucket} />
      </ChartCard>

      <Frame className="lg:col-span-4 lg:self-start" aria-busy={loading || undefined}>
        <FrameHeader title="Call outcomes" description="How each call ended, in this period." />
        <FramePanel className={cn("transition-opacity", loading && "opacity-60")}>
          <DonutChart items={data.outcomes.map((o) => ({ key: o.key, label: OUTCOMES[o.key].label, value: o.value, color: OUTCOMES[o.key].color, icon: OUTCOMES[o.key].icon }))} centerLabel="calls" emptyLabel="No calls in this period" />
        </FramePanel>
      </Frame>

      <CampaignsTable campaigns={data.campaigns} loading={loading} />

      <SectionHeading title="Messages" description="Text chats on linked numbers, by direction." />
      <KpiStrip className="lg:col-span-12" columns={4}>
        <KpiCell icon={RiMessage2Line} label="Messages sent" value={formatCompact(kpis.messagesSent.value)} metric={kpis.messagesSent} hint={HINTS.sent} context={vsPrevious(kpis.messagesSent)} spark={data.messages.points.map((p) => p.sent)} />
        <KpiCell icon={RiUserReceived2Line} label="Messages received" value={formatCompact(kpis.messagesReceived.value)} metric={kpis.messagesReceived} hint={HINTS.received} context={vsPrevious(kpis.messagesReceived)} spark={data.messages.points.map((p) => p.received)} />
        <KpiCell icon={RiChat3Line} label="Chat reply rate" value={formatPercent(kpis.chatReplyRate.value)} metric={nullable(kpis.chatReplyRate)} hint={HINTS.replyRate} context="of chats you wrote in" />
        <KpiCell icon={RiChatNewLine} label="New chats" value={formatCompact(kpis.newChats.value)} metric={kpis.newChats} hint={HINTS.newChats} context={vsPrevious(kpis.newChats)} />
      </KpiStrip>

      <ChartCard
        className="lg:col-span-8"
        title="Messages"
        description={`Messages each ${unit}, sent and received.`}
        legend={<SeriesStats items={messageStats} />}
        loading={loading}
        table={<TimeSeriesTable series={data.messages} keys={MESSAGE_KEYS} bucket={range.bucket} caption="Messages sent and received" />}
      >
        <TimeSeriesChart series={data.messages} keys={MESSAGE_KEYS} type="line" bucket={range.bucket} />
      </ChartCard>

      <NumbersFrame accounts={data.accounts} tz={range.tz} loading={loading} />
    </div>
  );
}

function CampaignsTable({ campaigns, loading }: { campaigns: WhatsappAnalytics["campaigns"]; loading: boolean }) {
  const maxRate = Math.max(...campaigns.map((c) => c.connectRate ?? 0), 0.0001);
  return (
    <Frame className="lg:col-span-12" aria-busy={loading || undefined}>
      <FrameHeader title="Call campaigns" description="Calls in this period per campaign. Due today is a live count." />
      <FramePanel className={cn("p-2 transition-opacity sm:p-3", loading && "opacity-60")}>
        {campaigns.length === 0 ? (
          <p className="px-4 py-8 text-center text-paragraph-sm text-text-sub-600">No call campaigns yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table.Root>
              <Table.Caption className="sr-only">Call campaigns</Table.Caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head scope="col">Campaign</Table.Head>
                  <Table.Head scope="col" className="text-right">Leads</Table.Head>
                  <Table.Head scope="col" className="text-right">Calls</Table.Head>
                  <Table.Head scope="col"><span className="sr-only">Trend</span></Table.Head>
                  <Table.Head scope="col" className="text-right">Connected</Table.Head>
                  <Table.Head scope="col">Connect rate</Table.Head>
                  <Table.Head scope="col" className="text-right">Due today</Table.Head>
                  <Table.Head scope="col" className="w-8"><span className="sr-only">Open</span></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body spacing={4}>
                {campaigns.map((c) => (
                  <Table.Row key={c.id}>
                    <Table.Cell className="h-12">
                      <Link href={`/calling/campaigns/${c.id}`} className="block max-w-64 truncate rounded-md text-label-sm text-text-strong-950 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary-base">{c.name}</Link>
                    </Table.Cell>
                    <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(c.leads)}</Table.Cell>
                    <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(c.calls)}</Table.Cell>
                    <Table.Cell className="h-12">
                      <Sparkline data={c.trend} color={WA} className="h-7 w-20" height={28} />
                    </Table.Cell>
                    <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(c.connected)}</Table.Cell>
                    <Table.Cell className="h-12">
                      <div className="flex items-center gap-3">
                        <span className="w-12 text-paragraph-sm tabular-nums text-text-strong-950">{formatPercent(c.connectRate)}</span>
                        <span aria-hidden="true" className="h-1.5 w-24 rounded-full bg-bg-weak-50">
                          <span className="block h-full rounded-full" style={{ width: `${((c.connectRate ?? 0) / maxRate) * 100}%`, backgroundColor: WA }} />
                        </span>
                      </div>
                    </Table.Cell>
                    <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(c.dueToday)}</Table.Cell>
                    <Table.Cell className="h-12 w-8 text-text-soft-400"><RiArrowRightSLine className="size-4" aria-hidden="true" /></Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </div>
        )}
      </FramePanel>
    </Frame>
  );
}

function warmUpLabel(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
  }
}

function NumbersFrame({ accounts, tz, loading }: { accounts: WhatsappAnalytics["accounts"]; tz: string; loading: boolean }) {
  return (
    <Frame className="lg:col-span-4 lg:self-start" aria-busy={loading || undefined}>
      <FrameHeader title="Numbers" description="Linked WhatsApp numbers, right now." />
      <FramePanel className={cn("transition-opacity", loading && "opacity-60")}>
        {accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-8 text-center">
            <RiWhatsappLine className="size-6 text-text-soft-400" aria-hidden="true" />
            <p className="mt-2 text-label-sm text-text-strong-950">No numbers linked</p>
            <p className="mt-0.5 text-paragraph-xs text-text-sub-600">Link one in Unipile, then sync it.</p>
          </div>
        ) : (
          <ul className="divide-y divide-stroke-soft-200">
            {accounts.map((a) => {
              const connected = a.status === "connected";
              return (
                <li key={a.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-label-sm text-text-strong-950">{a.name}</p>
                      {a.phone && a.phone.replace(/\D/g, "") !== a.name.replace(/\D/g, "") && <p className="truncate text-paragraph-xs text-text-sub-600">{a.phone}</p>}
                    </div>
                    <StatusDotBadge status={connected ? "good" : "critical"}>{connected ? "Connected" : a.status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}</StatusDotBadge>
                  </div>
                  <CapacityMeter label="New chats, last 24 h" used={a.newChats24h} limit={a.newChatLimit} segments={12} />
                  {a.warmingUpUntil && (
                    <p className="flex items-center gap-1.5 text-paragraph-xs text-text-sub-600">
                      <RiTimeLine className="size-3.5 shrink-0" aria-hidden="true" style={{ color: STATUS.warning }} />
                      Warming up until {warmUpLabel(a.warmingUpUntil, tz)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </FramePanel>
      <FrameFooterLink href="/settings/whatsapp-accounts">Manage numbers</FrameFooterLink>
    </Frame>
  );
}
