"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  RiAddLine,
  RiArrowDownLine,
  RiArrowDownSLine,
  RiArrowUpLine,
  RiAttachment2,
  RiBarChartBoxLine,
  RiCheckboxCircleFill,
  RiCloseLine,
  RiErrorWarningFill,
  RiExternalLinkLine,
  RiFileList3Line,
  RiFileTextLine,
  RiInformationLine,
  RiHistoryLine,
  RiLoader4Line,
  RiPauseLine,
  RiPlayLine,
  RiRobot2Line,
  RiSearchEyeLine,
  RiSparkling2Fill,
  RiStore2Line,
  RiTableLine,
} from "@remixicon/react";

import * as Badge from "@/components/alignui/badge";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Popover from "@/components/alignui/popover";
import { displayThreadTitle } from "@/lib/assistant/agent";
import { takesAnAnswer } from "@/lib/assistant/handoff";
import type { OwnerDecisionKind } from "@/lib/assistant/schema";
import type { RunAuthorization, SenderStatus } from "@/lib/assistant/runEvidence";
import { AUTOPILOT_LIMITS } from "@/lib/crm/autopilot";
import * as Button from "@/components/alignui/button";
import NeedsYouList from "@/components/assistant/NeedsYouList";
import { useChatScroll } from "./useChatScroll";
import { cn } from "@/utils/cn";

/**
 * The owner's assistant: a chat that acts. Everything shown as done comes
 * from the server's records (tool results, job progress, run status), never
 * from the model's own words; the Start button on a plan is the only thing
 * that starts outreach.
 */

type Message = {
  id: string;
  role: "user" | "assistant" | "tool" | "event";
  content: string;
  tool: string | null;
  toolInput: Record<string, unknown> | null;
  toolResult: { summary?: string; display?: string; data?: Record<string, unknown>; suggestions?: string[]; hidden?: boolean } | null;
  status: "running" | "ok" | "error" | null;
  attachments: { name: string; kind: string; bytes: number }[];
  createdAt: string;
};

type Job = {
  id: string;
  kind: "discovery" | "outreach_start" | "linkedin_search" | "web_discovery" | "apify_instagram";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  audienceId: string | null;
  runId: string | null;
};

type RunReply = { id: string; conversationId: string; who: string; channel: string; receivedAt: string; preview: string; state: { tone: "done" | "waiting" | "you" | "failed"; text: string; at?: string; release?: boolean } };

type RunLead = { personId: string; who: string; channel: string; progress: { tone: "waiting" | "sent" | "replied" | "good" | "stopped" | "failed"; text: string } };

type Run = { id: string; status: string; autopilot: boolean; error: string | null; campaigns: Record<string, string>; replies?: RunReply[]; leads?: RunLead[]; /** Other plans of the same request, and its searches still running. */ requestPeers?: number; /** Who authorized it to send, and how (runEvidence.ts). */ authorization?: RunAuthorization };

type DecisionState = { status: "open" | "answered" | "resolved"; answer: string | null };

type ChannelStatus = { available: boolean; reason: string | null; senders: number };

type Setup = {
  channels: Record<"email" | "whatsapp" | "linkedin" | "instagram", ChannelStatus>;
  leadDiscovery: { available: boolean; reason: string | null };
  ai: { connected: boolean };
  automaticRuns: number;
  canManageAutopilot: boolean;
  features?: { instagram?: boolean };
  missingForDiscovery: string[];
  missingForOutreach: string[];
};

export type AssistantStatePayload = {
  thread: { id: string; title: string; autonomous?: boolean; autonomyCaps?: { runsPerDay: number; leadsPerDay: number; searchesPerDay: number } | null };
  viewer?: { firstName: string | null };
  threads: { id: string; title: string; updatedAt: string | Date }[];
  busy: boolean;
  messages: Message[];
  jobs: Job[];
  runs: Record<string, Run>;
  decisions: Record<string, DecisionState>;
  setup: Setup | null;
  /** The reply mode the owner chose on their latest started run: the plan card starts with it selected. */
  lastReplyMode?: "automatic" | "review" | null;
};

const ACCEPT = ".pdf,.docx,.txt,.md,.csv,.tsv,.xlsx,.xls";
// The reply limits the server enforces (src/lib/crm/autopilot.ts), shown before Start.
const AUTOPILOT_PER_CONVERSATION = AUTOPILOT_LIMITS.perConversation;
const AUTOPILOT_PER_DAY = AUTOPILOT_LIMITS.perDay;
const CHANNEL_LABEL: Record<string, string> = { email: "Email", whatsapp: "WhatsApp", linkedin: "LinkedIn", instagram: "Instagram" };

