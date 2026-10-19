"use client";

import Link from "next/link";
import { RiChat1Line, RiCheckDoubleLine, RiMailSendLine, RiPercentLine, RiSendPlaneLine, RiUserAddLine } from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Table from "@/components/alignui/table";
import type { LinkedinAnalytics } from "@/lib/analytics/contract";
import { cn } from "@/utils/cn";
import { ChartCard } from "../kit/ChartCard";
import { Frame, FrameFooterLink, FrameHeader, FramePanel } from "../kit/Frame";
import { FunnelChart, type FunnelStage } from "../kit/FunnelChart";
import { KpiCell, KpiStrip } from "../kit/KpiStrip";
import { RateCell } from "../kit/RateCell";
import { SeriesStats } from "../kit/SeriesStats";
import { Sparkline } from "../kit/Sparkline";
import { StatusDotBadge } from "../kit/StatusDotBadge";
import { TickMeter } from "../kit/TickMeter";
import { seriesTotal, TimeSeriesChart, TimeSeriesTable, type SeriesKeys } from "../kit/TimeSeriesChart";
import { ACCENT, CHANNEL_META, STATUS, formatCompact, formatPercent, MUTED } from "../theme";
import type { ViewProps } from "./types";

/**
 * LinkedIn: KPI strip, invites/accepts/replies lines beside the period funnel,
 * connected accounts beside daily invite capacity, and the campaigns table.
 */

const LINKEDIN = CHANNEL_META.linkedin.color;

// One channel, three series: LinkedIn blue, then violet and aqua — two blues
// side by side were too close to tell apart.
const ACTIVITY_KEYS: SeriesKeys<"invites" | "accepted" | "replied"> = {
  invites: { label: "Invites", color: LINKEDIN },
  accepted: { label: "Accepted", color: "#7d52f4" },
  replied: { label: "Replies", color: CHANNEL_META.whatsapp.color },
};

const HINTS = {
  invites: "Connection invitations LinkedIn accepted from the sender in this period. A claim LinkedIn never confirmed is not a send. Overview counts the same.",
  accepted: "Connections accepted in this period. Counted when the accept is recorded, which can be for an invite sent earlier.",
  acceptanceRate: "Accepted divided by invites sent, for the same period.",
  messages: "Outreach messages LinkedIn accepted: the acceptance message and follow-ups 1 to 3. Replies typed in the inbox are not outreach. Overview counts the same.",
  replied: "People sent a LinkedIn invitation or message in this period who replied on LinkedIn after their first send in it.",
  replyRate: "Replied divided by people contacted on LinkedIn, for the same period. Overview uses the same definition.",
};

const CAMPAIGN_STATUS = {
  ACTIVE: { tone: "good", label: "Active" },
  PAUSED: { tone: "warning", label: "Paused" },
} as const;

