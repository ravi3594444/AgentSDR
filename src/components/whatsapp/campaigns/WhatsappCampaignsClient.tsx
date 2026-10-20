"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  RiAddLine,
  RiChat1Line,
  RiDeleteBinLine,
  RiLoader4Line,
  RiMoreLine,
  RiPauseCircleLine,
  RiPencilLine,
  RiPercentLine,
  RiPlayCircleLine,
  RiSearchLine,
  RiSendPlaneLine,
  RiTeamLine,
} from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Input from "@/components/alignui/input";
import * as SegmentedControl from "@/components/alignui/segmented-control";
import * as Table from "@/components/alignui/table";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { KpiCell, KpiStrip } from "@/components/analytics/kit/KpiStrip";
import { CHANNEL_META, formatCompact, formatPercent } from "@/components/analytics/theme";
import { useDialogs } from "@/components/DialogProvider";
import CampaignProgressRing from "@/components/outreach/CampaignProgressRing";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { Skeleton } from "@/components/page/Skeletons";
import type { ListWhatsappCampaignsResponse, WhatsappCampaignSummary } from "@/lib/whatsapp/campaigns/contract";
import { cn } from "@/utils/cn";
import { apiJson, errorText } from "./api";
import { EditWhatsappCampaignModal } from "./EditWhatsappCampaignModal";
import { CAMPAIGN_STATUS, campaignFunnel, leadsProgressText } from "./metrics";

const WHATSAPP = CHANNEL_META.whatsapp.color;

const FILTERS = ["all", "active", "paused"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_LABEL: Record<Filter, string> = { all: "All", active: "Active", paused: "Paused" };

const num = "text-paragraph-sm tabular-nums text-text-strong-950";

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function senderLabel(c: WhatsappCampaignSummary): string {
  if (c.senders.length === 0) return "No numbers";
  const first = c.senders[0]!;
  const name = first.name || first.phone || "Number";
  return c.senders.length === 1 ? name : `${name} +${c.senders.length - 1}`;
}

function RowMenu({ campaign, busy, onToggle, onDelete, onEdit }: { campaign: WhatsappCampaignSummary; busy: boolean; onToggle: () => void; onDelete: () => void; onEdit: () => void }) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={busy} aria-label={`More actions for ${campaign.name}`}>
          <Button.Icon as={busy ? RiLoader4Line : RiMoreLine} className={cn(busy && "animate-spin")} />
        </Button.Root>
      </Dropdown.Trigger>
      <Dropdown.Content>
        <Dropdown.Item onSelect={onEdit}>
          <Dropdown.ItemIcon as={RiPencilLine} />
          Edit campaign
        </Dropdown.Item>
        <Dropdown.Item onSelect={onToggle}>
          <Dropdown.ItemIcon as={campaign.status === "active" ? RiPauseCircleLine : RiPlayCircleLine} />
          {campaign.status === "active" ? "Pause campaign" : "Resume campaign"}
        </Dropdown.Item>
        <Dropdown.Separator />
        <Dropdown.Item destructive onSelect={onDelete}>
          <Dropdown.ItemIcon as={RiDeleteBinLine} />
          Archive campaign
        </Dropdown.Item>
      </Dropdown.Content>
    </Dropdown.Root>
  );
}

const NewCampaignButton = () => (
  <Button.Root variant="primary" mode="filled" size="small" asChild>
    <Link href="/whatsapp/campaigns/new">
      <Button.Icon as={RiAddLine} />
      New campaign
    </Link>
  </Button.Root>
);

