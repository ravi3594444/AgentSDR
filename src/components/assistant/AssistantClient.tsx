"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  RiAddLine,
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
  RiLoader4Line,
  RiPauseLine,
  RiPlayLine,
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
import { AUTOPILOT_LIMITS } from "@/lib/crm/autopilot";
import * as Button from "@/components/alignui/button";
import NeedsYouList from "@/components/assistant/NeedsYouList";
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
  kind: "discovery" | "outreach_start" | "linkedin_search";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  audienceId: string | null;
  runId: string | null;
};

type RunReply = { id: string; who: string; channel: string; receivedAt: string; preview: string; state: { tone: "done" | "waiting" | "you" | "failed"; text: string; at?: string } };

type RunLead = { personId: string; who: string; channel: string; progress: { tone: "waiting" | "sent" | "replied" | "good" | "stopped" | "failed"; text: string } };

type Run = { id: string; status: string; autopilot: boolean; error: string | null; campaigns: Record<string, string>; replies?: RunReply[]; leads?: RunLead[] };

type DecisionState = { status: "open" | "answered" | "resolved"; answer: string | null };

type ChannelStatus = { available: boolean; reason: string | null; senders: number };

type Setup = {
  channels: Record<"email" | "whatsapp" | "linkedin", ChannelStatus>;
  leadDiscovery: { available: boolean; reason: string | null };
  ai: { connected: boolean };
  automaticRuns: number;
  canManageAutopilot: boolean;
  missingForDiscovery: string[];
  missingForOutreach: string[];
};

export type AssistantStatePayload = {
  thread: { id: string; title: string };
  viewer?: { firstName: string | null };
  threads: { id: string; title: string; updatedAt: string | Date }[];
  busy: boolean;
  messages: Message[];
  jobs: Job[];
  runs: Record<string, Run>;
  decisions: Record<string, DecisionState>;
  setup: Setup | null;
};

const ACCEPT = ".pdf,.docx,.txt,.md,.csv,.tsv,.xlsx,.xls";
// The reply limits the server enforces (src/lib/crm/autopilot.ts), shown before Start.
const AUTOPILOT_DELAY_MINUTES = AUTOPILOT_LIMITS.delayMinutes;
const AUTOPILOT_PER_CONVERSATION = AUTOPILOT_LIMITS.perConversation;
const AUTOPILOT_PER_DAY = AUTOPILOT_LIMITS.perDay;
const CHANNEL_LABEL: Record<string, string> = { email: "Email", whatsapp: "WhatsApp", linkedin: "LinkedIn" };

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
  read_webpage: "Read a web page",
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
    <div className="w-full max-w-2xl rounded-xl border border-stroke-soft-200 bg-bg-white-0 p-3 shadow-regular-xs">
      <div className="flex items-center gap-2">
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

function DiscoveryCard({ message, job }: { message: Message; job: Job | undefined }) {
  const data = message.toolResult?.data as { phrase?: string; keywords?: string } | undefined;
  const linkedin = message.tool === "find_linkedin_leads";
  if (message.status !== "ok" || !job) return <Card title={TOOL_TITLE[message.tool ?? "find_leads"] ?? "Lead search"} status={message.status}><p>{message.toolResult?.display ?? message.content}</p></Card>;
  const progress = job.progress as Record<string, number | string>;
  const stageText: Record<string, string> = {
    queued: progress.note ? `${String(progress.note)}…` : "Starting the search…",
    searching: linkedin ? `Searching LinkedIn (${progress.found ?? 0} profiles so far)…` : `Searching Google Maps${progress.searches ? ` in ${progress.searches} area${Number(progress.searches) === 1 ? "" : "s"}` : ""} (usually 1–10 minutes)…`,
    enriching: `Reading business websites for contact details (${progress.websitesChecked ?? 0} of ${progress.websitesToCheck ?? "?"})…`,
    saving: `Checking and saving contacts (${progress.saved ?? 0} of ${progress.found ?? "?"})…`,
  };
  const result = job.result as Record<string, number | string | null> | null;
  return (
    <Card title={`${linkedin ? "LinkedIn search" : "Lead search"}: ${data?.phrase ?? data?.keywords ?? ""}`} status={job.status}>
      {job.status === "queued" || job.status === "running" ? (
        <p role="status">{stageText[job.stage] ?? "Working…"}{typeof progress.found === "number" && job.stage !== "searching" ? ` ${progress.found} businesses found.` : ""}</p>
      ) : job.status === "succeeded" && result ? (
        <p>
          {result.found ?? 0} {linkedin ? "profiles" : "businesses"} found · <span className="text-label-sm text-text-strong-950">{result.eligible ?? 0} contactable</span>{linkedin ? " on LinkedIn" : ` (${result.withEmail ?? 0} by email, ${result.withPhoneOnly ?? 0} by phone only)`}
          {Number(result.excluded ?? 0) > 0 && ` · ${result.excluded} left out with reasons`}
          {Number(result.duplicates ?? 0) > 0 && ` · ${result.duplicates} duplicates skipped`}
          {result.note ? <span className="mt-1 block">{String(result.note)}</span> : null}
        </p>
      ) : (
        <p className="text-error-base">{job.error ?? "The search failed."}</p>
      )}
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
    limits: { maxLeads: number; emailPerMailboxPerDay: number | null; whatsappNewChatsPerDay: number | null };
    excluded: { reason: string; count: number }[];
    estimate: { aiCalls: number; aiCostUsd: number | null; days: number | null };
    autopilot: boolean;
  };
};