export function LinkedinView({ data, loading }: ViewProps<"linkedin">) {
  const { kpis, range } = data;
  const unit = range.bucket === "week" ? "week" : "day";
  const vsPrevious = (m: { previous: number | null }) => (m.previous === null ? undefined : `vs ${formatCompact(m.previous)} previous period`);
  const vsPreviousRate = (m: { previous: number | null }) => (m.previous === null ? undefined : `vs ${formatPercent(m.previous)} previous period`);
  const spark = (key: "invites" | "accepted" | "replied") => data.activity.points.map((p) => p[key]);
  // "Messaged" includes follow-ups to people accepted in earlier periods, so
  // it can exceed Accepted — it isn't a funnel step; its KPI covers it.
  const stages: FunnelStage[] = data.funnel.filter((stage) => stage.key !== "messaged");

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
      <KpiStrip className="lg:col-span-12" columns={6}>
        <KpiCell icon={RiSendPlaneLine} label="Invites sent" value={formatCompact(kpis.invites.value)} metric={kpis.invites} hint={HINTS.invites} context={vsPrevious(kpis.invites)} spark={spark("invites")} />
        <KpiCell icon={RiUserAddLine} label="Accepted" value={formatCompact(kpis.accepted.value)} metric={kpis.accepted} hint={HINTS.accepted} context={vsPrevious(kpis.accepted)} spark={spark("accepted")} />
        <KpiCell icon={RiCheckDoubleLine} label="Acceptance rate" value={formatPercent(kpis.acceptanceRate.value)} metric={kpis.acceptanceRate} hint={HINTS.acceptanceRate} context={vsPreviousRate(kpis.acceptanceRate)} />
        <KpiCell icon={RiMailSendLine} label="Messages sent" value={formatCompact(kpis.messages.value)} metric={kpis.messages} hint={HINTS.messages} context={vsPrevious(kpis.messages)} />
        <KpiCell icon={RiChat1Line} label="Replied" value={formatCompact(kpis.replied.value)} metric={kpis.replied} hint={HINTS.replied} context={`of ${formatCompact(kpis.contacted.value)} contacted`} spark={spark("replied")} />
        <KpiCell icon={RiPercentLine} label="Reply rate" value={formatPercent(kpis.replyRate.value)} metric={kpis.replyRate} hint={HINTS.replyRate} context={kpis.replyRate.previous === null ? "replied / contacted" : `replied / contacted, vs ${formatPercent(kpis.replyRate.previous)} before`} />
      </KpiStrip>

      <ChartCard
        className="lg:col-span-8"
        title="Invites, accepts and replies"
        description={`LinkedIn activity each ${unit}.`}
        legend={
          <SeriesStats
            items={(Object.keys(ACTIVITY_KEYS) as Array<keyof typeof ACTIVITY_KEYS>).map((k) => ({
              label: ACTIVITY_KEYS[k].label,
              color: ACTIVITY_KEYS[k].color,
              // Invites and accepts are the KPI totals; replies are inbound
              // messages, so their total is the series' own.
              value: formatCompact(k === "replied" ? seriesTotal(data.activity, "replied") : kpis[k].value),
            }))}
          />
        }
        loading={loading}
        table={<TimeSeriesTable series={data.activity} keys={ACTIVITY_KEYS} bucket={range.bucket} caption="LinkedIn invites, accepts and replies" />}
      >
        <TimeSeriesChart series={data.activity} keys={ACTIVITY_KEYS} type="line" bucket={range.bucket} />
      </ChartCard>

      <ChartCard className="self-start lg:col-span-4" title="LinkedIn funnel" description="Invited → accepted → replied." loading={loading} footer="Counts for this period, not one cohort followed through.">
        <FunnelChart stages={stages} />
      </ChartCard>

      <AccountsTable accounts={data.accounts} loading={loading} />
      <InviteCapacity accounts={data.accounts} loading={loading} />

      <CampaignsTable campaigns={data.campaigns} loading={loading} />
    </div>
  );
}

function AccountsTable({ accounts, loading }: { accounts: LinkedinAnalytics["accounts"]; loading: boolean }) {
  const rows = [...accounts].sort((a, b) => Number(a.status === "CONNECTED") - Number(b.status === "CONNECTED") || a.name.localeCompare(b.name));
  return (
    <Frame className="self-start lg:col-span-8">
      <FrameHeader title="Accounts" description="Right now, regardless of the date range. Disconnected accounts first." />
      <FramePanel className={cn("overflow-x-auto p-2 transition-opacity sm:p-3", loading && "opacity-60")}>
        {rows.length === 0 ? (
          <p className="py-10 text-center text-paragraph-sm text-text-sub-600">No LinkedIn accounts connected yet.</p>
        ) : (
          <Table.Root>
            <Table.Caption className="sr-only">LinkedIn accounts</Table.Caption>
            <Table.Header>
              <Table.Row>
                <Table.Head scope="col">Account</Table.Head>
                <Table.Head scope="col">Status</Table.Head>
                <Table.Head scope="col" className="min-w-44">Invites today</Table.Head>
                <Table.Head scope="col" className="text-right">Pending queue</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body spacing={4}>
              {rows.map((a) => {
                const connected = a.status === "CONNECTED";
                return (
                  <Table.Row key={a.id}>
                    <Table.Cell className="h-12">
                      <div className="flex items-center gap-2">
                        <span className="max-w-48 truncate text-label-sm text-text-strong-950">{a.name}</span>
                        {a.premium && <Badge.Root variant="lighter" color="purple" size="small">Premium</Badge.Root>}
                      </div>
                    </Table.Cell>
                    <Table.Cell className="h-12"><StatusDotBadge status={connected ? "good" : "critical"}>{connected ? "Connected" : "Disconnected"}</StatusDotBadge></Table.Cell>
                    <Table.Cell className="h-12">
                      {connected ? <InlineMeter used={a.sentToday} limit={a.dailyLimit} /> : <span className="text-paragraph-sm text-text-soft-400">Paused until reconnected</span>}
                    </Table.Cell>
                    <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(a.pending)}</Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        )}
      </FramePanel>
      <FrameFooterLink href="/settings/linkedin-accounts">Manage LinkedIn accounts</FrameFooterLink>
    </Frame>
  );
}

/** Compact one-line used/limit meter for a table cell; the at-limit state is written out, not colour alone. */
function InlineMeter({ used, limit }: { used: number; limit: number }) {
  const full = limit > 0 && used >= limit;
  const filled = limit > 0 ? Math.min(10, Math.round((used / limit) * 10)) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 text-paragraph-sm tabular-nums text-text-strong-950">
        {used} <span className="text-text-soft-400">/ {limit}</span>
      </span>
      <span role="meter" aria-label="Invites today" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} className="flex h-1.5 w-24 gap-0.5">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className="h-full flex-1 rounded-[2px]" style={{ backgroundColor: i < filled ? (full ? STATUS.critical : ACCENT) : "var(--color-bg-soft-200)" }} />
        ))}
      </span>
      {full && <span className="text-paragraph-xs text-text-sub-600">At limit</span>}
    </div>
  );
}

