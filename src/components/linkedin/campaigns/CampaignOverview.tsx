"use client";

import {
  RiChat1Line,
  RiCheckboxCircleLine,
  RiCheckDoubleLine,
  RiErrorWarningLine,
  RiLoader4Line,
  RiReplyLine,
  RiSendPlaneLine,
  RiTeamLine,
  RiTimeLine,
} from "@remixicon/react";
import { BarList, type BarListItem } from "@/components/analytics/kit/BarList";
import { ChartCard } from "@/components/analytics/kit/ChartCard";
import { DonutChart, type DonutItem } from "@/components/analytics/kit/DonutChart";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { FunnelChart } from "@/components/analytics/kit/FunnelChart";
import { KpiCell, KpiStrip } from "@/components/analytics/kit/KpiStrip";
import { SeriesStats } from "@/components/analytics/kit/SeriesStats";
import { seriesTotal, TimeSeriesChart, TimeSeriesTable, type SeriesKeys } from "@/components/analytics/kit/TimeSeriesChart";
import { Skeleton } from "@/components/page/Skeletons";
import { CHANNEL_META, formatCompact, formatPercent, MUTED, STATUS } from "@/components/analytics/theme";
import { leadsProgressText, type CampaignFunnel } from "./metrics";

/**
 * A LinkedIn campaign's Overview: headline numbers, the invited → accepted →
 * replied funnel, the last 7 days of invitations and accepts (grouped bars —
 * seven discrete daily counts), where every
 * lead stands now (a donut — the states are exclusive and sum to the leads),
 * and how far accepted leads have got through the follow-ups.
 *
 * Colours follow the Analytics LinkedIn view: invites wear the channel blue,
 * accepts violet. Lead states reuse the send-campaign donut's slots so the
 * two campaign pages read alike.
 */

const LINKEDIN = CHANNEL_META.linkedin.color;

export type ChartDay = { date: string; invitations: number; accepted: number };

type ActivityKey = "invites" | "accepted";
const ACTIVITY_KEYS: SeriesKeys<ActivityKey> = {
  invites: { label: "Invitations sent", color: LINKEDIN },
  accepted: { label: "Accepted", color: "#7d52f4" },
};

/**
 * The chart-data route labels its seven days "Sep 24" (today last); the kit
 * wants YYYY-MM-DD. The days are consecutive and end today, so the position
 * gives the date without parsing the label.
 */
function toSeries(days: ChartDay[]) {
  const today = new Date();
  const points = days.map((day, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days.length - 1 - i));
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { date: iso, invites: day.invitations, accepted: day.accepted };
  });
  return { keys: ["invites", "accepted"] as const, points };
}

function pct(part: number, whole: number): string | undefined {
  return whole > 0 ? formatPercent(part / whole) : undefined;
}