const TOOL_TITLE: Record<string, string> = {
  check_setup: "Checked what is connected",
  save_business_info: "Saved business information",
  search_knowledge: "Read your saved information",
  find_leads: "Lead search",
  find_linkedin_leads: "LinkedIn search",
  lead_search_status: "Checked the lead search",
  list_audiences: "Lead lists",
  describe_audience: "Lead list",
  prepare_outreach: "Outreach plan",
  list_runs: "Outreach runs",
  report: "Results",
  pause_outreach: "Paused outreach",
  resume_outreach: "Resumed outreach",
  stop_outreach: "Stopped outreach",
  switch_to_review: "Review mode",
  list_decisions: "Waiting for you",
  answer_decision: "Saved your answer",
  owner_decision: "Needs your decision",
  daily_summary: "Daily summary",
  read_document: "Document",
  import_contacts: "Contact list",
  add_contacts: "Added contacts",
  add_instagram_contacts: "Saved Instagram contacts",
  read_webpage: "Read a web page",
  find_customers_on_web: "Web search",
  find_instagram_prospects: "Instagram prospects",
  find_social_leads: "Social media search",
  treg_search: "Treg catalog search",
  treg_call: "Treg lookup",
  use_existing_leads: "Lead list from your leads",
  list_inquiries: "Inquiries",
  prepare_inquiry_replies: "Answering new inquiries",
};

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (HTTP ${response.status})`);
  return body;
}

function StatusIcon({ status }: { status: Message["status"] | Job["status"] }) {
  if (status === "running" || status === "queued") return <RiLoader4Line className="size-4 shrink-0 animate-spin text-text-soft-400" aria-label="Working" />;
  if (status === "ok" || status === "succeeded") return <RiCheckboxCircleFill className="size-4 shrink-0 text-success-base" aria-label="Done" />;
  return <RiErrorWarningFill className="size-4 shrink-0 text-error-base" aria-label="Failed" />;
}

function Card({ title, status, children }: { title: string; status: Message["status"] | Job["status"]; children?: React.ReactNode }) {
  return (
    <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-stroke-soft-200 bg-bg-white-0 p-4">
      <div className="flex items-center gap-2.5">
        <StatusIcon status={status} />
        <p className="min-w-0 flex-1 truncate text-label-sm text-text-strong-950">{title}</p>
      </div>
      {children && <div className="mt-2 space-y-2 text-paragraph-sm text-text-sub-600">{children}</div>}
    </div>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

type AudienceData = {
  name?: string;
  total?: number;
  eligible?: number;
  byChannel?: Record<string, number>;
  excluded?: { reason: string; count: number }[];
  samples?: { name: string; channels: string[]; sourceUrl: string | null; evidence: { kind: string; value: string; sourceUrl: string | null; source: string }[] }[];
};

function AudienceSummary({ audience }: { audience: AudienceData }) {
  return (
    <div className="space-y-2">
      <p>
        <span className="text-label-sm text-text-strong-950">{audience.eligible ?? 0}</span> of {audience.total ?? 0} can be contacted
        {audience.byChannel && (
          <> · {Object.entries(audience.byChannel).filter(([, n]) => n > 0).map(([channel, n]) => `${CHANNEL_LABEL[channel] ?? channel} ${n}`).join(", ") || "no channel"}</>
        )}
      </p>
      {audience.excluded && audience.excluded.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-paragraph-xs">
          {audience.excluded.slice(0, 4).map((item) => <li key={item.reason}>{item.count} left out: {item.reason}</li>)}
        </ul>
      )}
      {audience.samples && audience.samples.length > 0 && (
        <details className="text-paragraph-xs">
          <summary className="cursor-pointer text-text-strong-950">Examples and where their details came from</summary>
          <ul className="mt-1.5 space-y-1.5">
            {audience.samples.map((sample) => (
              <li key={sample.name} className="rounded-lg bg-bg-weak-50 px-2.5 py-1.5">
                <p className="text-label-xs text-text-strong-950">{sample.name}</p>
                {sample.evidence.map((item) => (
                  <p key={`${item.kind}:${item.value}`} className="truncate">
                    {item.kind}: {item.value} · {item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-primary-base hover:underline">{item.source} ({hostOf(item.sourceUrl)})</a> : item.source}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

type ProspectSignal = { kind: "need" | "engagement"; text: string; sourceUrl: string | null; source: string; at: string | null };
type ProspectView = {
  personId: string | null;
  name: string;
  status: "potential_match" | "inquired" | "replied" | "interested" | "excluded";
  statusLabel: string;
  excludedReason: string | null;
  source: { label: string; url: string | null };
  foundAt: string;
  matchReason: string;
  routes: { channel: string; value: string; sourceUrl: string | null; note: string }[];
  needEvidence: ProspectSignal[];
  engagement: ProspectSignal[];
  location: string;
  budget: string;
};
type ProspectsPayload = { counts: Record<string, number>; prospects: ProspectView[] };

const PROSPECT_COLOR: Record<ProspectView["status"], "gray" | "green" | "blue" | "orange"> = { potential_match: "gray", inquired: "blue", replied: "orange", interested: "green", excluded: "gray" };

/**
 * Every lead of a list before outreach: where and when it was found, why it
 * matched, how it can be reached (each detail with its page), and only the
 * lead's own words as evidence of a need. Loaded when opened.
 */
function ProspectsList({ audienceId }: { audienceId: string }) {
  const [data, setData] = useState<ProspectsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function load() {
    if (data || loading) return;
    setLoading(true);
    try {
      setData(await readJson<ProspectsPayload>(await fetch(`/api/assistant/audiences/${audienceId}/prospects`, { cache: "no-store" })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }
  const counts = data?.counts;
  return (
    <details className="text-paragraph-xs" onToggle={(event) => { if ((event.target as HTMLDetailsElement).open) void load(); }}>
      <summary className="cursor-pointer text-text-strong-950">Review the leads: source, why they match, evidence</summary>
      {loading && <p className="mt-1.5 text-text-soft-400">Loading…</p>}
      {error && <p role="alert" className="mt-1.5 text-error-base">{error}</p>}
      {counts && (
        <p className="mt-1.5 text-text-sub-600">
          {counts.potential_match ?? 0} potential match{counts.potential_match === 1 ? "" : "es"} · {counts.inquired ?? 0} inquired · {counts.replied ?? 0} replied · {counts.interested ?? 0} interested · {counts.withNeedEvidence ?? 0} with their own words showing a need. A potential match is not an interested customer.
        </p>
      )}
      {data && (
        <ul className="mt-1.5 max-h-96 space-y-1.5 overflow-y-auto">
          {data.prospects.map((prospect, index) => (
            <li key={`${prospect.personId ?? prospect.name}-${index}`} className="rounded-lg bg-bg-weak-50 px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-label-xs text-text-strong-950">{prospect.name}</p>
                <Badge.Root variant="lighter" size="small" color={PROSPECT_COLOR[prospect.status]}>{prospect.statusLabel}</Badge.Root>
              </div>
              <p className="mt-0.5 text-text-sub-600">
                {prospect.source.url ? <a href={prospect.source.url} target="_blank" rel="noopener noreferrer" className="text-primary-base hover:underline">{prospect.source.label} ({hostOf(prospect.source.url)})</a> : prospect.source.label}
                {" · "}{new Date(prospect.foundAt).toLocaleDateString()}
              </p>
              <p className="mt-0.5 text-text-sub-600">Why: {prospect.matchReason}</p>
              {prospect.excludedReason && <p className="mt-0.5 text-text-sub-600">Left out: {prospect.excludedReason}</p>}
              {prospect.routes.length > 0 ? prospect.routes.map((route) => (
                <p key={`${route.channel}:${route.value}`} className="mt-0.5 truncate text-text-sub-600">
                  {route.channel}: {route.value} · {route.sourceUrl ? <a href={route.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-primary-base hover:underline">{route.note} ({hostOf(route.sourceUrl)})</a> : route.note}
                </p>
              )) : <p className="mt-0.5 text-text-sub-600">Contact: Unknown</p>}
              {prospect.needEvidence.map((signal, signalIndex) => (
                <p key={`need-${signalIndex}`} className="mt-0.5 border-l-2 border-stroke-sub-300 pl-2 text-text-sub-600">
                  “{signal.text}” <span className="text-text-soft-400">— {signal.sourceUrl ? <a href={signal.sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{signal.source}</a> : signal.source}{signal.at ? `, ${new Date(signal.at).toLocaleDateString()}` : ""}</span>
                </p>
              ))}
              {prospect.engagement.length > 0 && <p className="mt-0.5 text-text-soft-400">{prospect.engagement.length} like{prospect.engagement.length === 1 ? "" : "s"}, follow{prospect.engagement.length === 1 ? "" : "s"} or generic comment{prospect.engagement.length === 1 ? "" : "s"} (not counted as interest)</p>}
              {!prospect.needEvidence.length && prospect.status === "potential_match" && <p className="mt-0.5 text-text-soft-400">No evidence of a need found.</p>}
              <p className="mt-0.5 text-text-soft-400">Location: {prospect.location} · Budget: {prospect.budget}</p>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function DiscoveryCard({ message, job }: { message: Message; job: Job | undefined }) {
  const data = message.toolResult?.data as { phrase?: string; keywords?: string } | undefined;
  const linkedin = message.tool === "find_linkedin_leads";
  const instagram = job?.kind === "apify_instagram";
  // Facebook, LinkedIn or Instagram search through Apify (find_social_leads).
  const social = message.tool === "find_social_leads";
  // A search handed to website search (no Google Maps or Apify available) shows as one.
  const web = message.tool === "find_customers_on_web" || job?.kind === "web_discovery";
  const viaApify = (job?.progress as Record<string, unknown> | undefined)?.provider === "Apify" || (job?.result as Record<string, unknown> | null | undefined)?.provider === "apify";
  if (message.status !== "ok" || !job) return <Card title={TOOL_TITLE[message.tool ?? "find_leads"] ?? "Lead search"} status={message.status}><p>{message.toolResult?.display ?? message.content}</p></Card>;
  const progress = job.progress as Record<string, number | string>;
  // The source and provider the server recorded, e.g. "Google Maps through the built-in scraper".
  const source = typeof progress.source === "string" ? progress.source : null;
  const waiting = (job.progress as { waiting?: { reason?: string | null; until?: string } } | null)?.waiting;
  const stageText: Record<string, string> = {
    queued: waiting ? `Waiting to start${source ? ` ${source}` : ""}: ${waiting.reason ?? "a provider asked to wait"}.` : progress.note ? `${String(progress.note)}…` : "Starting the search…",
    searching: waiting ? `Waiting: ${waiting.reason ?? "a provider asked to wait"}${waiting.until ? ` (until ${new Date(waiting.until).toLocaleTimeString()})` : ""}.` : social ? `Searching through Apify (${String(progress.actor ?? "social media")})…` : linkedin ? `Searching LinkedIn (${progress.found ?? 0} profiles so far)…` : web ? "Searching the web for matching businesses and directories…" : instagram ? `Searching Instagram through Apify (${String(progress.actor ?? "")})…` : `Searching ${source ?? `Google Maps${viaApify ? " through Apify" : ""}`}${progress.searches ? ` in ${progress.searches} area${Number(progress.searches) === 1 ? "" : "s"}` : ""} (usually 1–10 minutes)…`,
    reading: `Reading the pages the search found for published contact details (${progress.read ?? progress.pagesRead ?? 0} of ${progress.toRead ?? progress.candidates ?? "?"})…`,
    enriching: `Reading business websites for contact details (${progress.websitesChecked ?? 0} of ${progress.websitesToCheck ?? "?"})…`,
    saving: `Checking and saving contacts (${progress.saved ?? 0} of ${progress.found ?? "?"})…`,
  };
  const result = job.result as Record<string, number | string | null> | null;
  return (
    <Card title={`${linkedin ? "LinkedIn search" : web ? "Web search" : instagram ? "Instagram prospects" : viaApify ? "Lead search (Apify)" : "Lead search"}: ${data?.phrase ?? data?.keywords ?? (data as { customers?: string } | undefined)?.customers ?? ""}`} status={job.status}>
      {job.status === "queued" || job.status === "running" ? (
        <p role="status">{stageText[job.stage] ?? "Working…"}{typeof progress.found === "number" && job.stage !== "searching" ? ` ${progress.found} businesses found.` : ""}</p>
      ) : job.status === "succeeded" && result?.notSearched ? (
        <p>{instagram ? "Instagram was not searched." : `${source ?? "This source"} was not searched.`}{result.note ? <span className="mt-1 block">{String(result.note)}</span> : null}</p>
      ) : job.status === "succeeded" && result ? (
        <p>
          {result.found ?? 0} {linkedin ? "profiles" : instagram ? "Instagram accounts" : "businesses"} found{source && !instagram && !linkedin ? ` on ${source}` : ""}{instagram ? " (potential matches, not interest)" : ""} · <span className="text-label-sm text-text-strong-950">{result.eligible ?? 0} contactable</span>{linkedin ? " on LinkedIn" : ` (${result.withEmail ?? 0} by email, ${result.withPhoneOnly ?? 0} by phone only, ${result.withInstagram ?? 0} with Instagram profiles)`}
          {instagram && Number(result.instagramOnly ?? 0) > 0 && ` · ${result.instagramOnly} found on Instagram only — approved DM plan and connected sender required`}
          {Number(result.excluded ?? 0) > 0 && ` · ${result.excluded} left out with reasons`}
          {Number(result.duplicates ?? 0) > 0 && ` · ${result.duplicates} duplicates skipped`}
          {Number(result.alreadyKnown ?? 0) > 0 && ` · ${result.alreadyKnown} already in your leads (not duplicated)`}
          {result.note ? <span className="mt-1 block">{String(result.note)}</span> : null}
          {result.providerNote ? <span className="mt-1 block text-text-sub-600">{String(result.providerNote)}</span> : null}
        </p>
      ) : (
        <p className="text-error-base">{job.error ?? "The search failed."}</p>
      )}
      {job.status === "succeeded" && job.audienceId && <ProspectsList audienceId={job.audienceId} />}
    </Card>
  );
}

type ProposalData = {
  runId: string;
  name: string;
  audience: { name: string; eligible: number; total: number };
  plan: {
    assignments: { channel: string }[];
    samples: { name: string; channel: string; groupId?: string; approach?: "standard" | "personal"; messages: { subject: string | null; body: string }[] }[];
    groups?: { id: string; label: string; count: number }[];
    personal?: { personId: string; name: string }[];
    skipped?: { personId: string; name: string; reason: string }[];
    limits: { maxLeads: number; emailPerMailboxPerDay: number | null; whatsappNewChatsPerDay: number | null; instagramNewChatsPerDay?: number | null };
    excluded: { reason: string; count: number }[];
    estimate: { aiCalls: number; aiCostUsd: number | null; days: number | null };
    autopilot: boolean;
    ownerRequest?: string | null;
    requestId?: string | null;
  };
};

/**
 * Autonomous mode for this chat (src/lib/assistant/autonomy.ts): the
 * assistant works without asking and plans start on their own in Automatic
 * mode, within the organization's daily caps. Only owners and admins can
 * turn it on; anyone can turn it off.
 */
function AutonomousSwitch({ thread, canManage, onChanged }: { thread: AssistantStatePayload["thread"]; canManage: boolean; onChanged: (next: AssistantStatePayload) => void }) {
  const [busy, setBusy] = useState(false);
  const on = Boolean(thread.autonomous);
  async function toggle() {
    if (!on && !window.confirm("Turn on Autonomous mode for this chat?\n\nThe assistant will work without asking you. Plans it prepares start on their own in Automatic mode, so it messages leads you have not reviewed, within your daily caps (Settings → Organization) and each channel's sending limits.\n\nYou can turn it off at any time.")) return;
    setBusy(true);
    try {
      const response = await fetch("/api/assistant/threads", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId: thread.id, autonomous: !on }) });
      const body = (await response.json().catch(() => ({}))) as AssistantStatePayload & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (HTTP ${response.status})`);
      onChanged(body);
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const locked = !on && !canManage;
  const title = on
    ? "Autonomous: the assistant works without asking and starts plans on its own. Click to turn it off."
    : locked ? "Only an owner or admin can turn on Autonomous mode." : "Let the assistant work without asking: plans start on their own in Automatic mode, within your daily caps.";
  return (
    <button type="button" role="switch" aria-checked={on} aria-label="Autonomous mode" title={title} disabled={busy || locked} onClick={() => void toggle()} data-testid="autonomous-switch"
      className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-label-xs ring-1 ring-inset transition-colors", on ? "bg-primary-base text-primary-contrast ring-primary-base" : "text-text-sub-600 ring-stroke-soft-200 hover:bg-bg-weak-50", (busy || locked) && "opacity-60")}>
      {busy ? <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" /> : <RiRobot2Line className="size-4" aria-hidden="true" />}
      <span>Autonomous</span>
      <span aria-hidden="true" className={cn("relative h-4 w-7 shrink-0 rounded-full", on ? "bg-primary-contrast/30" : "bg-bg-soft-200")}>
        <span className={cn("absolute top-0.5 size-3 rounded-full shadow-sm transition-all", on ? "left-3.5 bg-primary-contrast" : "left-0.5 bg-static-white")} />
      </span>
    </button>
  );
}