function InviteCapacity({ accounts, loading }: { accounts: LinkedinAnalytics["accounts"]; loading: boolean }) {
  const connected = accounts.filter((a) => a.status === "CONNECTED");
  const used = connected.reduce((sum, a) => sum + a.sentToday, 0);
  const limit = connected.reduce((sum, a) => sum + a.dailyLimit, 0);
  const atCap = connected.filter((a) => a.dailyLimit > 0 && a.sentToday >= a.dailyLimit).length;
  return (
    <Frame className="self-start lg:col-span-4">
      <FrameHeader title="Daily invite capacity" description="Connected accounts, today." />
      <FramePanel className={cn("transition-opacity", loading && "opacity-60")}>
        {connected.length === 0 ? (
          <p className="py-6 text-center text-paragraph-sm text-text-sub-600">No connected accounts to send from.</p>
        ) : (
          <>
            <TickMeter label="Invites sent today" used={used} limit={limit} caption={`${used.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} invites sent today`} />
            <p className="mt-4 text-paragraph-sm text-text-sub-600">
              {atCap} {atCap === 1 ? "account is" : "accounts are"} at {atCap === 1 ? "its" : "their"} daily cap
            </p>
          </>
        )}
      </FramePanel>
    </Frame>
  );
}

function CampaignsTable({ campaigns, loading }: { campaigns: LinkedinAnalytics["campaigns"]; loading: boolean }) {
  const maxAccept = Math.max(...campaigns.map((c) => c.acceptanceRate ?? 0), 0.0001);
  const maxReply = Math.max(...campaigns.map((c) => c.replyRate ?? 0), 0.0001);
  const num = "h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950";
  return (
    <Frame className="lg:col-span-12">
      <FrameHeader title="Campaigns" description="Invited is for this period; the other counts are per campaign. Reply rate is replied / accepted." />
      <FramePanel className={cn("overflow-x-auto p-2 transition-opacity sm:p-3", loading && "opacity-60")}>
        {campaigns.length === 0 ? (
          <p className="py-10 text-center text-paragraph-sm text-text-sub-600">No LinkedIn campaigns yet.</p>
        ) : (
          <Table.Root>
            <Table.Caption className="sr-only">LinkedIn campaigns</Table.Caption>
            <Table.Header>
              <Table.Row>
                <Table.Head scope="col">Campaign</Table.Head>
                <Table.Head scope="col" className="text-right">Leads</Table.Head>
                <Table.Head scope="col">Invited</Table.Head>
                <Table.Head scope="col" className="text-right">Accepted</Table.Head>
                <Table.Head scope="col">Acceptance rate</Table.Head>
                <Table.Head scope="col" className="text-right">Replied</Table.Head>
                <Table.Head scope="col">Reply rate</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body spacing={4}>
              {campaigns.map((c) => {
                const status = c.status === "ACTIVE" ? CAMPAIGN_STATUS.ACTIVE : c.status === "PAUSED" ? CAMPAIGN_STATUS.PAUSED : { tone: "neutral" as const, label: c.status };
                return (
                  <Table.Row key={c.id}>
                    <Table.Cell className="h-12">
                      <div className="flex min-w-0 items-center gap-3">
                        <Link href={`/linkedin/campaigns/${c.id}`} className="max-w-64 truncate rounded-md text-label-sm text-text-strong-950 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary-base">{c.name}</Link>
                        <StatusDotBadge status={status.tone}>{status.label}</StatusDotBadge>
                      </div>
                    </Table.Cell>
                    <Table.Cell className={num}>{formatCompact(c.leads)}</Table.Cell>
                    <Table.Cell className="h-12">
                      <div className="flex items-center gap-3">
                        <span className="w-10 text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(c.invited)}</span>
                        <Sparkline data={c.trend} color={MUTED} className="hidden w-16 sm:block" />
                      </div>
                    </Table.Cell>
                    <Table.Cell className={num}>{formatCompact(c.accepted)}</Table.Cell>
                    <Table.Cell className="h-12"><RateCell rate={c.acceptanceRate} max={maxAccept} color={LINKEDIN} /></Table.Cell>
                    <Table.Cell className={num}>{formatCompact(c.replied)}</Table.Cell>
                    <Table.Cell className="h-12"><RateCell rate={c.replyRate} max={maxReply} color={LINKEDIN} /></Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        )}
      </FramePanel>
    </Frame>
  );
}
