"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  RiAddLine,
  RiDeleteBinLine,
  RiMailSendLine,
  RiMoreLine,
  RiPauseCircleLine,
  RiPencilLine,
  RiPlayCircleLine,
  RiReplyLine,
  RiSearchLine,
  RiSendPlaneLine,
  RiTeamLine,
} from "@remixicon/react";

import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Input from "@/components/alignui/input";
import * as SegmentedControl from "@/components/alignui/segmented-control";
import { useDialogs } from "@/components/DialogProvider";
import * as Table from "@/components/alignui/table";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { KpiCell, KpiStrip } from "@/components/analytics/kit/KpiStrip";
import { CHANNEL_META, formatCompact, formatPercent } from "@/components/analytics/theme";
import { PageContainer, PageHeader } from "@/components/page/PageHeader";
import { cn } from "@/utils/cn";
import CampaignProgressRing from "./CampaignProgressRing";
import type { outreachCampaigns } from "@/lib/outreach/schema";

type Campaign = typeof outreachCampaigns.$inferSelect & {
  leadCount: number;
  sentCount: number;
  repliedCount: number;
  replyRate: number | null;
  progress: number | null;
  lastActivityAt: string | Date | null;
};

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

const TABS = ["all", "active", "paused", "draft", "completed"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  all: "All",
  active: "Active",
  paused: "Paused",
  draft: "Draft",
  completed: "Completed",
};

const EMAIL = CHANNEL_META.email.color;

const toDate = (date: string | Date) => (typeof date === "string" ? new Date(date) : date);

