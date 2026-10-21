"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  RiBarChart2Line,
  RiListOrdered2,
  RiMailSendLine,
  RiPauseCircleLine,
  RiPlayCircleLine,
  RiStackLine,
  RiTeamLine,
  RiUserAddLine,
  RiTimeLine,
} from "@remixicon/react";

import * as Badge from "@/components/alignui/badge";
import { useDialogs } from "@/components/DialogProvider";
import * as Button from "@/components/alignui/button";
import { PageContainer, PageHeader } from "@/components/page/PageHeader";
import { PageTabs } from "@/components/page/PageTabs";
import { StatRow } from "@/components/page/StatRow";
import AnalyticsTab from "./AnalyticsTab";
import LeadsTab from "./LeadsTab";
import SequenceTab from "./SequenceTab";
import type { outreachCampaigns, mailboxes } from "@/lib/outreach/schema";
import type { LeadPage, DailySends, CampaignPulse } from "@/lib/outreach/campaigns";

type Campaign = typeof outreachCampaigns.$inferSelect;
type Mailbox = typeof mailboxes.$inferSelect;
type Stats = {
  totalLeads: number;
  pending: number;
  inSequence: number;
  replied: number;
  completed: number;
  bounced: number;
  suppressed: number;
  emailsSent: number;
  emailsScheduled: number;
  emailsFailed: number;
  emailsTotal: number;
  contacted: number;
};
type StepBreakdown = { stepNumber: number; sent: number }[];

const STATUS_COLOR: Record<string, React.ComponentProps<typeof Badge.Root>["color"]> = {
  active: "green",
  paused: "orange",
  draft: "gray",
  completed: "purple",
};
const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  draft: "Draft",
  completed: "Completed",
};

type TabId = "analytics" | "leads" | "sequence";

function createdAt(date: string | Date | null): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** "In 13m" / "In 2h" / "Overdue" — the countdown to the next queued send. */
function untilNext(date: Date | string | null): string {
  if (!date) return "Nothing queued";
  const d = typeof date === "string" ? new Date(date) : date;
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  if (mins <= 0) return "Due now";
  if (mins < 60) return `In ${mins}m`;
  if (mins < 60 * 24) return `In ${Math.round(mins / 60)}h`;
  return `In ${Math.round(mins / (60 * 24))}d`;
}

export default function CampaignDetailClient({
  campaign,
  stats,
  mailboxes,
  leadPage,
  stepBreakdown,
  dailySends,
  pulse,
}: {
  campaign: Campaign;
  stats: Stats;
  mailboxes: Mailbox[];
  leadPage: LeadPage;
  stepBreakdown: StepBreakdown;
  dailySends: DailySends;
  pulse: CampaignPulse;
}) {
  const router = useRouter();
  const dialogs = useDialogs();
  const [tab, setTab] = useState<TabId>("analytics");
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const connectedMailboxes = mailboxes.filter((m) => m.status === "connected");
  const canLaunch =
    campaign.status === "draft" &&
    connectedMailboxes.length > 0 &&
    campaign.sequence.length > 0 &&
    campaign.sequence.every((s, i) => (i === 0 ? s.subject.trim() : true) && s.body.trim()) &&
    leadPage.total > 0;

  async function handleLaunch() {
    setLaunching(true);
    setLaunchError(null);
    try {
      const res = await fetch(`/api/outreach/campaigns/${campaign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      const data = await res.json() as { error?: string; warning?: string };
      if (!res.ok) {
        setLaunchError(data.error ?? "Failed to launch");
        return;
      }
      // Started, but its emails could not be queued yet: say so, as the list and the wizard do.
      if (data.warning) await dialogs.alert({ title: campaign.status === "paused" ? "Campaign resumed" : "Campaign launched", description: data.warning, variant: "info" });
      router.refresh();
    } finally {
      setLaunching(false);
    }
  }

  async function handlePause() {
    await fetch(`/api/outreach/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "paused" }),
    });
    router.refresh();
  }

  const actions =
    campaign.status === "active" ? (
      <Button.Root variant="neutral" mode="stroke" size="small" onClick={handlePause}>
        <Button.Icon as={RiPauseCircleLine} />
        Pause
      </Button.Root>
    ) : campaign.status !== "completed" ? (
      <Button.Root
        variant="primary"
        mode="filled"
        size="small"
        onClick={handleLaunch}
        disabled={!canLaunch || launching}
        title={!canLaunch ? "Needs a connected mailbox, a complete sequence, and at least one lead" : undefined}
      >
        <Button.Icon as={RiPlayCircleLine} />
        {launching ? "Launching…" : campaign.status === "paused" ? "Resume" : "Launch campaign"}
      </Button.Root>
    ) : null;

  return (
    <PageContainer>
      <PageHeader
        back={{ href: "/outreach/campaigns", label: "Send campaigns" }}
        title={campaign.name}
        badge={
          <Badge.Root size="medium" variant="lighter" color={STATUS_COLOR[campaign.status] ?? "gray"}>
            <Badge.Dot />
            {STATUS_LABEL[campaign.status] ?? campaign.status}
          </Badge.Root>
        }
        description={`Created ${createdAt(campaign.createdAt)} · ${campaign.sequence.length} ${campaign.sequence.length === 1 ? "step" : "steps"}`}
        actions={actions}
      />
      {launchError && <p role="alert" className="mt-2 text-paragraph-sm text-error-base">{launchError}</p>}

      {/* Today, regardless of tab. */}
      <StatRow
        className="mt-5"
        items={[
          { label: "Follow-ups today", value: pulse.followUpsToday.toLocaleString("en-US"), icon: RiMailSendLine, hint: "Later steps due to send today" },
          { label: "New leads reached today", value: pulse.newLeadsReachedToday.toLocaleString("en-US"), icon: RiUserAddLine, hint: "First emails sent today" },
          { label: "Sequence steps", value: String(pulse.activeSequences), icon: RiStackLine },
          { label: "Next email", value: untilNext(pulse.nextSendAt), icon: RiTimeLine, hint: campaign.status === "active" ? "The next queued send" : "Sends run while the campaign is active" },
        ]}
      />

      <PageTabs
        className="mt-6"
        label="Campaign sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "analytics", label: "Analytics", icon: RiBarChart2Line },
          { value: "leads", label: "Leads", icon: RiTeamLine, count: leadPage.total },
          { value: "sequence", label: "Sequence", icon: RiListOrdered2, count: campaign.sequence.length },
        ]}
      />

      <div role="tabpanel" className="mt-6">
        {tab === "analytics" && (
          <AnalyticsTab stats={stats} stepBreakdown={stepBreakdown} dailySends={dailySends} />
        )}
        {tab === "leads" && (
          <LeadsTab campaignId={campaign.id} initialPage={leadPage} onImported={() => router.refresh()} />
        )}
        {tab === "sequence" && <SequenceTab campaignId={campaign.id} initialSequence={campaign.sequence} />}
      </div>
    </PageContainer>
  );
}