export function CampaignOverview({
  funnel: f,
  statusCounts: s,
  chartData,
}: {
  funnel: CampaignFunnel;
  statusCounts: Record<string, number>;
  /** null while the 7-day activity is loading. */
  chartData: ChartDay[] | null;
}) {
  const series = toSeries(chartData ?? []);
  const activityStats = (Object.keys(ACTIVITY_KEYS) as ActivityKey[]).map((k) => ({
    label: ACTIVITY_KEYS[k].label,
    color: ACTIVITY_KEYS[k].color,
    value: chartData ? formatCompact(seriesTotal(series, k)) : "—",
  }));

  const leadStates: DonutItem[] = [
    { key: "queued", label: "Not invited yet", value: f.queued, color: MUTED, icon: RiTimeLine },
    { key: "awaiting", label: "Awaiting acceptance", value: f.awaiting, color: LINKEDIN, icon: RiSendPlaneLine },
    { key: "inSequence", label: "In sequence", value: f.inSequence, color: "#e5930a", icon: RiLoader4Line },
    { key: "completed", label: "Completed, no reply", value: f.completed, color: STATUS.good, icon: RiCheckboxCircleLine },
    { key: "replied", label: "Replied", value: f.replied, color: "#7d52f4", icon: RiReplyLine },
    { key: "failed", label: "Failed or cancelled", value: f.failed + f.cancelled, color: STATUS.critical, icon: RiErrorWarningLine },
  ];

  const n = (key: string) => s[key] ?? 0;
  const sequenceSteps: BarListItem[] = [
    { key: "CONNECTED", label: "Connected, message not sent yet", value: n("CONNECTED") },
    { key: "ACCEPT_MESSAGE_SENT", label: "Acceptance message sent", value: n("ACCEPT_MESSAGE_SENT") },
    { key: "FOLLOW_UP_1_SENT", label: "Follow-up 1 sent", value: n("FOLLOW_UP_1_SENT") },
    { key: "FOLLOW_UP_2_SENT", label: "Follow-up 2 sent", value: n("FOLLOW_UP_2_SENT") },
    { key: "FOLLOW_UP_3_SENT", label: "Follow-up 3 sent", value: n("FOLLOW_UP_3_SENT") },
    { key: "COMPLETED", label: "Sequence finished, no reply", value: n("COMPLETED") },
    { key: "REPLIED", label: "Replied", value: n("REPLIED") },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
      <KpiStrip className="lg:col-span-12" columns={5}>
        <KpiCell icon={RiTeamLine} label="Leads" value={formatCompact(f.total)} context={leadsProgressText(f)} />
        <KpiCell icon={RiSendPlaneLine} label="Invited" value={formatCompact(f.invited)} context={pct(f.invited, f.total) ? `${pct(f.invited, f.total)} of leads` : undefined} hint="Leads sent a connection request, whatever happened next, including those cancelled by a stop afterwards." />
        <KpiCell icon={RiCheckDoubleLine} label="Accepted" value={formatCompact(f.accepted)} context={f.acceptanceRate !== null ? `${formatPercent(f.acceptanceRate)} acceptance rate` : undefined} hint="Leads who accepted the connection request. Acceptance rate is accepted ÷ invited." />
        <KpiCell icon={RiChat1Line} label="Replied" value={formatCompact(f.replied)} context={f.replyRate !== null ? `${formatPercent(f.replyRate)} of accepted` : undefined} hint="Leads who replied. Reply rate is replied ÷ accepted, as on Analytics." />
        <KpiCell icon={RiErrorWarningLine} label="Failed" value={formatCompact(f.failed)} context={f.cancelled > 0 ? `${formatCompact(f.cancelled)} cancelled` : f.failed > 0 ? "Invitations that could not be sent" : "None"} hint="Leads whose invitation could not be sent after every retry." />
      </KpiStrip>

      <ChartCard
        className="lg:col-span-8"
        title="Activity"
        description="Invitations sent and connections accepted per day, last 7 days."
        loading={chartData === null}
        legend={<SeriesStats items={activityStats} />}
        table={<TimeSeriesTable series={series} keys={ACTIVITY_KEYS} bucket="day" caption="Invitations and accepts per day" />}
      >
        {chartData === null ? (
          <Skeleton className="h-[260px] w-full rounded-xl" />
        ) : (
          <TimeSeriesChart series={series} keys={ACTIVITY_KEYS} type="bar" bucket="day" />
        )}
      </ChartCard>

      <Frame className="self-start lg:col-span-4">
        <FrameHeader title="Funnel" description="Invited → accepted → replied." />
        <FramePanel>
          <FunnelChart
            stages={[
              { key: "invited", label: "Invited", value: f.invited },
              { key: "accepted", label: "Accepted", value: f.accepted },
              { key: "replied", label: "Replied", value: f.replied },
            ]}
          />
        </FramePanel>
        <FrameFooter>Every lead in this campaign, by how far it has got. All time.</FrameFooter>
      </Frame>

      <Frame className="lg:col-span-6">
        <FrameHeader title="Where leads stand" description="Every lead in the campaign, by where it is now." />
        <FramePanel>
          <DonutChart items={leadStates} centerLabel="leads" emptyLabel="No leads yet" emptyDescription="Add leads to see where they stand." />
        </FramePanel>
      </Frame>

      <Frame className="lg:col-span-6">
        <FrameHeader title="Sequence progress" description="Accepted leads, by the last step they were sent." />
        <FramePanel>
          <BarList items={f.accepted > 0 ? sequenceSteps : []} emptyLabel="No accepted connections yet." />
        </FramePanel>
      </Frame>
    </div>
  );
}