function ProposalCard({ message, run, canManageAutopilot, onChanged }: { message: Message; run: Run | undefined; canManageAutopilot: boolean; onChanged: () => void }) {
  const data = message.toolResult?.data as ProposalData | undefined;
  const [mode, setMode] = useState<"automatic" | "review" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (message.status !== "ok" || !data) return <Card title={TOOL_TITLE.prepare_outreach!} status={message.status}><p>{message.content}</p></Card>;
  const status = run?.status ?? "proposed";
  const perChannel = data.plan.assignments.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.channel]: (acc[a.channel] ?? 0) + 1 }), {});

  async function act(action: "start" | "cancel" | "pause" | "resume" | "stop" | "mode", nextMode?: "automatic" | "review") {
    if (action === "stop" && !window.confirm("Stop this run for good? Nothing more is sent for it and no reply is answered automatically. It cannot be resumed.")) return;
    // Automatic widens what Start approved, so it is confirmed with its limits.
    if (action === "mode" && nextMode === "automatic" && !window.confirm(
      `Answer this run's replies automatically? Only replies your saved information backs are sent, ${AUTOPILOT_DELAY_MINUTES} minutes after the draft is ready; ` +
      `at most ${AUTOPILOT_PER_CONVERSATION} per conversation and ${AUTOPILOT_PER_DAY} in any 24 hours. Everything else still waits for you. Other runs are not affected.`,
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
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-paragraph-sm sm:grid-cols-4">
        <div><dt className="text-paragraph-xs text-text-soft-400">Leads</dt><dd className="text-label-sm text-text-strong-950">{data.plan.assignments.length}</dd></div>
        <div><dt className="text-paragraph-xs text-text-soft-400">Channels</dt><dd className="text-label-sm text-text-strong-950">{Object.entries(perChannel).map(([c, n]) => `${CHANNEL_LABEL[c] ?? c} ${n}`).join(", ")}</dd></div>
        <div><dt className="text-paragraph-xs text-text-soft-400">Takes about</dt><dd className="text-label-sm text-text-strong-950">{data.plan.estimate.days ? `${data.plan.estimate.days} day${data.plan.estimate.days === 1 ? "" : "s"}` : "—"}</dd></div>
        <div><dt className="text-paragraph-xs text-text-soft-400">AI cost</dt><dd className="text-label-sm text-text-strong-950">{data.plan.estimate.aiCostUsd === null ? `${data.plan.estimate.aiCalls} calls` : data.plan.estimate.aiCostUsd < 0.01 ? "< $0.01" : `≈ $${data.plan.estimate.aiCostUsd.toFixed(2)}`}</dd></div>
      </dl>
      <p className="mt-2 text-paragraph-xs text-text-sub-600">
        Daily limits: {data.plan.limits.emailPerMailboxPerDay ? `${data.plan.limits.emailPerMailboxPerDay} emails per mailbox` : ""}{data.plan.limits.emailPerMailboxPerDay && data.plan.limits.whatsappNewChatsPerDay ? ", " : ""}{data.plan.limits.whatsappNewChatsPerDay ? `${data.plan.limits.whatsappNewChatsPerDay} new WhatsApp chats per number` : ""}. Sending rules, sending hours and Do Not Contact apply. Sending costs nothing extra beyond your own accounts.
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
            <span><span className="text-label-xs text-text-strong-950">Automatic.</span> The assistant answers these leads&apos; ordinary replies from your saved information, {AUTOPILOT_DELAY_MINUTES} minutes after they arrive, at most {AUTOPILOT_PER_CONVERSATION} times per conversation and {AUTOPILOT_PER_DAY} in 24 hours. It never invents prices, discounts, times or promises: questions your information does not answer, complaints, negotiations and meetings come to you here. Opt-outs stop all outreach to that person.{!canManageAutopilot && " Only an owner or admin can choose this."}</span>
          </label>
          <label className={cn("flex items-start gap-2 rounded-lg p-2 text-paragraph-xs ring-1 ring-inset", mode === "review" ? "ring-primary-base" : "ring-stroke-soft-200")}>
            <input type="radio" name={`mode-${data.runId}`} className="mt-0.5" checked={mode === "review"} disabled={busy} onChange={() => setMode("review")} />
            <span><span className="text-label-xs text-text-strong-950">Review.</span> The AI drafts every reply; each waits for you in Action required.</span>
          </label>
          <p className="text-paragraph-xs text-text-soft-400">Either way the first messages and follow-ups go out automatically to these {data.plan.assignments.length} leads only, within the limits above. Adding people, channels or higher limits needs a new plan you approve.</p>
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
            {run?.autopilot ? `Ordinary replies are answered ${AUTOPILOT_DELAY_MINUTES} minutes after they arrive (at most ${AUTOPILOT_PER_CONVERSATION} per conversation, ${AUTOPILOT_PER_DAY} in 24 hours).` : "Replies wait for you in Action required."}{" "}
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
      {run?.replies && run.replies.length > 0 && <RepliesList replies={run.replies} />}
      {run?.leads && run.leads.length > 0 && <LeadsList leads={run.leads} />}
      {run?.error && <p className="mt-2 text-paragraph-xs text-error-base">{run.error}</p>}
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
function RepliesList({ replies }: { replies: RunReply[] }) {
  const tone = { done: "text-success-base", waiting: "text-text-sub-600", you: "text-warning-base", failed: "text-error-base" } as const;
  return (
    <div className="mt-3 border-t border-stroke-soft-200 pt-3">
      <p className="text-label-xs text-text-strong-950">Replies</p>
      <ul className="mt-1.5 space-y-2">
        {replies.map((reply) => (
          <li key={reply.id} className="text-paragraph-xs">
            <p className="text-text-sub-600"><span className="text-label-xs text-text-strong-950">{reply.who}</span> · {CHANNEL_LABEL[reply.channel] ?? reply.channel} · {timeOf(reply.receivedAt)}</p>
            {reply.preview && <p className="mt-0.5 line-clamp-2 border-l-2 border-stroke-sub-300 pl-2 text-text-sub-600">{reply.preview}</p>}
            <p className={cn("mt-0.5", tone[reply.state.tone])}>{reply.state.text}{reply.state.at ? ` ${timeOf(reply.state.at)}` : ""}.</p>
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
  "list_decisions", "pause_outreach", "resume_outreach", "stop_outreach", "switch_to_review", "answer_decision", "read_webpage",
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

function ToolMessage({ message, jobs, runs, decisions, canManageAutopilot, onChanged }: { message: Message; jobs: Job[]; runs: Record<string, Run>; decisions: Record<string, DecisionState>; canManageAutopilot: boolean; onChanged: () => void }) {
  const data = message.toolResult?.data as Record<string, unknown> | undefined;
  if (message.tool === "owner_decision") return <DecisionCard message={message} state={decisions[String(data?.decisionId ?? "")]} onChanged={onChanged} />;
  if (message.tool === "daily_summary") {
    return <Card title={`Daily summary · ${String(data?.day ?? "")}`} status={message.status}><p className="whitespace-pre-wrap text-paragraph-xs">{message.content.split("\n").slice(1).join("\n")}</p></Card>;
  }
  if (message.tool === "find_leads" || message.tool === "find_linkedin_leads") return <DiscoveryCard message={message} job={jobs.find((job) => job.id === data?.jobId)} />;
  if (message.tool === "prepare_outreach") return <ProposalCard message={message} run={runs[String(data?.runId ?? "")]} canManageAutopilot={canManageAutopilot} onChanged={onChanged} />;
  if (message.tool === "report") return <ReportCard message={message} />;
  if (COMPACT_TOOLS.has(message.tool ?? "")) return <ActivityRow message={message} />;
  const title = message.tool === "read_document" || message.tool === "import_contacts"
    ? `${TOOL_TITLE[message.tool]}: ${String(message.toolInput?.file ?? "")}`
    : TOOL_TITLE[message.tool ?? ""] ?? message.tool ?? "Action";
  const audience = message.tool === "import_contacts" || message.tool === "add_contacts" ? (data?.audience as AudienceData | undefined) : message.tool === "describe_audience" ? (data as AudienceData | undefined) : undefined;
  return (
    <Card title={title} status={message.status}>
      {message.status === "running" ? null : audience && message.status === "ok" ? (
        <>
          {message.tool === "import_contacts" && <p className="text-paragraph-xs">{message.content.split(". Lead list")[0]}.</p>}
          {message.tool === "add_contacts" && message.toolResult?.display && <p className="text-paragraph-xs">{message.toolResult.display}</p>}
          <AudienceSummary audience={audience} />
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
    <div className="space-y-2">
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
    ...(["email", "whatsapp", "linkedin"] as const).map((channel) => ({
      label: CHANNEL_LABEL[channel]!,
      ok: setup.channels[channel].available,
      detail: setup.channels[channel].available ? `${setup.channels[channel].senders} connected` : setup.channels[channel].reason ?? "Not connected",
      href: channel === "email" ? "/settings/email-accounts" : channel === "whatsapp" ? "/settings/whatsapp-accounts" : "/settings/linkedin-accounts",
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
          {missing ? `${missing} to set up` : "Ready"}
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

function ConversationMenu({ current, threads, onOpen, onNew }: { current: { id: string; title: string }; threads: AssistantStatePayload["threads"]; onOpen: (id: string) => void; onNew: () => void }) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button type="button" className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-bg-weak-50">
          <AssistantAvatar />
          <span className="min-w-0">
            <span className="block text-label-sm text-text-strong-950">Assistant</span>
            <span className="block max-w-[11rem] truncate text-paragraph-xs text-text-soft-400 sm:max-w-xs">{displayThreadTitle(current.title)}</span>
          </span>
          <RiArrowDownSLine className="size-4 shrink-0 text-text-soft-400" aria-hidden="true" />
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
    { icon: RiSearchEyeLine, title: "Find customers and contact them", description: "I search Google Maps and business websites, then show you a plan to approve.", text: who && where ? `Find ${who} in ${where} and contact them` : "Find … in … and contact them" },
    { icon: RiFileList3Line, title: "Contact people from my list", description: "Attach a CSV or Excel file; I import it and write the messages.", text: "Contact the people in this list", attach: true },
    { icon: RiBarChartBoxLine, title: "How is my outreach doing?", description: "Leads, messages, replies, and what is waiting for you.", text: "How is my outreach doing?", send: true },
  ];
}

type BusinessProfileSummary = { businessName?: string; offer?: string; targetCustomers?: string; locations?: string };

function Welcome({ firstName, profile, onStarter }: { firstName: string | null; profile: BusinessProfileSummary | undefined; onStarter: (starter: Starter) => void }) {
  return (
    <div className="assistant-welcome mx-auto flex w-full max-w-2xl flex-col items-center pt-[5vh] text-center">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-soft-400">{firstName ? `Your workspace, ${firstName}` : "Your outreach workspace"}</p>
      <h2 className="mt-5 text-[clamp(30px,3.5vw,46px)] font-medium leading-[1.1] tracking-[-0.045em] text-text-strong-950">Let’s make your next<br /><span className="font-instrument-serif text-[1.15em] italic font-normal">connection.</span></h2>
      <p className="mt-4 max-w-lg text-paragraph-sm leading-relaxed text-text-sub-600">
        I find customers{profile?.businessName ? ` for ${profile.businessName}` : ""}, write the outreach you approve, answer routine replies from your information, and bring you anything that needs a decision.
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
  const scroller = useRef<HTMLDivElement>(null);
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

  // While a run is live, replies, answers and decisions arrive on their own: show them without a reload.
  const live = Object.values(state.runs).some((run) => run.status === "running" || run.status === "paused");
  useEffect(() => {
    if (working || !live) return;
    const timer = setInterval(() => void refresh(false), 15_000);
    return () => clearInterval(timer);
  }, [working, live, refresh]);

  const showPending = pending !== null && !state.messages.slice(pending.baseline).some((message) => message.role === "user");
  const count = state.messages.length + (showPending ? 1 : 0);
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [count, state.thread.id, state.busy]);

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
    if ((!message && !files.length) || sending) return;
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
      const next = await readJson<AssistantStatePayload>(await fetch("/api/assistant/messages", { method: "POST", body: form }));
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
      return (
        <div key={message.id} className="flex items-start gap-2 rounded-lg bg-bg-weak-50 px-3 py-2 text-paragraph-xs text-text-sub-600">
          <RiInformationLine className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{message.content}</span>
        </div>
      );
    }
    return <ToolMessage key={message.id} message={message} jobs={state.jobs} runs={state.runs} decisions={state.decisions ?? {}} canManageAutopilot={Boolean(setup?.canManageAutopilot)} onChanged={() => void refresh(true)} />;
  });

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-bg-white-0"
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-stroke-soft-200 px-3 sm:px-5">
        <ConversationMenu current={state.thread} threads={state.threads} onOpen={(id) => void openThread(id)} onNew={() => void newThread()} />
        <div className="ml-auto flex items-center gap-1.5">
          <ReadinessMenu setup={setup} />
          <Link href="/assistant/results" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200 hover:bg-bg-weak-50">
            <RiBarChartBoxLine className="size-4" aria-hidden="true" /><span className="hidden sm:inline">Results</span>
          </Link>
          <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => void newThread()} disabled={sending} aria-label="New conversation" className="h-8">
            <Button.Icon as={RiAddLine} /><span className="hidden sm:inline">New chat</span>
          </Button.Root>
        </div>
      </header>

      <div className="shrink-0 px-3 pt-2 empty:hidden sm:px-5">
        <NeedsYouList initial={null} compact />
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        {empty ? (
          <Welcome firstName={state.viewer?.firstName ?? null} profile={profile} onStarter={pickStarter} />
        ) : (
          <div role="log" aria-live="polite" className="mx-auto flex max-w-3xl flex-col gap-5">
            {turns.map((turn, index) => (
              <div key={turn.owner?.id ?? `turn-${index}`} className="flex flex-col gap-3">
                {turn.owner && (
                  <div className="flex flex-col items-end gap-1">
                    {turn.owner.content && <div className="max-w-[min(36rem,85%)] whitespace-pre-wrap rounded-2xl rounded-br-md bg-bg-weak-50 px-3.5 py-2 text-paragraph-sm text-text-strong-950">{turn.owner.content}</div>}
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
                  {pending.text && <div className="max-w-[min(36rem,85%)] whitespace-pre-wrap rounded-2xl rounded-br-md bg-bg-weak-50 px-3.5 py-2 text-paragraph-sm text-text-strong-950">{pending.text}</div>}
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

      <div className="shrink-0 px-3 pb-3 pt-1 sm:px-6 sm:pb-4">
        <div className="mx-auto max-w-3xl">
          {error && <p role="alert" className="mb-2 text-paragraph-xs text-error-base">{error}</p>}
          <div className="rounded-2xl bg-bg-weak-25 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200 transition focus-within:bg-bg-white-0 focus-within:ring-primary-base">
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
              placeholder={empty ? "Describe your business, or ask for leads…" : "Reply to the assistant…"}
              aria-label="Message the assistant"
              disabled={sending}
              className="block max-h-52 min-h-11 w-full resize-none bg-transparent px-4 pb-1 pt-3 text-paragraph-sm text-text-strong-950 outline-none placeholder:text-text-soft-400"
            />
            <div className="flex items-center gap-2 px-2 pb-2">
              <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={(event) => {
                addFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }} />
              <button type="button" onClick={() => fileInput.current?.click()} disabled={sending} title="Attach a PDF, Word or text document, or a CSV/Excel contact list" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-label-xs text-text-sub-600 hover:bg-bg-weak-50 disabled:opacity-50">
                <RiAttachment2 className="size-4" aria-hidden="true" /><span>Attach</span>
              </button>
              <span className="hidden flex-1 truncate text-paragraph-xs text-text-soft-400 sm:block">Documents, price lists or a contact list (CSV, Excel)</span>
              <Button.Root variant="primary" mode="filled" size="small" onClick={() => void send()} disabled={sending || (!text.trim() && !files.length)} aria-label="Send" className="ml-auto size-8 rounded-lg p-0">
                {sending ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : <Button.Icon as={RiArrowUpLine} />}
              </Button.Root>
            </div>
          </div>
          <p className="mt-2 text-center text-paragraph-xs text-text-soft-400">
            Nothing reaches your leads until you press Start on a plan.
            <span className="hidden sm:inline"> Replies waiting for you are in <Link href="/crm/actions" className="underline underline-offset-2 hover:text-text-sub-600">Action required</Link>.</span>
          </p>
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