/** "Sep 14" — the created-at line under each campaign name. */
function shortDate(date: string | Date | null): string {
  if (!date) return "—";
  return toDate(date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "3h ago" / "2d ago" — when the campaign last sent. */
function ago(date: string | Date | null, now: number): string {
  if (!date) return "Never";
  const minutes = Math.round((now - toDate(date).getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

const num = "text-paragraph-sm tabular-nums text-text-strong-950";

/**
 * Per-row overflow menu. Pause/resume flips the campaign status through PATCH;
 * delete removes it (and its leads, via the ON DELETE CASCADE on the FK) after
 * a confirm, since there is no undo.
 */
function RowActions({ campaign }: { campaign: Campaign }) {
  const dialogs = useDialogs();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const canPause = campaign.status === "active";
  const canResume = campaign.status === "paused";

  async function setStatus(status: "active" | "paused") {
    setBusy(true);
    const res = await fetch(`/api/outreach/campaigns/${campaign.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      await dialogs.alert({
        title: `Could not ${status === "paused" ? "pause" : "resume"} the campaign`,
        description: data.error ?? "Something went wrong. Please try again.",
        variant: "error",
      });
      return;
    }
    startTransition(() => router.refresh());
  }

  async function remove() {
    const confirmed = await dialogs.confirm({
      title: "Delete campaign?",
      description: `“${campaign.name}” and its ${campaign.leadCount.toLocaleString()} lead${
        campaign.leadCount === 1 ? "" : "s"
      } and send history will be permanently deleted. This cannot be undone.`,
      confirmLabel: "Delete campaign",
      variant: "error",
    });
    if (!confirmed) return;

    setBusy(true);
    const res = await fetch(`/api/outreach/campaigns/${campaign.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      await dialogs.alert({
        title: "Could not delete campaign",
        description: "Something went wrong. Please try again.",
        variant: "error",
      });
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <Button.Root
          variant="neutral"
          mode="ghost"
          size="xsmall"
          disabled={busy || pending}
          aria-label={`More actions for ${campaign.name}`}
        >
          <Button.Icon as={RiMoreLine} />
        </Button.Root>
      </Dropdown.Trigger>

      <Dropdown.Content>
        <Dropdown.Item onSelect={() => router.push(`/outreach/campaigns/${campaign.id}`)}>
          <Dropdown.ItemIcon as={RiPencilLine} />
          Edit campaign
        </Dropdown.Item>

        {canPause && (
          <Dropdown.Item onSelect={() => setStatus("paused")}>
            <Dropdown.ItemIcon as={RiPauseCircleLine} />
            Pause campaign
          </Dropdown.Item>
        )}
        {canResume && (
          <Dropdown.Item onSelect={() => setStatus("active")}>
            <Dropdown.ItemIcon as={RiPlayCircleLine} />
            Resume campaign
          </Dropdown.Item>
        )}

        <Dropdown.Separator />

        <Dropdown.Item destructive onSelect={remove}>
          <Dropdown.ItemIcon as={RiDeleteBinLine} />
          Delete campaign
        </Dropdown.Item>
      </Dropdown.Content>
    </Dropdown.Root>
  );
}

export default function CampaignListClient({ campaigns }: { campaigns: Campaign[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  // Fixed per render of the list, so relative times don't read the clock during render.
  const [now] = useState(() => Date.now());

  const counts = useMemo(() => {
    const byStatus: Record<string, number> = { all: campaigns.length };
    for (const c of campaigns) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    return byStatus;
  }, [campaigns]);

  const totals = useMemo(
    () =>
      campaigns.reduce(
        (t, c) => {
          const last = c.lastActivityAt ? toDate(c.lastActivityAt).getTime() : 0;
          return { leads: t.leads + c.leadCount, sent: t.sent + c.sentCount, replied: t.replied + c.repliedCount, lastSend: Math.max(t.lastSend, last) };
        },
        { leads: 0, sent: 0, replied: 0, lastSend: 0 },
      ),
    [campaigns],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return campaigns.filter((c) => {
      if (tab !== "all" && c.status !== tab) return false;
      if (term && !c.name.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [campaigns, tab, search]);

  const maxRate = Math.max(...filtered.map((c) => c.replyRate ?? 0), 0.0001);
  const open = (id: string) => router.push(`/outreach/campaigns/${id}`);

  return (
    <PageContainer>
      <PageHeader
        title="Send campaigns"
        description="Email sequences sent from your mailboxes, and how each one is landing."
        actions={
          <Button.Root variant="primary" mode="filled" size="small" asChild>
            <Link href="/outreach/campaigns/new">
              <Button.Icon as={RiAddLine} />
              Create campaign
            </Link>
          </Button.Root>
        }
      />

      <KpiStrip className="mt-6" columns={4}>
        <KpiCell icon={RiSendPlaneLine} label="Active campaigns" value={formatCompact(counts.active ?? 0)} context={`${counts.paused ?? 0} paused · ${counts.draft ?? 0} draft · ${counts.completed ?? 0} completed`} />
        <KpiCell icon={RiTeamLine} label="Leads" value={formatCompact(totals.leads)} context={`across ${campaigns.length} ${campaigns.length === 1 ? "campaign" : "campaigns"}`} />
        <KpiCell icon={RiMailSendLine} label="Emails sent" value={formatCompact(totals.sent)} context={totals.lastSend ? `Last send ${ago(new Date(totals.lastSend), now)}` : "Nothing sent yet"} />
        <KpiCell icon={RiReplyLine} label="Replies" value={formatCompact(totals.replied)} context={totals.leads > 0 ? `${formatPercent(totals.replied / totals.leads, 2)} of leads replied` : undefined} hint="Leads who replied to any email in the campaign, all time." />
      </KpiStrip>

      <Frame className="mt-5">
        <FrameHeader
          title="Campaigns"
          description="All time. Select a campaign to see its sends, leads and sequence."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl.Root value={tab} onValueChange={(v) => setTab(v as Tab)}>
                <SegmentedControl.List className="w-auto">
                  {TABS.map((t) => (
                    <SegmentedControl.Trigger key={t} value={t} className="gap-1.5 px-3">
                      {TAB_LABEL[t]}
                      <span className="tabular-nums text-text-soft-400">{counts[t] ?? 0}</span>
                    </SegmentedControl.Trigger>
                  ))}
                </SegmentedControl.List>
              </SegmentedControl.Root>
              <Input.Root size="small" className="w-56">
                <Input.Wrapper>
                  <Input.Icon as={RiSearchLine} />
                  <Input.Input type="search" aria-label="Search campaigns" placeholder="Search campaigns…" value={search} onChange={(e) => setSearch(e.target.value)} />
                </Input.Wrapper>
              </Input.Root>
            </div>
          }
        />
        <FramePanel className="overflow-x-auto p-2 sm:p-2">
          {filtered.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-label-sm text-text-strong-950">{campaigns.length === 0 ? "No campaigns yet" : "No campaigns match"}</p>
              <p className="mt-1 text-paragraph-sm text-text-sub-600">{campaigns.length === 0 ? "Create one to start sending." : "Try another status or search."}</p>
            </div>
          ) : (
            <Table.Root className="min-w-[860px]">
              <Table.Header>
                <Table.Row>
                  <Table.Head scope="col" className="px-4">Campaign</Table.Head>
                  <Table.Head scope="col" className="w-28 px-4 text-right">Leads</Table.Head>
                  <Table.Head scope="col" className="w-28 px-4 text-right">Sent</Table.Head>
                  <Table.Head scope="col" className="w-64 px-4">Replies</Table.Head>
                  <Table.Head scope="col" className="w-32 px-4">Last send</Table.Head>
                  <Table.Head scope="col" className="w-16 px-4"><span className="sr-only">Actions</span></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body spacing={4}>
                {filtered.map((c) => (
                  <Table.Row
                    key={c.id}
                    tabIndex={0}
                    onClick={() => open(c.id)}
                    onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === "Enter") open(c.id); }}
                    className="cursor-pointer outline-none focus-visible:[&>td]:bg-bg-weak-50"
                  >
                    <Table.Cell className="h-16 px-4">
                      <div className="flex min-w-0 items-center gap-3">
                        <CampaignProgressRing progress={c.progress} complete={c.status === "completed"} />
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-label-sm text-text-strong-950" title={c.name}>{c.name}</span>
                            <Badge.Root size="small" variant="lighter" color={STATUS_COLOR[c.status] ?? "gray"} className="shrink-0">
                              <Badge.Dot />
                              {STATUS_LABEL[c.status] ?? c.status}
                            </Badge.Root>
                          </div>
                          <p className="mt-0.5 truncate text-paragraph-xs text-text-sub-600">
                            {c.sequence.length} {c.sequence.length === 1 ? "step" : "steps"} · Created {shortDate(c.createdAt)}
                          </p>
                        </div>
                      </div>
                    </Table.Cell>
                    <Table.Cell className={cn("px-4 text-right", num)}>{c.leadCount.toLocaleString("en-US")}</Table.Cell>
                    <Table.Cell className={cn("px-4 text-right", num)}>{c.sentCount.toLocaleString("en-US")}</Table.Cell>
                    <Table.Cell className="px-4">
                      <div className="flex items-center gap-3">
                        <span className={cn("w-10 text-right", num)}>{c.repliedCount.toLocaleString("en-US")}</span>
                        <span className="w-12 text-paragraph-xs tabular-nums text-text-sub-600">{formatPercent(c.replyRate, 2)}</span>
                        <span aria-hidden="true" className="h-1.5 w-20 rounded-full bg-bg-weak-50">
                          <span className="block h-full rounded-full" style={{ width: `${((c.replyRate ?? 0) / maxRate) * 100}%`, backgroundColor: EMAIL }} />
                        </span>
                      </div>
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap px-4 text-paragraph-sm text-text-sub-600">{ago(c.lastActivityAt, now)}</Table.Cell>
                    <Table.Cell className="px-4" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <div className="flex justify-end">
                        <RowActions campaign={c} />
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </FramePanel>
      </Frame>
    </PageContainer>
  );
}