function ProposalCard({ message, run, canManageAutopilot, lastReplyMode, onChanged }: { message: Message; run: Run | undefined; canManageAutopilot: boolean; lastReplyMode: "automatic" | "review" | null; onChanged: () => void }) {
  const data = message.toolResult?.data as ProposalData | undefined;
  // Starts with the mode the owner chose last time (Automatic only for those who may choose it).
  const [mode, setMode] = useState<"automatic" | "review" | null>(lastReplyMode === "automatic" && !canManageAutopilot ? null : lastReplyMode);
  // One Start for the whole request: its other plans (more cities, more searches) start under it.
  const [applyToRequest, setApplyToRequest] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (message.status !== "ok" || !data) return <Card title={TOOL_TITLE.prepare_outreach!} status={message.status}><p>{message.content}</p></Card>;
  const status = run?.status ?? "proposed";
  // Offered only when the request has a rest: other plans, or searches that will make one.
  const requestHasMore = Boolean(data.plan.requestId) && (run?.requestPeers ?? 0) > 0;
  const perChannel = data.plan.assignments.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.channel]: (acc[a.channel] ?? 0) + 1 }), {});

  async function act(action: "start" | "cancel" | "pause" | "resume" | "stop" | "mode", nextMode?: "automatic" | "review") {
    if (action === "stop" && !window.confirm("Stop this run for good? Nothing more is sent for it and no reply is answered automatically. It cannot be resumed.")) return;
    // Automatic widens what Start approved, so it is confirmed with its limits.
    if (action === "mode" && nextMode === "automatic" && !window.confirm(
      `Answer this run's replies automatically? Replies backed by your saved information are checked and sent as soon as the draft is ready; ` +
      `at most ${AUTOPILOT_PER_CONVERSATION} per conversation and ${AUTOPILOT_PER_DAY} in any 24 hours. Everything else still waits for you. Other runs are not affected.`,
    )) return;
    setBusy(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/assistant/runs/${data!.runId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "start" ? { action, mode, applyToRequest: requestHasMore && applyToRequest } : action === "mode" ? { action, mode: nextMode } : { action }),
      }));
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const statusBadge: Record<string, { label: string; color: "gray" | "green" | "orange" | "red" | "blue" }> = {
    proposed: { label: "Waiting for your approval", color: "orange" },
    starting: { label: "Starting", color: "blue" },
    running: { label: "Running", color: "green" },
    paused: { label: "Paused", color: "gray" },
    stopped: { label: "Stopped", color: "gray" },
    completed: { label: "Finished", color: "gray" },
    failed: { label: "Could not start", color: "red" },
    cancelled: { label: "Discarded", color: "gray" },
  };
  const badge = statusBadge[status] ?? { label: status, color: "gray" as const };

  return (
    <div className="w-full max-w-2xl rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-3 shadow-regular-xs sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-label-md text-text-strong-950">Outreach plan: {data.name}</p>
        <Badge.Root variant="lighter" size="medium" color={badge.color}>{badge.label}</Badge.Root>
      </div>
      {run?.authorization && <AuthorizationLine authorization={run.authorization} autopilot={run.autopilot} status={status} />}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-paragraph-sm sm:grid-cols-4">
        <div><dt className="text-paragraph-xs text-text-soft-400">Leads</dt><dd className="text-label-sm text-text-strong-950">{data.plan.assignments.length}</dd></div>
        <div><dt className="text-paragraph-xs text-text-soft-400">Channels</dt><dd className="text-label-sm text-text-strong-950">{Object.entries(perChannel).map(([c, n]) => `${CHANNEL_LABEL[c] ?? c} ${n}`).join(", ")}</dd></div>
        <div><dt className="text-paragraph-xs text-text-soft-400">Takes about</dt><dd className="text-label-sm text-text-strong-950">{data.plan.estimate.days ? `${data.plan.estimate.days} day${data.plan.estimate.days === 1 ? "" : "s"}` : "—"}</dd></div>
        <div><dt className="text-paragraph-xs text-text-soft-400">AI cost</dt><dd className="text-label-sm text-text-strong-950">{data.plan.estimate.aiCostUsd === null ? `${data.plan.estimate.aiCalls} calls` : data.plan.estimate.aiCostUsd < 0.01 ? "< $0.01" : `≈ $${data.plan.estimate.aiCostUsd.toFixed(2)}`}</dd></div>
      </dl>
      <p className="mt-2 text-paragraph-xs text-text-sub-600">
        Daily limits: {[
          data.plan.limits.emailPerMailboxPerDay ? `${data.plan.limits.emailPerMailboxPerDay} emails per mailbox` : null,
          data.plan.limits.whatsappNewChatsPerDay ? `${data.plan.limits.whatsappNewChatsPerDay} new WhatsApp chats per number` : null,
          data.plan.limits.instagramNewChatsPerDay ? `${data.plan.limits.instagramNewChatsPerDay} initial Instagram DMs per account in 24 hours` : null,
        ].filter(Boolean).join(", ") || "the connected channels' limits"}. Sending rules, sending hours and Do Not Contact apply. Sending uses your own accounts.
        {perChannel.instagram ? " Instagram sends one initial DM; replies follow the reply mode you choose." : ""}
      </p>
      {data.plan.excluded.length > 0 && (
        <p className="mt-1 text-paragraph-xs text-text-sub-600">Left out: {data.plan.excluded.slice(0, 3).map((e) => `${e.count} × ${e.reason}`).join("; ")}.</p>
      )}
      {data.plan.groups && data.plan.groups.length > 0 && <SortingSummary plan={data.plan} />}
      <div className="mt-3 space-y-2">
        {data.plan.samples.map((sample, index) => (
          <details key={`${sample.name}-${index}`} open={index === 0} className="rounded-lg bg-bg-weak-50 px-3 py-2">
            <summary className="cursor-pointer text-label-sm text-text-strong-950">
              {sample.approach === "personal" ? "Written for" : "Sample ·"} {sample.name} · {CHANNEL_LABEL[sample.channel] ?? sample.channel}
              {data.plan.groups && data.plan.groups.length > 1 && sample.groupId ? <span className="font-normal text-text-sub-600"> · {data.plan.groups.find((group) => group.id === sample.groupId)?.label}</span> : null}
            </summary>
            <ol className="mt-2 space-y-2">
              {sample.messages.map((msg, step) => (
                <li key={step} className="rounded-md bg-bg-white-0 p-2.5 ring-1 ring-inset ring-stroke-soft-200">
                  <p className="text-paragraph-xs text-text-soft-400">Message {step + 1}{msg.subject ? ` · ${msg.subject}` : ""}</p>
                  <p className="mt-1 whitespace-pre-wrap text-paragraph-sm text-text-strong-950">{msg.body}</p>
                </li>
              ))}
            </ol>
          </details>
        ))}
      </div>
      {status === "proposed" && (
        <div className="mt-3 space-y-2 border-t border-stroke-soft-200 pt-3">
          <p className="text-label-sm text-text-strong-950">How should replies be handled?</p>
          <label className={cn("flex items-start gap-2 rounded-lg p-2 text-paragraph-xs ring-1 ring-inset", mode === "automatic" ? "ring-primary-base" : "ring-stroke-soft-200", !canManageAutopilot && "opacity-60")}>
            <input type="radio" name={`mode-${data.runId}`} className="mt-0.5" checked={mode === "automatic"} disabled={!canManageAutopilot || busy} onChange={() => setMode("automatic")} />
            <span><span className="text-label-xs text-text-strong-950">Automatic.</span> The assistant answers these leads&apos; ordinary replies from your saved information as soon as it has written and checked the answer, at most {AUTOPILOT_PER_CONVERSATION} times per conversation and {AUTOPILOT_PER_DAY} in 24 hours. It never invents prices, discounts, times or promises: questions your information does not answer, complaints, negotiations and meetings come to you here. Opt-outs stop all outreach to that person.{!canManageAutopilot && " Only an owner or admin can choose this."}</span>
          </label>
          <label className={cn("flex items-start gap-2 rounded-lg p-2 text-paragraph-xs ring-1 ring-inset", mode === "review" ? "ring-primary-base" : "ring-stroke-soft-200")}>
            <input type="radio" name={`mode-${data.runId}`} className="mt-0.5" checked={mode === "review"} disabled={busy} onChange={() => setMode("review")} />
            <span><span className="text-label-xs text-text-strong-950">Review.</span> The AI drafts every reply; each waits for you in Action required.</span>
          </label>
          <p className="text-paragraph-xs text-text-soft-400">Either way the first messages and follow-ups go out automatically to these {data.plan.assignments.length} leads only, within the limits above. Adding people, channels or higher limits needs a new plan you approve.</p>
          {requestHasMore && (
            <label className="flex items-start gap-2 rounded-lg p-2 text-paragraph-xs ring-1 ring-inset ring-stroke-soft-200">
              <input type="checkbox" className="mt-0.5" checked={applyToRequest} disabled={busy} onChange={(event) => setApplyToRequest(event.target.checked)} />
              <span><span className="text-label-xs text-text-strong-950">Apply to the rest of this request ({run!.requestPeers} more {run!.requestPeers === 1 ? "plan or search" : "plans or searches"}).</span> The other plans this request makes (more cities or searches, including leads found later) start on their own as soon as they are ready, in this run&apos;s reply mode, on these channels, with up to 100 leads each; you will not be asked again. A plan outside that, or with someone already in another running plan, waits for you with the reason. Pause or stop any of them on its card; pausing or stopping this one ends the approval.</span>
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button.Root variant="neutral" mode="stroke" size="small" disabled={busy} onClick={() => void act("cancel")}>Discard</Button.Root>
            <Button.Root variant="primary" mode="filled" size="small" disabled={busy || !mode} onClick={() => void act("start")}>
              {busy ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : <Button.Icon as={RiPlayLine} />}
              Start outreach
            </Button.Root>
          </div>
        </div>
      )}
      {(status === "running" || status === "paused") && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-stroke-soft-200 pt-3 text-paragraph-xs text-text-sub-600">
          <span className="flex-1">
            <span className="text-label-xs text-text-strong-950">{run?.autopilot ? "Automatic replies" : "Review mode"}.</span>{" "}
            {run?.autopilot ? `Ordinary replies are answered as soon as the answer is written and checked (at most ${AUTOPILOT_PER_CONVERSATION} per conversation, ${AUTOPILOT_PER_DAY} in 24 hours).` : "Replies wait for you in Action required."}{" "}
            {Object.keys(run?.campaigns ?? {}).length ? `Campaigns: ${Object.keys(run!.campaigns).map((c) => CHANNEL_LABEL[c] ?? c).join(", ")}.` : ""}
          </span>
          <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy || (!run?.autopilot && !canManageAutopilot)} onClick={() => void act("mode", run?.autopilot ? "review" : "automatic")}>
            {run?.autopilot ? "Switch to Review" : "Switch to Automatic"}
          </Button.Root>
          <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy} onClick={() => void act(status === "running" ? "pause" : "resume")}>
            <Button.Icon as={status === "running" ? RiPauseLine : RiPlayLine} />
            {status === "running" ? "Pause" : "Resume"}
          </Button.Root>
          <Button.Root variant="error" mode="stroke" size="xsmall" disabled={busy} onClick={() => void act("stop")}>Stop</Button.Root>
        </div>
      )}
      {(status === "running" || status === "paused" || status === "starting") && <SendingStatus runId={data.runId} />}
      {run?.replies && run.replies.length > 0 && <RepliesList replies={run.replies} onChanged={onChanged} />}
      {run?.leads && run.leads.length > 0 && <LeadsList leads={run.leads} />}
      {run?.error && <p className="mt-2 text-paragraph-xs text-error-base">{run.error}</p>}
      {error && <p role="alert" className="mt-2 text-paragraph-xs text-error-base">{error}</p>}
    </div>
  );
}

const dateTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** Who let this plan send, and how; for a plan not started yet, that nothing is sent. */
function AuthorizationLine({ authorization, autopilot, status }: { authorization: RunAuthorization; autopilot: boolean; status: string }) {
  const started = authorization.kind !== "none";
  return (
    <p className="mt-2 text-paragraph-xs text-text-sub-600">
      {authorization.text}
      {started && authorization.at && <> {dateTime(authorization.at)}.</>}
      {authorization.until && <> That approval covers this request&apos;s plans until {dateTime(authorization.until)}.</>}
      {started && status !== "cancelled" && <> Replies: <span className="text-text-strong-950">{autopilot ? "Automatic" : "Review"}</span>.</>}
    </p>
  );
}

/**
 * Each sending account of a running plan, loaded when opened: its configured
 * time zone, what is holding it right now and the earliest time it may send.
 * No recorded gate does not prove a worker is running.
 */
function SendingStatus({ runId }: { runId: string }) {
  const [state, setState] = useState<{ at: string; senders: SenderStatus[]; notCovered: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await readJson(await fetch(`/api/assistant/runs/${runId}/delivery`, { cache: "no-store" })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };
  return (
    <details className="mt-3 border-t border-stroke-soft-200 pt-3 text-paragraph-xs" onToggle={(event) => { if ((event.target as HTMLDetailsElement).open && !state && !loading) void load(); }}>
      <summary className="cursor-pointer text-label-xs text-text-strong-950">Sending status</summary>
      {loading && <p className="mt-1.5 text-text-soft-400">Checking the senders…</p>}
      {error && <p role="alert" className="mt-1.5 text-error-base">{error}</p>}
      {state && (
        <div className="mt-1.5 space-y-2">
          {state.senders.length === 0 && <p className="text-text-sub-600">No sending account is recorded for this plan yet.</p>}
          <ul className="space-y-1.5">
            {state.senders.map((sender) => (
              <li key={`${sender.channel}-${sender.account}`} className="rounded-md bg-bg-weak-50 px-2.5 py-1.5">
                <p className="text-text-strong-950">{CHANNEL_LABEL[sender.channel] ?? sender.channel} · {sender.account}{sender.queued !== null && <span className="text-text-soft-400"> · {sender.queued} waiting</span>}</p>
                <p className="text-text-sub-600">
                  {sender.gates.length ? sender.gates.join("; ") : "No recorded gate is holding it"}.
                  {sender.nextAt && <> Next send allowed {dateTime(sender.nextAt)}.</>}
                  {" "}{sender.timezone ? `Sending hours in ${sender.timezone}.` : "No sending hours set: any time."}
                  {sender.note && <> {sender.note}</>}
                </p>
              </li>
            ))}
          </ul>
          {state.notCovered.length > 0 && <p className="text-text-soft-400">Not covered here: {state.notCovered.map((channel) => CHANNEL_LABEL[channel] ?? channel).join(", ")}.</p>}
          <p className="text-text-soft-400">Checked {timeOf(state.at)} from the recorded settings and queues. It does not prove the sender is running; a send is confirmed only when the provider accepts it.
            {" "}<button type="button" className="underline underline-offset-2" onClick={() => void load()}>Check again</button></p>
        </div>
      )}
    </details>
  );
}

/**
 * An inquiry run's card: what it answers (new Instagram inquiries from Start
 * on, on the accounts listed; never imported history or earlier chats), the
 * Automatic/Review choice and Start, then Pause / Resume / Stop and the
 * replies — the same run controls as an outreach plan.
 */
function InquiryRunCard({ message, run, canManageAutopilot, onChanged }: { message: Message; run: Run | undefined; canManageAutopilot: boolean; onChanged: () => void }) {
  const data = message.toolResult?.data as { runId: string; name: string; plan: { inquiry?: { accounts: { username: string | null }[] } } } | undefined;
  const [mode, setMode] = useState<"automatic" | "review" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (message.status !== "ok" || !data) return <Card title={TOOL_TITLE.prepare_inquiry_replies!} status={message.status}><p>{message.toolResult?.display ?? message.content}</p></Card>;
  const status = run?.status ?? "proposed";
  const accounts = (data.plan.inquiry?.accounts ?? []).map((account) => account.username ? `@${account.username}` : "an Instagram account").join(", ");

  async function act(action: "start" | "cancel" | "pause" | "resume" | "stop" | "mode", nextMode?: "automatic" | "review") {
    if (action === "stop" && !window.confirm("Stop answering new inquiries for good? Replies already sent stay sent; new inquiries then wait for you in Action required.")) return;
    if (action === "mode" && nextMode === "automatic" && !window.confirm(
      `Answer new inquiries automatically? Answers backed by your saved information are checked and sent as soon as they are ready; at most ${AUTOPILOT_PER_CONVERSATION} per conversation and ${AUTOPILOT_PER_DAY} in any 24 hours. Everything else waits for you.`,
    )) return;
    setBusy(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/assistant/runs/${data!.runId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "start" ? { action, mode } : action === "mode" ? { action, mode: nextMode } : { action }),
      }));
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const badge: Record<string, { label: string; color: "gray" | "green" | "orange" | "red" | "blue" }> = {
    proposed: { label: "Waiting for your approval", color: "orange" },
    running: { label: "Answering new inquiries", color: "green" },
    paused: { label: "Paused", color: "gray" },
    stopped: { label: "Stopped", color: "gray" },
    cancelled: { label: "Discarded", color: "gray" },
  };
  const shown = badge[status] ?? { label: status, color: "gray" as const };

  return (
    <div className="w-full max-w-2xl rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-3 shadow-regular-xs sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-label-md text-text-strong-950">{data.name}</p>
        <Badge.Root variant="lighter" size="medium" color={shown.color}>{shown.label}</Badge.Root>
      </div>
      <p className="mt-2 text-paragraph-xs text-text-sub-600">
        Covers people whose first Instagram message arrives after you press Start, on {accounts || "your Instagram accounts that treat new messages as inquiries"}. It sends nothing first, never answers imported history or chats that began earlier, and leaves everyone else to you. Do Not Contact, takeovers and the handoff to you apply as in every run.
      </p>
      {status === "proposed" && (
        <div className="mt-3 space-y-2 border-t border-stroke-soft-200 pt-3">
          <p className="text-label-sm text-text-strong-950">How should these inquiries be answered?</p>
          <label className={cn("flex items-start gap-2 rounded-lg p-2 text-paragraph-xs ring-1 ring-inset", mode === "automatic" ? "ring-primary-base" : "ring-stroke-soft-200", !canManageAutopilot && "opacity-60")}>
            <input type="radio" name={`mode-${data.runId}`} className="mt-0.5" checked={mode === "automatic"} disabled={!canManageAutopilot || busy} onChange={() => setMode("automatic")} />
            <span><span className="text-label-xs text-text-strong-950">Automatic.</span> Ordinary questions are answered from your saved information as soon as the answer is written and checked, at most {AUTOPILOT_PER_CONVERSATION} times per conversation and {AUTOPILOT_PER_DAY} in 24 hours. Anything your information does not cover comes to you.{!canManageAutopilot && " Only an owner or admin can choose this."}</span>
          </label>
          <label className={cn("flex items-start gap-2 rounded-lg p-2 text-paragraph-xs ring-1 ring-inset", mode === "review" ? "ring-primary-base" : "ring-stroke-soft-200")}>
            <input type="radio" name={`mode-${data.runId}`} className="mt-0.5" checked={mode === "review"} disabled={busy} onChange={() => setMode("review")} />
            <span><span className="text-label-xs text-text-strong-950">Review.</span> Every answer is drafted and waits for you in Action required.</span>
          </label>
          <div className="flex justify-end gap-2">
            <Button.Root variant="neutral" mode="stroke" size="small" disabled={busy} onClick={() => void act("cancel")}>Discard</Button.Root>
            <Button.Root variant="primary" mode="filled" size="small" disabled={busy || !mode} onClick={() => void act("start")}>
              {busy ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : <Button.Icon as={RiPlayLine} />}
              Start
            </Button.Root>
          </div>
        </div>
      )}
      {(status === "running" || status === "paused") && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-stroke-soft-200 pt-3 text-paragraph-xs text-text-sub-600">
          <span className="flex-1"><span className="text-label-xs text-text-strong-950">{run?.autopilot ? "Automatic replies" : "Review mode"}.</span> {run?.autopilot ? "Ordinary questions are answered once checked." : "Answers wait for you in Action required."}</span>
          <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy || (!run?.autopilot && !canManageAutopilot)} onClick={() => void act("mode", run?.autopilot ? "review" : "automatic")}>
            {run?.autopilot ? "Switch to Review" : "Switch to Automatic"}
          </Button.Root>
          <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy} onClick={() => void act(status === "running" ? "pause" : "resume")}>
            <Button.Icon as={status === "running" ? RiPauseLine : RiPlayLine} />
            {status === "running" ? "Pause" : "Resume"}
          </Button.Root>
          <Button.Root variant="error" mode="stroke" size="xsmall" disabled={busy} onClick={() => void act("stop")}>Stop</Button.Root>
        </div>
      )}
      {run?.replies && run.replies.length > 0 && <RepliesList replies={run.replies} onChanged={onChanged} />}
      {error && <p role="alert" className="mt-2 text-paragraph-xs text-error-base">{error}</p>}
    </div>
  );
}

