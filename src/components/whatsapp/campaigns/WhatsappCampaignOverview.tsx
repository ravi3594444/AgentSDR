"use client";

import {
  RiCheckboxCircleLine,
  RiChat1Line,
  RiErrorWarningLine,
  RiLoader4Line,
  RiMailSendLine,
  RiReplyLine,
  RiSendPlaneLine,
  RiStopCircleLine,
  RiTeamLine,
  RiTimeLine,
} from "@remixicon/react";
import { BarList, type BarListItem } from "@/components/analytics/kit/BarList";
import { DonutChart, type DonutItem } from "@/components/analytics/kit/DonutChart";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { FunnelChart } from "@/components/analytics/kit/FunnelChart";
import { KpiCell, KpiStrip } from "@/components/analytics/kit/KpiStrip";
import { CHANNEL_META, formatCompact, formatPercent, HUE, MUTED, STATUS } from "@/components/analytics/theme";
import type { WhatsappCampaignDetail } from "@/lib/whatsapp/campaigns/contract";
import { leadsProgressText, type CampaignFunnel } from "./metrics";

/**
 * A message campaign's Overview: headline numbers, the leads -> messaged ->
 * replied funnel, where every lead stands now (a donut: the states are
 * exclusive and sum to the leads) and how many messages each step has sent.
 * Messages wear the WhatsApp channel green, as on Analytics.
 */
const WHATSAPP = CHANNEL_META.whatsapp.color;

function pct(part: number, whole: number): string | undefined {
  return whole > 0 ? formatPercent(part / whole) : undefined;
}

export function WhatsappCampaignOverview({ funnel: f, campaign }: { funnel: CampaignFunnel; campaign: WhatsappCampaignDetail }) {
  const leadStates: DonutItem[] = [
    { key: "queued", label: "Queued", value: f.queued, color: MUTED, icon: RiTimeLine },
    { key: "in_sequence", label: "In sequence", value: f.inSequence, color: HUE.amber, icon: RiLoader4Line },
    { key: "completed", label: "Completed, no reply", value: f.completed, color: HUE.teal, icon: RiCheckboxCircleLine },
    { key: "replied", label: "Replied", value: f.replied, color: WHATSAPP, icon: RiReplyLine },
    { key: "stopped", label: "Stopped", value: f.stopped, color: HUE.orange, icon: RiStopCircleLine },
    { key: "failed", label: "Failed", value: f.failed, color: STATUS.critical, icon: RiErrorWarningLine },
  ];

  const perStep: BarListItem[] = campaign.steps.map((step, i) => ({
    key: step.id,
    label: i === 0 ? "First message" : `Follow-up ${i}`,
    value: campaign.sentByStep[step.id] ?? 0,
    color: WHATSAPP,
  }));
  const anySent = perStep.some((item) => item.value > 0);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
      <KpiStrip className="lg:col-span-12" columns={5}>
        <KpiCell icon={RiTeamLine} label="Leads" value={formatCompact(f.total)} context={leadsProgressText(f)} />
        <KpiCell icon={RiSendPlaneLine} label="Messaged" value={formatCompact(f.messaged)} context={pct(f.messaged, f.total) ? `${pct(f.messaged, f.total)} of leads` : undefined} hint="Leads sent at least one message (accepted by WhatsApp), or who replied. A lead stopped or failed later still counts; one that failed before its first message does not." />
        <KpiCell icon={RiChat1Line} label="Replied" value={formatCompact(f.replied)} context={f.replyRate !== null ? `${formatPercent(f.replyRate)} of messaged` : undefined} hint="Leads who replied on any channel. A reply stops the sequence." />
        <KpiCell icon={RiMailSendLine} label="Messages sent" value={formatCompact(f.messagesSent)} context={`${campaign.stepCount} ${campaign.stepCount === 1 ? "message" : "messages"} in the sequence`} hint="Every message delivered to WhatsApp, first messages and follow-ups." />
        <KpiCell icon={RiErrorWarningLine} label="Failed" value={formatCompact(f.failed)} context={f.stopped > 0 ? `${formatCompact(f.stopped)} stopped` : f.failed > 0 ? "WhatsApp refused the number or message" : "None"} hint="Leads WhatsApp could not deliver to. The Leads tab shows the reason for each." />
      </KpiStrip>

      <Frame className="self-start lg:col-span-5">
        <FrameHeader title="Funnel" description="Leads, messaged, replied." />
        <FramePanel>
          <FunnelChart
            stages={[
              { key: "leads", label: "Leads", value: f.total },
              { key: "messaged", label: "Messaged", value: f.messaged },
              { key: "replied", label: "Replied", value: f.replied },
            ]}
          />
        </FramePanel>
        <FrameFooter>Every lead in this campaign, by how far it has got. All time.</FrameFooter>
      </Frame>

      <Frame className="lg:col-span-7">
        <FrameHeader title="Where leads stand" description="Every lead in the campaign, by where it is now." />
        <FramePanel>
          <DonutChart items={leadStates} centerLabel="leads" emptyLabel="No leads yet" emptyDescription="Add leads to see where they stand." />
        </FramePanel>
      </Frame>

      <Frame className="lg:col-span-12">
        <FrameHeader title="Messages by step" description="How many times each message in the sequence has been sent." />
        <FramePanel>
          <BarList items={anySent ? perStep : []} emptyLabel="No messages sent yet." />
        </FramePanel>
      </Frame>
    </div>
  );
}