export function WhatsappCampaignsClient() {
  const dialogs = useDialogs();
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<WhatsappCampaignSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<WhatsappCampaignSummary | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    try {
      const data = await apiJson<ListWhatsappCampaignsResponse>("/api/whatsapp/campaigns");
      setCampaigns(data.campaigns);
      setLoadError(null);
    } catch (cause) {
      setLoadError(errorText(cause, "Could not load campaigns"));
    }
  }, []);

  useEffect(() => {
    // Fetch on mount and whenever the query changes; state is set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const rows = useMemo(() => (campaigns ?? []).map((c) => ({ ...c, funnel: campaignFunnel(c.stats) })), [campaigns]);

  const counts = useMemo(
    () => ({ all: rows.length, active: rows.filter((c) => c.status === "active").length, paused: rows.filter((c) => c.status === "paused").length }),
    [rows],
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (t, r) => ({ leads: t.leads + r.funnel.total, queued: t.queued + r.funnel.queued, messaged: t.messaged + r.funnel.messaged, replied: t.replied + r.funnel.replied, sent: t.sent + r.funnel.messagesSent }),
        { leads: 0, queued: 0, messaged: 0, replied: 0, sent: 0 },
      ),
    [rows],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows
      .filter((c) => filter === "all" || c.status === filter)
      .filter((c) => !term || c.name.toLowerCase().includes(term) || (c.description ?? "").toLowerCase().includes(term));
  }, [rows, filter, search]);

  const maxReply = Math.max(...filtered.map((c) => c.funnel.replyRate ?? 0), 0.0001);

  const open = (id: string) => {
    if (busyId !== id) router.push(`/whatsapp/campaigns/${id}`);
  };

  async function toggle(c: WhatsappCampaignSummary) {
    const next = c.status === "active" ? "paused" : "active";
    setBusyId(c.id);
    try {
      await apiJson(`/api/whatsapp/campaigns/${c.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      setCampaigns((prev) => prev?.map((x) => (x.id === c.id ? { ...x, status: next } : x)) ?? prev);
    } catch (cause) {
      await dialogs.alert({ title: `Could not ${next === "paused" ? "pause" : "launch"} the campaign`, description: errorText(cause), variant: "error" });
    } finally {
      setBusyId(null);
    }
  }

  async function archive(c: WhatsappCampaignSummary) {
    const ok = await dialogs.confirm({
      title: "Archive campaign?",
      description: "Sending stops and the campaign leaves this list. Messages already sent stay in Messages and the CRM.",
      confirmLabel: "Archive campaign",
      variant: "error",
    });
    if (!ok) return;
    setBusyId(c.id);
    try {
      await apiJson(`/api/whatsapp/campaigns/${c.id}`, { method: "DELETE" });
      setCampaigns((prev) => prev?.filter((x) => x.id !== c.id) ?? prev);
    } catch (cause) {
      await dialogs.alert({ title: "Could not archive campaign", description: errorText(cause), variant: "error" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1440px]">
      <PageHeader
        title="Message campaigns"
        description="Cold WhatsApp messages and follow-ups from your numbers. A reply on any channel stops the sequence."
        actions={<NewCampaignButton />}
      />

      <KpiStrip className="mt-6" columns={4}>
        <KpiCell icon={RiTeamLine} label="Leads" value={formatCompact(totals.leads)} context={`${formatCompact(totals.queued)} not messaged yet`} />
        <KpiCell icon={RiSendPlaneLine} label="Messaged" value={formatCompact(totals.messaged)} context={`${formatCompact(totals.sent)} messages sent`} hint="Leads who received at least one message and are still in sequence, finished or replied." />
        <KpiCell icon={RiChat1Line} label="Replied" value={formatCompact(totals.replied)} context={totals.messaged > 0 ? `${formatPercent(totals.replied / totals.messaged)} of messaged` : undefined} hint="Leads who replied, on any channel." />
        <KpiCell icon={RiPercentLine} label="Reply rate" value={formatPercent(totals.messaged > 0 ? totals.replied / totals.messaged : null)} context={`${counts.active} active, ${counts.paused} paused`} hint="Replied divided by messaged, across every campaign." />
      </KpiStrip>

      <Frame className="mt-5">
        <FrameHeader
          title="Campaigns"
          description="All time. Select a campaign to see its activity, leads and sequence."
          actions={
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
              <SegmentedControl.Root value={filter} onValueChange={(v) => setFilter(v as Filter)}>
                <SegmentedControl.List className="w-auto">
                  {FILTERS.map((f) => (
                    <SegmentedControl.Trigger key={f} value={f} className="gap-1.5 px-3">
                      {FILTER_LABEL[f]}
                      <span className="tabular-nums text-text-soft-400">{counts[f]}</span>
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
          {campaigns === null && !loadError ? (
            <div aria-busy="true" aria-label="Loading" className="space-y-2 p-2">
              {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
            </div>
          ) : loadError ? (
            <EmptyState
              icon={RiChat1Line}
              title="Could not load campaigns"
              description={loadError}
              action={<Button.Root variant="neutral" mode="stroke" size="small" onClick={() => void load()}>Try again</Button.Root>}
            />
          ) : filtered.length === 0 ? (
            rows.length === 0 ? (
              <EmptyState
                icon={RiChat1Line}
                title="No message campaigns yet"
                description="Start one to send a first WhatsApp message and follow-ups from your numbers."
                action={<NewCampaignButton />}
              />
            ) : (
              <EmptyState
                icon={RiSearchLine}
                title="No campaigns match"
                description="Try another status or search."
                action={<Button.Root variant="neutral" mode="stroke" size="small" onClick={() => { setSearch(""); setFilter("all"); }}>Clear filters</Button.Root>}
              />
            )
          ) : (
            <Table.Root className="min-w-[960px] [&>table]:table-fixed">
              <Table.Header>
                <Table.Row>
                  <Table.Head scope="col" className="px-4">Campaign</Table.Head>
                  <Table.Head scope="col" className="w-40 px-4">Numbers</Table.Head>
                  <Table.Head scope="col" className="w-20 px-4 text-right">Leads</Table.Head>
                  <Table.Head scope="col" className="w-24 whitespace-nowrap px-4 text-right" title="Leads not yet sent their first message">Not messaged</Table.Head>
                  <Table.Head scope="col" className="w-24 px-4 text-right" title="Leads sent at least one message, or who replied; kept after a stop">Messaged</Table.Head>
                  <Table.Head scope="col" className="w-48 px-4" title="Leads who replied, and replied ÷ messaged">Replied</Table.Head>
                  <Table.Head scope="col" className="w-14 px-4"><span className="sr-only">Actions</span></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body spacing={4}>
                {filtered.map((c) => {
                  const f = c.funnel;
                  const busy = busyId === c.id;
                  const status = CAMPAIGN_STATUS[c.status];
                  return (
                    <Table.Row
                      key={c.id}
                      tabIndex={0}
                      aria-busy={busy || undefined}
                      onClick={() => open(c.id)}
                      onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === "Enter") open(c.id); }}
                      className={cn("cursor-pointer outline-none focus-visible:[&>td]:bg-bg-weak-50", busy && "pointer-events-none opacity-60")}
                    >
                      <Table.Cell className="h-16 px-4">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="shrink-0" title={f.progress === null ? "No leads" : `${Math.round(f.progress * 100)}% of leads messaged. ${leadsProgressText(f) ?? ""}`.trim()}>
                            <CampaignProgressRing progress={f.progress} complete={f.complete} />
                          </div>
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-label-sm text-text-strong-950" title={c.name}>{c.name}</span>
                              <Badge.Root size="small" variant="lighter" color={status.color} className="shrink-0">
                                <Badge.Dot />
                                {status.label}
                              </Badge.Root>
                            </div>
                            <p className="mt-0.5 max-w-md truncate text-paragraph-xs text-text-sub-600" title={c.description ?? undefined} suppressHydrationWarning>
                              Created {shortDate(c.createdAt)} · {c.stepCount} {c.stepCount === 1 ? "message" : "messages"}
                              {c.description ? ` · ${c.description}` : ""}
                            </p>
                          </div>
                        </div>
                      </Table.Cell>
                      <Table.Cell className="px-4">
                        <span className="block truncate text-paragraph-sm text-text-sub-600" title={c.senders.map((s) => s.name || s.phone).join(", ")}>{senderLabel(c)}</span>
                      </Table.Cell>
                      <Table.Cell className={cn("px-4 text-right", num)}>{f.total.toLocaleString("en-US")}</Table.Cell>
                      <Table.Cell className={cn("px-4 text-right", f.queued > 0 ? num : "text-paragraph-sm tabular-nums text-text-soft-400")}>{f.queued.toLocaleString("en-US")}</Table.Cell>
                      <Table.Cell className={cn("px-4 text-right", num)}>{f.messaged.toLocaleString("en-US")}</Table.Cell>
                      <Table.Cell className="px-4">
                        <div className="flex items-center gap-3" title={`${f.replied.toLocaleString("en-US")} replied · ${formatPercent(f.replyRate)}`}>
                          <span className={cn("w-10 text-right", num)}>{f.replied.toLocaleString("en-US")}</span>
                          <span className="w-11 text-paragraph-xs tabular-nums text-text-sub-600">{formatPercent(f.replyRate)}</span>
                          <span aria-hidden="true" className="h-1.5 w-12 rounded-full bg-bg-weak-50">
                            <span className="block h-full rounded-full" style={{ width: `${((f.replyRate ?? 0) / maxReply) * 100}%`, backgroundColor: WHATSAPP }} />
                          </span>
                        </div>
                      </Table.Cell>
                      <Table.Cell className="px-4" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                        <div className="flex justify-end">
                          <RowMenu campaign={c} busy={busy} onToggle={() => void toggle(c)} onDelete={() => void archive(c)} onEdit={() => setEditing(c)} />
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          )}
        </FramePanel>
      </Frame>

      <EditWhatsappCampaignModal
        campaign={editing}
        open={editing !== null}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        onSaved={() => { setEditing(null); void load(); }}
      />
    </div>
  );
}