/** How the assistant sorted the plan's leads: its kinds (each with its own messages), who is written to alone, and who is left out and why. */
function SortingSummary({ plan }: { plan: ProposalData["plan"] }) {
  const groups = plan.groups ?? [];
  const skipped = plan.skipped ?? [];
  const personal = plan.personal?.length ?? 0;
  return (
    <div className="mt-3 rounded-lg bg-bg-weak-50 px-3 py-2.5 text-paragraph-xs text-text-sub-600">
      <p className="text-label-xs text-text-strong-950">How the assistant sorted these leads</p>
      <ul className="mt-1 space-y-0.5">
        {groups.map((group) => (
          <li key={group.id}><span className="text-text-strong-950">{group.label}</span> · {group.count} lead{group.count === 1 ? "" : "s"}{groups.length > 1 ? " · their own messages" : ""}</li>
        ))}
        {personal > 0 && <li>{personal} with a first message written for them alone (see “Written for” below)</li>}
      </ul>
      {skipped.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-text-strong-950">{skipped.length} left out as not a fit</summary>
          <ul className="mt-1 space-y-0.5">
            {skipped.slice(0, 30).map((item) => <li key={item.personId}>{item.name} — {item.reason}</li>)}
          </ul>
          <p className="mt-1 text-text-soft-400">To contact them too, tell the assistant “include the left-out leads”.</p>
        </details>
      )}
    </div>
  );
}

/** Every lead of a started run and where it stands: waiting, sent, replied (and how), stopped or failed. */
function LeadsList({ leads }: { leads: RunLead[] }) {
  const contacted = leads.filter((lead) => ["sent", "replied", "good"].includes(lead.progress.tone)).length;
  const replied = leads.filter((lead) => ["replied", "good"].includes(lead.progress.tone)).length;
  const interested = leads.filter((lead) => lead.progress.tone === "good").length;
  const tone = { good: "text-success-base", replied: "text-text-strong-950", sent: "text-text-sub-600", waiting: "text-text-soft-400", stopped: "text-text-soft-400", failed: "text-error-base" } as const;
  return (
    <details className="mt-3 border-t border-stroke-soft-200 pt-3 text-paragraph-xs">
      <summary className="cursor-pointer text-label-xs text-text-strong-950">
        Leads · {leads.length} · {contacted} contacted · {replied} replied · {interested} interested
      </summary>
      <ul className="mt-1.5 max-h-72 space-y-1 overflow-y-auto">
        {leads.map((lead) => (
          <li key={`${lead.personId}-${lead.channel}`} className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="min-w-0 truncate text-text-strong-950">{lead.who} <span className="text-text-soft-400">· {CHANNEL_LABEL[lead.channel] ?? lead.channel}</span></span>
            <span className={tone[lead.progress.tone]}>{lead.progress.text}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The latest replies to a run and what became of each, so "why no answer?" is answered on the card. */
function RepliesList({ replies, onChanged }: { replies: RunReply[]; onChanged: () => void }) {
  const tone = { done: "text-success-base", waiting: "text-text-sub-600", you: "text-warning-base", failed: "text-error-base" } as const;
  const [busy, setBusy] = useState<string | null>(null);
  async function release(conversationId: string) {
    setBusy(conversationId);
    try {
      await readJson(await fetch(`/api/assistant/conversations/${conversationId}/release`, { method: "POST" }));
      onChanged();
    } catch (cause) {
      console.error(cause);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="mt-3 border-t border-stroke-soft-200 pt-3">
      <p className="text-label-xs text-text-strong-950">Replies</p>
      <ul className="mt-1.5 space-y-2">
        {replies.map((reply) => (
          <li key={reply.id} className="text-paragraph-xs">
            <p className="text-text-sub-600"><span className="text-label-xs text-text-strong-950">{reply.who}</span> · {CHANNEL_LABEL[reply.channel] ?? reply.channel} · {timeOf(reply.receivedAt)}</p>
            {reply.preview && <p className="mt-0.5 line-clamp-2 border-l-2 border-stroke-sub-300 pl-2 text-text-sub-600">{reply.preview}</p>}
            <p className={cn("mt-0.5", tone[reply.state.tone])}>{reply.state.text}{reply.state.at ? ` ${timeOf(reply.state.at)}` : ""}.</p>
            {reply.state.release && (
              <Button.Root variant="primary" mode="filled" size="xsmall" className="mt-1.5" disabled={busy === reply.conversationId} onClick={() => void release(reply.conversationId)}>
                Let the assistant reply
              </Button.Root>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

type ResultsData = { period: { label: string; timeZone: string }; outreach: Record<string, number>; attention: { repliesWaiting: number; openDecisions: number }; leads: Record<string, number | unknown> };

function ReportCard({ message }: { message: Message }) {
  const data = message.toolResult?.data as { results?: ResultsData; name?: string; status?: string; channels?: { channel: string; contacted: number; messagesSent: number | null; replied: number; finished: number; stopped: number }[] } | undefined;
  if (data?.results) {
    return (
      <Card title={`Results: ${data.results.period.label}`} status={message.status}>
        <p className="whitespace-pre-wrap text-paragraph-xs">{message.content.split("\n").slice(1).join("\n")}</p>
        <Link href="/assistant/results" className="mt-2 inline-flex items-center gap-1 text-label-xs text-primary-base hover:underline">Open the results page <RiExternalLinkLine className="size-3.5" /></Link>
      </Card>
    );
  }
  if (!data?.channels) return <Card title={TOOL_TITLE.report!} status={message.status}><p>{message.content}</p></Card>;
  return (
    <Card title={`Report: ${data.name ?? ""} (${data.status ?? ""})`} status={message.status}>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-paragraph-xs">
          <thead><tr className="text-text-soft-400"><th className="py-1 pr-3 font-normal">Channel</th><th className="pr-3 font-normal">Contacted</th><th className="pr-3 font-normal">Sent</th><th className="pr-3 font-normal">Replied</th><th className="pr-3 font-normal">Finished</th><th className="font-normal">Stopped</th></tr></thead>
          <tbody>
            {data.channels.map((row) => (
              <tr key={row.channel} className="text-text-strong-950"><td className="py-1 pr-3">{CHANNEL_LABEL[row.channel] ?? row.channel}</td><td className="pr-3">{row.contacted}</td><td className="pr-3">{row.messagesSent ?? "—"}</td><td className="pr-3">{row.replied}</td><td className="pr-3">{row.finished}</td><td>{row.stopped}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const DECISION_LABEL: Record<string, string> = {
  missing_info: "Question for you",
  complaint: "Complaint",
  negotiation: "Negotiation",
  commitment: "Promise or price",
  uncertain: "Needs your judgement",
  meeting: "Meeting",
  interested: "Interested lead",
  opt_out: "Opted out",
  ready: "Ready to buy",
  person: "Asked for a person",
  limit: "Chat limit reached",
};

function DecisionCard({ message, state, onChanged }: { message: Message; state: DecisionState | undefined; onChanged: () => void }) {
  const data = message.toolResult?.data as { decisionId: string; kind: string; reason: string; decision: string; leadMessage: string | null; crmRecordId: string | null } | undefined;
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!data) return <Card title={TOOL_TITLE.owner_decision!} status={message.status}><p>{message.content}</p></Card>;
  const report = data.kind === "interested" || data.kind === "opt_out";
  // A ready lead, one asking for a person, or a complaint needs you to contact them, not an answer to save.
  const answerable = takesAnAnswer(data.kind as OwnerDecisionKind) || data.kind === "uncertain";
  const status = state?.status ?? (report ? "resolved" : "open");

  async function act(action: "answer" | "resolve" | "takeover") {
    setBusy(true);
    setError(null);
    try {
      const result = await readJson<{ rewritten?: boolean; problem?: string | null }>(await fetch(`/api/assistant/decisions/${data!.decisionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "answer" ? { action, answer } : { action }),
      }));
      if (action === "answer") setNote(result.rewritten ? "Saved. The waiting reply was rewritten with your answer and is checked again." : result.problem ? `Saved, but the reply could not be rewritten: ${result.problem}` : "Saved for later conversations.");
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("w-full max-w-2xl rounded-xl border p-3 text-paragraph-sm sm:p-4", report ? "border-stroke-soft-200 bg-bg-white-0" : status === "open" ? "border-warning-base bg-bg-white-0" : "border-stroke-soft-200 bg-bg-weak-50")}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-label-sm text-text-strong-950">{DECISION_LABEL[data.kind] ?? "Needs your decision"}</p>
        {!report && <Badge.Root variant="lighter" size="small" color={status === "open" ? "orange" : "gray"}>{status === "open" ? "Waiting for you" : status === "answered" ? "Answered" : "Done"}</Badge.Root>}
      </div>
      <p className="mt-1 text-text-strong-950">{data.reason}</p>
      {data.leadMessage && <blockquote className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap border-l-2 border-stroke-sub-300 pl-2 text-paragraph-xs text-text-sub-600">{data.leadMessage}</blockquote>}
      <p className="mt-2 text-paragraph-xs text-text-sub-600">{data.decision}</p>
      {state?.answer && <p className="mt-1 text-paragraph-xs text-text-sub-600">Your answer: {state.answer}</p>}
      {!report && status === "open" && (
        <div className="mt-2 space-y-2">
          {answerable && <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={2} placeholder="Your answer (saved for later replies)…" aria-label="Your answer" className="w-full resize-y rounded-lg bg-bg-weak-50 px-2.5 py-2 text-paragraph-sm text-text-strong-950 outline-none ring-1 ring-inset ring-stroke-soft-200 focus:ring-primary-base" />}
          <div className="flex flex-wrap justify-end gap-2">
            {data.crmRecordId && <Link href={`/crm/records/${data.crmRecordId}`} className="inline-flex items-center gap-1 self-center text-label-xs text-primary-base hover:underline">Open conversation <RiExternalLinkLine className="size-3.5" /></Link>}
            <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy} onClick={() => void act("takeover")}>I&apos;ll reply myself</Button.Root>
            <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={busy} onClick={() => void act("resolve")}>{answerable ? "Dismiss" : "Done"}</Button.Root>
            {answerable && <Button.Root variant="primary" mode="filled" size="xsmall" disabled={busy || !answer.trim()} onClick={() => void act("answer")}>Save answer</Button.Root>}
          </div>
        </div>
      )}
      {note && <p role="status" className="mt-2 text-paragraph-xs text-success-base">{note}</p>}
      {error && <p role="alert" className="mt-2 text-paragraph-xs text-error-base">{error}</p>}
    </div>
  );
}

/** Small, routine results shown as one quiet line instead of a card. */
const COMPACT_TOOLS = new Set([
  "check_setup", "save_business_info", "search_knowledge", "lead_search_status", "list_audiences", "list_runs",
  "list_decisions", "pause_outreach", "resume_outreach", "stop_outreach", "switch_to_review", "answer_decision", "read_webpage", "list_inquiries",
]);

function ActivityRow({ message }: { message: Message }) {
  const title = TOOL_TITLE[message.tool ?? ""] ?? message.tool ?? "Action";
  const detail = message.status === "running" ? "" : message.toolResult?.display ?? message.content;
  return (
    <details className="group w-full max-w-2xl text-paragraph-xs text-text-sub-600">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg py-1 hover:text-text-strong-950 [&::-webkit-details-marker]:hidden">
        <StatusIcon status={message.status} />
        <span className={cn("text-label-xs", message.status === "error" ? "text-error-base" : "text-text-sub-600")}>{title}</span>
        {detail && <span className="min-w-0 flex-1 truncate text-text-soft-400 group-open:hidden">· {detail}</span>}
      </summary>
      {detail && <p className={cn("ml-6 mt-0.5 whitespace-pre-wrap", message.status === "error" && "text-error-base")}>{detail}</p>}
    </details>
  );
}

function ToolMessage({ message, jobs, runs, decisions, canManageAutopilot, lastReplyMode, onChanged }: { message: Message; jobs: Job[]; runs: Record<string, Run>; decisions: Record<string, DecisionState>; canManageAutopilot: boolean; lastReplyMode: "automatic" | "review" | null; onChanged: () => void }) {
  const data = message.toolResult?.data as Record<string, unknown> | undefined;
  if (message.tool === "owner_decision") return <DecisionCard message={message} state={decisions[String(data?.decisionId ?? "")]} onChanged={onChanged} />;
  if (message.tool === "daily_summary") {
    return <Card title={`Daily summary · ${String(data?.day ?? "")}`} status={message.status}><p className="whitespace-pre-wrap text-paragraph-xs">{message.content.split("\n").slice(1).join("\n")}</p></Card>;
  }
  if (message.tool === "find_leads" || message.tool === "find_linkedin_leads" || message.tool === "find_customers_on_web" || message.tool === "find_instagram_prospects" || message.tool === "find_social_leads") return <DiscoveryCard message={message} job={jobs.find((job) => job.id === data?.jobId)} />;
  if (message.tool === "prepare_outreach") return <ProposalCard message={message} run={runs[String(data?.runId ?? "")]} canManageAutopilot={canManageAutopilot} lastReplyMode={lastReplyMode} onChanged={onChanged} />;
  if (message.tool === "prepare_inquiry_replies") return <InquiryRunCard message={message} run={runs[String(data?.runId ?? "")]} canManageAutopilot={canManageAutopilot} onChanged={onChanged} />;
  if (message.tool === "report") return <ReportCard message={message} />;
  if (COMPACT_TOOLS.has(message.tool ?? "")) return <ActivityRow message={message} />;
  const title = message.tool === "read_document" || message.tool === "import_contacts"
    ? `${TOOL_TITLE[message.tool]}: ${String(message.toolInput?.file ?? "")}`
    : TOOL_TITLE[message.tool ?? ""] ?? message.tool ?? "Action";
  const audience = message.tool === "import_contacts" || message.tool === "add_contacts" || message.tool === "add_instagram_contacts" || message.tool === "use_existing_leads" ? (data?.audience as AudienceData | undefined) : message.tool === "describe_audience" ? (data as AudienceData | undefined) : undefined;
  const audienceId = typeof data?.audienceId === "string" ? data.audienceId : message.tool === "describe_audience" && typeof data?.id === "string" ? data.id : null;
  return (
    <Card title={title} status={message.status}>
      {message.status === "running" ? null : audience && message.status === "ok" ? (
        <>
          {message.tool === "import_contacts" && <p className="text-paragraph-xs">{message.content.split(". Lead list")[0]}.</p>}
          {(message.tool === "add_contacts" || message.tool === "add_instagram_contacts" || message.tool === "use_existing_leads") && message.toolResult?.display && <p className="text-paragraph-xs">{message.toolResult.display}</p>}
          <AudienceSummary audience={audience} />
          {audienceId && <ProspectsList audienceId={audienceId} />}
        </>
      ) : (
        <p className={cn("whitespace-pre-wrap text-paragraph-xs", message.status === "error" && "text-error-base")}>{message.toolResult?.display ?? message.content}</p>
      )}
    </Card>
  );
}

/** The assistant's words: paragraphs, simple lists, links and **bold**, without rendering HTML. */
function RichText({ text }: { text: string }) {
  const inline = (line: string, key: string) => line.split(/(\*\*[^*]+\*\*|https?:\/\/[^\s)]+)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={`${key}-${index}`} className="font-medium text-text-strong-950">{part.slice(2, -2)}</strong>;
    if (/^https?:\/\//.test(part)) return <a key={`${key}-${index}`} href={part} target="_blank" rel="noopener noreferrer" className="text-primary-base underline-offset-2 hover:underline">{hostOf(part)}</a>;
    return <span key={`${key}-${index}`}>{part}</span>;
  });
  return (
    <div className="space-y-3 leading-7 [overflow-wrap:anywhere]">
      {text.trim().split(/\n{2,}/).map((block, blockIndex) => {
        const lines = block.split("\n");
        const listItem = /^\s*(?:[-•*]|\d+[.)])\s+/;
        if (lines.length > 1 && lines.every((line) => listItem.test(line))) {
          const ordered = /^\s*\d/.test(lines[0]!);
          const List = ordered ? "ol" : "ul";
          return (
            <List key={blockIndex} className={cn("space-y-1 pl-5", ordered ? "list-decimal" : "list-disc")}>
              {lines.map((line, index) => <li key={index}>{inline(line.replace(listItem, ""), `${blockIndex}-${index}`)}</li>)}
            </List>
          );
        }
        return <p key={blockIndex} className="whitespace-pre-wrap">{inline(block, String(blockIndex))}</p>;
      })}
    </div>
  );
}

function AssistantAvatar({ size = "sm" }: { size?: "sm" | "lg" }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-primary-base text-primary-contrast shadow-regular-xs", size === "lg" ? "size-12" : "size-7")} aria-hidden="true">
      <RiSparkling2Fill className={size === "lg" ? "size-6" : "size-3.5"} />
    </span>
  );
}

function ThinkingIndicator({ label }: { label: string }) {
  return (
    <p role="status" data-testid="assistant-thinking" className="flex items-center gap-2 text-paragraph-xs text-text-soft-400">
      <span className="flex gap-1" aria-hidden="true">
        {[0, 150, 300].map((delay) => <span key={delay} className="size-1.5 animate-bounce rounded-full bg-text-soft-400" style={{ animationDelay: `${delay}ms` }} />)}
      </span>
      {label}
    </p>
  );
}

type SetupItem = { label: string; ok: boolean; detail: string; href: string; operator: boolean };

function setupItems(setup: Setup): SetupItem[] {
  return [
    { label: "AI", ok: setup.ai.connected, detail: setup.ai.connected ? "Connected" : "Not set up on this server yet", href: "/settings/ai", operator: true },
    { label: "Lead search", ok: setup.leadDiscovery.available, detail: setup.leadDiscovery.available ? "Google Maps ready" : "Not enabled on this server; contact lists still work", href: "/getting-started", operator: true },
    ...(["email", "whatsapp", "linkedin", ...(setup.features?.instagram ? ["instagram" as const] : [])] as const).map((channel) => ({
      label: CHANNEL_LABEL[channel]!,
      ok: setup.channels[channel].available,
      detail: setup.channels[channel].available ? `${setup.channels[channel].senders} connected` : setup.channels[channel].reason ?? "Not connected",
      href: channel === "email" ? "/settings/email-accounts" : channel === "whatsapp" ? "/settings/whatsapp-accounts" : channel === "linkedin" ? "/settings/linkedin-accounts" : "/settings/instagram-accounts",
      operator: false,
    })),
  ];
}

function ReadinessMenu({ setup }: { setup: Setup | null }) {
  if (!setup) return null;
  const items = setupItems(setup);
  const missing = items.filter((item) => !item.ok).length;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200 hover:bg-bg-weak-50">
          <span className={cn("size-2 rounded-full", missing ? "bg-warning-base" : "bg-success-base")} aria-hidden="true" />
          {missing ? `${missing} to set up` : "Setup ready"}
        </button>
      </Popover.Trigger>
      <Popover.Content align="end" showArrow={false} sideOffset={8} className="w-80 max-w-[calc(100vw-2rem)] p-3">
        <p className="text-label-sm text-text-strong-950">What the assistant can use</p>
        <ul className="mt-2 space-y-1.5">
          {items.map((item) => (
            <li key={item.label} className="flex items-start gap-2 text-paragraph-xs">
              {item.ok ? <RiCheckboxCircleFill className="mt-px size-4 shrink-0 text-success-base" /> : <RiErrorWarningFill className="mt-px size-4 shrink-0 text-warning-base" />}
              <span className="min-w-0 flex-1">
                <span className="text-label-xs text-text-strong-950">{item.label}</span>
                <span className="block text-text-sub-600">{item.detail}{!item.ok && item.operator ? " (set up by whoever runs the server)" : ""}</span>
              </span>
              {!item.ok && <Link href={item.href} className="shrink-0 text-label-xs text-primary-base hover:underline">Set up</Link>}
            </li>
          ))}
        </ul>
      </Popover.Content>
    </Popover.Root>
  );
}

function ConversationMenu({ current, threads, onOpen, onNew, disabled }: { current: { id: string; title: string }; threads: AssistantStatePayload["threads"]; onOpen: (id: string) => void; onNew: () => void; disabled: boolean }) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button type="button" disabled={disabled} aria-label="Conversation history" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-label-xs text-text-sub-600 hover:bg-bg-weak-50 disabled:opacity-50">
          <RiHistoryLine className="size-4" aria-hidden="true" />
          <span>History</span>
          <RiArrowDownSLine className="size-3.5 shrink-0 text-text-soft-400" aria-hidden="true" />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Content align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        <Dropdown.Item onSelect={onNew}><Dropdown.ItemIcon as={RiAddLine} />New conversation</Dropdown.Item>
        {threads.length > 0 && <Dropdown.Separator />}
        <div className="max-h-80 overflow-y-auto">
          {threads.map((thread) => (
            <Dropdown.Item key={thread.id} onSelect={() => onOpen(thread.id)} className={cn(thread.id === current.id && "bg-bg-weak-50")}>
              <span className="min-w-0 flex-1 truncate">{displayThreadTitle(thread.title)}</span>
              <span className="shrink-0 text-paragraph-xs text-text-soft-400">{relativeTime(thread.updatedAt)}</span>
            </Dropdown.Item>
          ))}
        </div>
      </Dropdown.Content>
    </Dropdown.Root>
  );
}

function relativeTime(value: string | Date): string {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

type Starter = { icon: React.ComponentType<{ className?: string }>; title: string; description: string; text: string; send?: boolean; attach?: boolean };

function starters(profile: BusinessProfileSummary | undefined): Starter[] {
  const known = Boolean(profile?.businessName && profile.offer);
  const who = profile?.targetCustomers?.split(/[,.;]/)[0]?.trim();
  const where = profile?.locations?.split(/[,.;]/)[0]?.trim();
  return [
    known
      ? { icon: RiStore2Line, title: "Update my business details", description: "Change what you sell, prices, area or who signs the messages.", text: "Update my business details: " }
      : { icon: RiStore2Line, title: "Tell me about your business", description: "What you sell, to whom, where, and who signs the messages.", text: "We are … We sell … to … in … Sign the messages as …" },
    { icon: RiFileList3Line, title: "Use my existing leads or inquiries", description: "People already in your leads, new inquiries, or a CSV or Excel list (Attach, below). I write the messages; you approve.", text: "Contact my existing leads: " },
    { icon: RiSearchEyeLine, title: "Find potential customers for me", description: "Optional: I search public listings and websites for businesses that match, then show you a plan to approve.", text: who && where ? `Find ${who} in ${where} and contact them` : "Find … in … and contact them" },
    { icon: RiBarChartBoxLine, title: "How is my outreach doing?", description: "Leads, messages, replies, and what is waiting for you.", text: "How is my outreach doing?", send: true },
  ];
}

type BusinessProfileSummary = { businessName?: string; offer?: string; targetCustomers?: string; locations?: string };

function Welcome({ firstName, profile, onStarter }: { firstName: string | null; profile: BusinessProfileSummary | undefined; onStarter: (starter: Starter) => void }) {
  return (
    <div className="assistant-welcome mx-auto flex w-full max-w-2xl flex-col items-center py-4 text-center sm:pt-[4vh]">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-soft-400">{firstName ? `Your workspace, ${firstName}` : "Your outreach workspace"}</p>
      <h2 className="mt-5 text-[clamp(30px,3.5vw,46px)] font-medium leading-[1.1] tracking-[-0.045em] text-text-strong-950">Let’s make your next<br /><span className="font-instrument-serif text-[1.15em] italic font-normal">connection.</span></h2>
      <p className="mt-4 max-w-lg text-paragraph-sm leading-relaxed text-text-sub-600">
        Find the right people{profile?.businessName ? ` for ${profile.businessName}` : ""}, shape your outreach, and keep conversations moving. What would you like to work on?
      </p>
      <div className="mt-8 grid w-full gap-3 text-left sm:grid-cols-2">
        {starters(profile).map((starter) => (
          <button key={starter.title} type="button" onClick={() => onStarter(starter)} className="group flex items-start gap-3 rounded-xl bg-bg-white-0 p-4 text-left ring-1 ring-inset ring-stroke-soft-200 transition duration-200 hover:bg-bg-weak-50 hover:ring-stroke-sub-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-base">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-stroke-soft-200 text-text-strong-950 transition group-hover:bg-bg-strong-950 group-hover:text-text-white-0"><starter.icon className="size-4" /></span>
            <span className="min-w-0">
              <span className="block text-label-sm text-text-strong-950">{starter.title}</span>
              <span className="mt-1 block text-paragraph-xs leading-relaxed text-text-sub-600">{starter.description}</span>
            </span>
          </button>
        ))}
      </div>
      {!profile?.businessName && <p className="mt-4 text-paragraph-xs text-text-soft-400">Start by telling me about your business, or attach a brochure or price list. I remember it for every conversation.</p>}
    </div>
  );
}

/** Groups the thread into the owner's messages and the assistant's turns (its words, actions and cards together). */
function groupTurns(messages: Message[]): { owner: Message | null; items: Message[] }[] {
  const turns: { owner: Message | null; items: Message[] }[] = [];
  for (const message of messages) {
    if (message.role === "user") turns.push({ owner: message, items: [] });
    else if (turns.length) turns[turns.length - 1]!.items.push(message);
    else turns.push({ owner: null, items: [message] });
  }
  return turns;
}

export default function AssistantClient({ initial }: { initial: AssistantStatePayload }) {
  const [state, setState] = useState(initial);
  const [setup, setSetup] = useState<Setup | null>(initial.setup);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** The message being sent, shown until the polled thread holds it (`baseline`: messages before it). */
  const [pending, setPending] = useState<{ text: string; files: string[]; baseline: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const threadId = state.thread.id;

  const refresh = useCallback(async (withSetup = false) => {
    try {
      const next = await readJson<AssistantStatePayload>(await fetch(`/api/assistant?threadId=${threadId}${withSetup ? "&setup=1" : ""}`, { cache: "no-store" }));
      setState(next);
      if (next.setup) setSetup(next.setup);
    } catch {
      // A failed poll is retried by the next one.
    }
  }, [threadId]);

  const working = sending || state.busy || state.jobs.some((job) => job.status === "queued" || job.status === "running") || Object.values(state.runs).some((run) => run.status === "starting");
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void refresh(false), 2_000);
    return () => clearInterval(timer);
  }, [working, refresh]);

  // While a run is live, replies, answers and decisions arrive on their own: show them within seconds
  // (the reply agent answers in a few seconds; a slower refresh made instant answers look slow).
  const live = Object.values(state.runs).some((run) => run.status === "running" || run.status === "paused");
  useEffect(() => {
    if (working || !live) return;
    const timer = setInterval(() => void refresh(false), 4_000);
    return () => clearInterval(timer);
  }, [working, live, refresh]);

  const showPending = pending !== null && !state.messages.slice(pending.baseline).some((message) => message.role === "user");
  const count = state.messages.length + (showPending ? 1 : 0);
  const { scroller, content, showLatest, updatePosition, jumpToLatest } = useChatScroll(threadId, count);

  // The message box grows with what is typed, up to about eight lines.
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  function addFiles(picked: File[]) {
    setFiles((current) => [...current, ...picked].slice(0, 5));
  }

  async function send(value = text) {
    const message = value.trim();
    if ((!message && !files.length) || sending || state.busy) return;
    const submittedFiles = files;
    jumpToLatest();
    setSending(true);
    setError(null);
    setPending({ text: message, files: files.map((file) => file.name), baseline: state.messages.length });
    const form = new FormData();
    form.set("threadId", threadId);
    form.set("text", message);
    for (const file of files) form.append("files", file);
    setText("");
    setFiles([]);
    try {
      const response = await fetch("/api/assistant/messages", { method: "POST", body: form });
      if (response.status === 409) {
        // A background turn can claim the thread between polling and Send.
        // Keep the unsent draft; a busy thread is ordinary progress.
        setText(message);
        setFiles(submittedFiles);
        setState((previous) => ({ ...previous, busy: true }));
        await refresh(false);
        return;
      }
      const next = await readJson<AssistantStatePayload>(response);
      setState((previous) => ({ ...next, setup: previous.setup }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh(false);
    } finally {
      setPending(null);
      setSending(false);
      input.current?.focus();
    }
  }

  /** Takes the turn again for the owner's latest request after the model could not finish it. */
  async function retryTurn() {
    if (sending || state.busy) return;
    jumpToLatest();
    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/assistant/threads/retry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId }) });
      if (response.status === 409) {
        setState((previous) => ({ ...previous, busy: true }));
        await refresh(false);
        return;
      }
      const next = await readJson<AssistantStatePayload>(response);
      setState((previous) => ({ ...next, setup: previous.setup }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh(false);
    } finally {
      setSending(false);
    }
  }

  function pickStarter(starter: Starter) {
    if (starter.send) {
      void send(starter.text);
      return;
    }
    setText(starter.text);
    if (starter.attach) fileInput.current?.click();
    requestAnimationFrame(() => {
      const element = input.current;
      if (!element) return;
      element.focus();
      const blank = starter.text.indexOf("…");
      if (blank >= 0) element.setSelectionRange(blank, blank + 1);
      else element.setSelectionRange(starter.text.length, starter.text.length);
    });
  }

  async function newThread() {
    const created = await readJson<{ threadId: string }>(await fetch("/api/assistant/threads", { method: "POST" }));
    const next = await readJson<AssistantStatePayload>(await fetch(`/api/assistant?threadId=${created.threadId}`, { cache: "no-store" }));
    setState(next);
    setText("");
    input.current?.focus();
  }

  async function openThread(id: string) {
    const next = await readJson<AssistantStatePayload>(await fetch(`/api/assistant?threadId=${id}`, { cache: "no-store" }));
    setState(next);
  }

  // Calls the server refused before doing anything are the model's own mistakes: kept for it, not shown.
  const shown = useMemo(() => state.messages.filter((message) => !message.toolResult?.hidden), [state.messages]);
  const turns = useMemo(() => groupTurns(shown), [shown]);
  const last = shown[shown.length - 1];
  const thinking = sending || state.busy;
  const runningTool = [...shown].reverse().find((message) => message.role === "tool" && message.status === "running");
  const thinkingLabel = runningTool ? `${TOOL_TITLE[runningTool.tool ?? ""] ?? "Working"}…` : "Thinking…";
  const suggestions = !thinking && last?.role === "assistant" ? last.toolResult?.suggestions ?? [] : [];
  const empty = state.messages.length === 0 && !showPending;
  const profile = (setup as (Setup & { profile?: BusinessProfileSummary }) | null)?.profile;

  const assistantItems = (items: Message[]) => items.map((message) => {
    if (message.role === "assistant") return <div key={message.id} className="text-paragraph-sm text-text-strong-950"><RichText text={message.content} /></div>;
    if (message.role === "event") {
      // Only the newest event can offer Retry: an older failure was already followed by more work.
      const retry = message.toolResult?.data?.retry === true && message.id === shown.at(-1)?.id;
      return (
        <div key={message.id} className="flex items-start gap-2 rounded-lg bg-bg-weak-50 px-3 py-2 text-paragraph-xs text-text-sub-600">
          <RiInformationLine className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{message.content}</span>
          {retry && (
            <Button.Root variant="neutral" mode="stroke" size="xxsmall" className="shrink-0" disabled={sending || state.busy} onClick={() => void retryTurn()}>
              Retry
            </Button.Root>
          )}
        </div>
      );
    }
    return <ToolMessage key={message.id} message={message} jobs={state.jobs} runs={state.runs} decisions={state.decisions ?? {}} canManageAutopilot={Boolean(setup?.canManageAutopilot)} lastReplyMode={state.lastReplyMode ?? null} onChanged={() => void refresh(true)} />;
  });

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-bg-white-0"
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 border-b border-stroke-soft-200 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <AssistantAvatar />
          <div className="min-w-0"><h1 className="text-label-md text-text-strong-950">Assistant</h1><p className="mt-0.5 truncate text-paragraph-xs text-text-soft-400">{displayThreadTitle(state.thread.title)}</p></div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:order-last">
          <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => void newThread()} disabled={sending} aria-label="New conversation" className="h-9">
            <Button.Icon as={RiAddLine} />New chat
          </Button.Root>
          <Link href="/assistant/results" aria-label="Outreach results" title="Outreach results" className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-label-xs text-text-sub-600 hover:bg-bg-weak-50">
            <RiBarChartBoxLine className="size-4" aria-hidden="true" /><span className="hidden sm:inline">Results</span>
          </Link>
        </div>
        <div className="flex w-full flex-wrap items-center gap-1.5 border-t border-stroke-soft-200 pt-2 sm:ml-auto sm:w-auto sm:border-0 sm:pt-0">
          <ConversationMenu current={state.thread} threads={state.threads} onOpen={(id) => void openThread(id)} onNew={() => void newThread()} disabled={sending} />
          <AutonomousSwitch thread={state.thread} canManage={Boolean(setup?.canManageAutopilot)} onChanged={(next) => setState(next)} />
          <ReadinessMenu setup={setup} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
      <div className="relative flex min-w-0 flex-1 flex-col">
      <div className="shrink-0 px-4 pt-3 empty:hidden sm:px-6">
        <NeedsYouList initial={null} compact />
      </div>

      <div ref={scroller} onScroll={updatePosition} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-8" aria-label="Assistant conversation">
        <div ref={content}>
        {empty ? (
          <Welcome firstName={state.viewer?.firstName ?? null} profile={profile} onStarter={pickStarter} />
        ) : (
          <div role="log" aria-live="polite" className="mx-auto flex max-w-3xl flex-col gap-8">
            {turns.map((turn, index) => (
              <div key={turn.owner?.id ?? `turn-${index}`} className="flex flex-col gap-3">
                {turn.owner && (
                  <div className="flex flex-col items-end gap-2">
                    <span className="px-1 text-[11px] text-text-soft-400" suppressHydrationWarning>You · {new Date(turn.owner.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                    {turn.owner.content && <div className="max-w-[min(36rem,90%)] whitespace-pre-wrap rounded-2xl rounded-br-md bg-bg-weak-50 px-4 py-3 text-paragraph-sm leading-6 text-text-strong-950 [overflow-wrap:anywhere]">{turn.owner.content}</div>}
                    {turn.owner.attachments.map((file) => (
                      <span key={file.name} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-paragraph-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">
                        {file.kind === "contacts" ? <RiTableLine className="size-3.5" /> : <RiFileTextLine className="size-3.5" />}
                        {file.name}
                      </span>
                    ))}
                  </div>
                )}
                {(turn.items.length > 0 || (thinking && index === turns.length - 1 && !showPending)) && (
                  <div className="flex gap-3">
                    <AssistantAvatar />
                    <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-0.5">
                      <span className="text-label-xs text-text-sub-600">Assistant</span>
                      {assistantItems(turn.items)}
                      {thinking && index === turns.length - 1 && !showPending && <ThinkingIndicator label={thinkingLabel} />}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {showPending && pending && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col items-end gap-1">
                  {pending.text && <div className="max-w-[min(36rem,90%)] whitespace-pre-wrap rounded-2xl rounded-br-md bg-bg-weak-50 px-4 py-3 text-paragraph-sm leading-6 text-text-strong-950 [overflow-wrap:anywhere]">{pending.text}</div>}
                  {pending.files.map((name) => <span key={name} className="text-paragraph-xs text-text-sub-600">{name}</span>)}
                </div>
                <div className="flex gap-3"><AssistantAvatar /><div className="pt-1.5"><ThinkingIndicator label={pending.files.length ? "Reading your files…" : "Thinking…"} /></div></div>
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-2 pl-10">
                {suggestions.map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => void send(suggestion)} className="rounded-full px-3 py-1.5 text-label-xs text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-weak-50 hover:ring-stroke-sub-300">
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        </div>
      </div>

      <div className="relative shrink-0 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-4">
        {showLatest && <button type="button" onClick={jumpToLatest} className="absolute -top-11 left-1/2 inline-flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-stroke-soft-200 bg-bg-white-0 px-3.5 py-2 text-label-xs text-text-strong-950 shadow-regular-sm outline-none hover:bg-bg-weak-50 focus-visible:ring-2 focus-visible:ring-primary-base"><RiArrowDownLine className="size-4" aria-hidden="true" />Jump to latest</button>}
        <div className="mx-auto max-w-3xl">
          {error && <p role="alert" className="mb-2 text-paragraph-xs text-error-base">{error}</p>}
          {state.busy && !sending && <p role="status" className="mb-2 text-paragraph-xs text-text-sub-600">Working on the previous step. You can draft your next message here.</p>}
          <div className="rounded-[20px] bg-bg-white-0 shadow-[0_4px_24px_-10px_rgba(0,0,0,0.15)] ring-1 ring-inset ring-stroke-sub-300 transition focus-within:ring-primary-base">
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                {files.map((file) => (
                  <span key={`${file.name}-${file.size}`} className="inline-flex items-center gap-1.5 rounded-lg bg-bg-weak-50 py-1 pl-2 pr-1 text-label-xs text-text-sub-600">
                    {/\.(csv|tsv|xlsx?)$/i.test(file.name) ? <RiTableLine className="size-3.5" /> : <RiFileTextLine className="size-3.5" />}
                    <span className="max-w-[12rem] truncate">{file.name}</span>
                    <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))} className="rounded p-0.5 hover:bg-bg-soft-200"><RiCloseLine className="size-3.5" /></button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={input}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
              onPaste={(event) => {
                const pasted = Array.from(event.clipboardData.files);
                if (pasted.length) { event.preventDefault(); addFiles(pasted); }
              }}
              rows={1}
              placeholder={empty ? "What would you like to work on?" : "Ask a follow-up, or give the next instruction…"}
              aria-label="Message the assistant"
              disabled={sending}
              className="block max-h-52 min-h-[72px] w-full resize-none bg-transparent px-4 pb-2 pt-4 text-[16px] leading-6 text-text-strong-950 outline-none placeholder:text-text-soft-400 sm:text-paragraph-sm"
            />
            <div className="flex items-center gap-2 px-2 pb-2">
              <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }} />
              <button type="button" onClick={() => fileInput.current?.click()} disabled={sending} title="Attach a PDF, Word or text document, or a CSV/Excel contact list" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-label-xs text-text-sub-600 hover:bg-bg-weak-50 disabled:opacity-50">
                <RiAttachment2 className="size-4" aria-hidden="true" /><span>Attach</span>
              </button>
              <span className="hidden flex-1 truncate text-[11px] text-text-soft-400 sm:block">Enter to send · Shift + Enter for a new line</span>
              <Button.Root variant="primary" mode="filled" size="small" onClick={() => void send()} disabled={thinking || (!text.trim() && !files.length)} aria-label="Send" className="ml-auto size-9 rounded-xl p-0">
                {sending ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : <Button.Icon as={RiArrowUpLine} />}
              </Button.Root>
            </div>
          </div>
          <p className="mt-2 text-center text-paragraph-xs text-text-soft-400">
            {state.thread.autonomous
              ? `Autonomous: plans start on their own in Automatic mode, up to ${state.thread.autonomyCaps?.runsPerDay ?? "?"} plans and ${state.thread.autonomyCaps?.leadsPerDay ?? "?"} leads a day. Turn it off at the top to review each plan.`
              : "Nothing reaches your leads until you press Start on a plan."}
            <span className="hidden sm:inline"> Replies waiting for you are in <Link href="/crm/actions" className="underline underline-offset-2 hover:text-text-sub-600">Action required</Link>.</span>
          </p>
        </div>
      </div>

      </div>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary-base bg-bg-white-0 text-label-md text-primary-base">
          Drop documents or a contact list to attach
        </div>
      )}
    </div>
  );
}
