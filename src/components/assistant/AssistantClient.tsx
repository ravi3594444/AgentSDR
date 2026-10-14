"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  RiAddLine,
  RiAttachment2,
  RiCheckboxCircleFill,
  RiCloseLine,
  RiErrorWarningFill,
  RiExternalLinkLine,
  RiFileTextLine,
  RiInformationLine,
  RiLoader4Line,
  RiPauseLine,
  RiPlayLine,
  RiRobot2Line,
  RiSendPlane2Fill,
  RiTableLine,
} from "@remixicon/react";

import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
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
  toolResult: { summary?: string; display?: string; data?: Record<string, unknown> } | null;
  status: "running" | "ok" | "error" | null;
  attachments: { name: string; kind: string; bytes: number }[];
  createdAt: string;
};

type Job = {
  id: string;
  kind: "discovery" | "outreach_start";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  audienceId: string | null;
  runId: string | null;
};

type Run = { id: string; status: string; autopilot: boolean; error: string | null; campaigns: Record<string, string> };

type ChannelStatus = { available: boolean; reason: string | null; senders: number };

type Setup = {
  channels: Record<"email" | "whatsapp" | "linkedin", ChannelStatus>;
  leadDiscovery: { available: boolean; reason: string | null };
  ai: { connected: boolean };
  autopilot: boolean;
  canManageAutopilot: boolean;
  missingForDiscovery: string[];
  missingForOutreach: string[];
};

export type AssistantStatePayload = {
  thread: { id: string; title: string };
  threads: { id: string; title: string; updatedAt: string | Date }[];
  busy: boolean;
  messages: Message[];
  jobs: Job[];
  runs: Record<string, Run>;
  setup: Setup | null;
};

const ACCEPT = ".pdf,.docx,.txt,.md,.csv,.tsv,.xlsx,.xls";
const CHANNEL_LABEL: Record<string, string> = { email: "Email", whatsapp: "WhatsApp", linkedin: "LinkedIn" };

const TOOL_TITLE: Record<string, string> = {
  check_setup: "Checked what is connected",
  save_business_info: "Saved business information",
  search_knowledge: "Read your saved information",
  find_leads: "Lead search",
  lead_search_status: "Checked the lead search",
  list_audiences: "Lead lists",
  describe_audience: "Lead list",
  prepare_outreach: "Outreach plan",
  list_runs: "Outreach runs",
  report: "Outreach report",
  pause_outreach: "Paused outreach",
  resume_outreach: "Resumed outreach",
  turn_off_autopilot: "Reply autopilot off",
  read_document: "Document",
  import_contacts: "Contact list",
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
  const data = message.toolResult?.data as { phrase?: string } | undefined;
  if (message.status !== "ok" || !job) return <Card title={TOOL_TITLE.find_leads!} status={message.status}><p>{message.content}</p></Card>;
  const progress = job.progress as Record<string, number | string>;
  const stageText: Record<string, string> = {
    queued: "Starting the search…",
    searching: "Searching Google Maps (usually 3–10 minutes)…",
    enriching: `Reading business websites for contact details (${progress.websitesChecked ?? 0} of ${progress.websitesToCheck ?? "?"})…`,
    saving: `Checking and saving contacts (${progress.saved ?? 0} of ${progress.found ?? "?"})…`,
  };
  const result = job.result as Record<string, number | string | null> | null;
  return (
    <Card title={`Lead search: ${data?.phrase ?? ""}`} status={job.status}>
      {job.status === "queued" || job.status === "running" ? (
        <p role="status">{stageText[job.stage] ?? "Working…"}{typeof progress.found === "number" && job.stage !== "searching" ? ` ${progress.found} businesses found.` : ""}</p>
      ) : job.status === "succeeded" && result ? (
        <p>
          {result.found ?? 0} businesses found · <span className="text-label-sm text-text-strong-950">{result.eligible ?? 0} contactable</span> ({result.withEmail ?? 0} by email, {result.withPhoneOnly ?? 0} by phone only)
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
    samples: { name: string; channel: string; messages: { subject: string | null; body: string }[] }[];
    limits: { maxLeads: number; emailPerMailboxPerDay: number | null; whatsappNewChatsPerDay: number | null };
    excluded: { reason: string; count: number }[];
    estimate: { aiCalls: number; aiCostUsd: number | null; days: number | null };
    autopilot: boolean;
  };
};

function ProposalCard({ message, run, canManageAutopilot, onChanged }: { message: Message; run: Run | undefined; canManageAutopilot: boolean; onChanged: () => void }) {
  const data = message.toolResult?.data as ProposalData | undefined;
  const [autopilot, setAutopilot] = useState(Boolean(data?.plan.autopilot) && canManageAutopilot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (message.status !== "ok" || !data) return <Card title={TOOL_TITLE.prepare_outreach!} status={message.status}><p>{message.content}</p></Card>;
  const status = run?.status ?? "proposed";
  const perChannel = data.plan.assignments.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.channel]: (acc[a.channel] ?? 0) + 1 }), {});

  async function act(action: "start" | "cancel" | "pause" | "resume") {
    setBusy(true);
    setError(null);
    try {
      await readJson(await fetch(`/api/assistant/runs/${data!.runId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "start" ? { action, autopilot } : { action }),
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
      <div className="mt-3 space-y-2">
        {data.plan.samples.map((sample, index) => (
          <details key={`${sample.name}-${index}`} open={index === 0} className="rounded-lg bg-bg-weak-50 px-3 py-2">
            <summary className="cursor-pointer text-label-sm text-text-strong-950">Sample · {sample.name} · {CHANNEL_LABEL[sample.channel] ?? sample.channel}</summary>
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
        <div className="mt-3 flex flex-col gap-2 border-t border-stroke-soft-200 pt-3 sm:flex-row sm:items-center">
          <label className={cn("flex flex-1 items-start gap-2 text-paragraph-xs text-text-sub-600", !canManageAutopilot && "opacity-60")}>
            <input type="checkbox" className="mt-0.5" checked={autopilot} disabled={!canManageAutopilot || busy} onChange={(event) => setAutopilot(event.target.checked)} />
            <span>Answer ordinary replies automatically, 10 minutes after they arrive (interested or not-interested replies the AI is sure about; at most 3 per conversation). Anything unusual waits for you.{!canManageAutopilot && " Only an owner or admin can turn this on."}</span>
          </label>
          <div className="flex gap-2">
            <Button.Root variant="neutral" mode="stroke" size="small" disabled={busy} onClick={() => void act("cancel")}>Discard</Button.Root>
            <Button.Root variant="primary" mode="filled" size="small" disabled={busy} onClick={() => void act("start")}>
              {busy ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : <Button.Icon as={RiPlayLine} />}
              Start outreach
            </Button.Root>
          </div>
        </div>
      )}
      {(status === "running" || status === "paused") && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-stroke-soft-200 pt-3 text-paragraph-xs text-text-sub-600">
          <span className="flex-1">{run?.autopilot ? "Reply autopilot on." : "Replies wait for you in Action required."} {Object.keys(run?.campaigns ?? {}).length ? `Campaigns: ${Object.keys(run!.campaigns).map((c) => CHANNEL_LABEL[c] ?? c).join(", ")}.` : ""}</span>
          <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy} onClick={() => void act(status === "running" ? "pause" : "resume")}>
            <Button.Icon as={status === "running" ? RiPauseLine : RiPlayLine} />
            {status === "running" ? "Pause" : "Resume"}
          </Button.Root>
        </div>
      )}
      {run?.error && <p className="mt-2 text-paragraph-xs text-error-base">{run.error}</p>}
      {error && <p role="alert" className="mt-2 text-paragraph-xs text-error-base">{error}</p>}
    </div>
  );
}

function ReportCard({ message }: { message: Message }) {
  const data = message.toolResult?.data as { name?: string; status?: string; channels?: { channel: string; contacted: number; messagesSent: number | null; replied: number; finished: number; stopped: number }[] } | undefined;
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

function ToolMessage({ message, jobs, runs, canManageAutopilot, onChanged }: { message: Message; jobs: Job[]; runs: Record<string, Run>; canManageAutopilot: boolean; onChanged: () => void }) {
  const data = message.toolResult?.data as Record<string, unknown> | undefined;
  if (message.tool === "find_leads") return <DiscoveryCard message={message} job={jobs.find((job) => job.id === data?.jobId)} />;
  if (message.tool === "prepare_outreach") return <ProposalCard message={message} run={runs[String(data?.runId ?? "")]} canManageAutopilot={canManageAutopilot} onChanged={onChanged} />;
  if (message.tool === "report") return <ReportCard message={message} />;
  const title = message.tool === "read_document" || message.tool === "import_contacts"
    ? `${TOOL_TITLE[message.tool]}: ${String(message.toolInput?.file ?? "")}`
    : TOOL_TITLE[message.tool ?? ""] ?? message.tool ?? "Action";
  const audience = message.tool === "import_contacts" ? (data?.audience as AudienceData | undefined) : message.tool === "describe_audience" ? (data as AudienceData | undefined) : undefined;
  return (
    <Card title={title} status={message.status}>
      {message.status === "running" ? null : audience && message.status === "ok" ? (
        <>
          {message.tool === "import_contacts" && <p className="text-paragraph-xs">{message.content.split(". Lead list")[0]}.</p>}
          <AudienceSummary audience={audience} />
        </>
      ) : (
        <p className={cn("whitespace-pre-wrap text-paragraph-xs", message.status === "error" && "text-error-base")}>{message.toolResult?.display ?? message.content}</p>
      )}
    </Card>
  );
}

function SetupStrip({ setup }: { setup: Setup | null }) {
  if (!setup) return null;
  const items: { label: string; ok: boolean; title: string; href: string }[] = [
    { label: "AI", ok: setup.ai.connected, title: setup.ai.connected ? "AI provider connected" : "Connect an AI provider", href: "/settings/ai" },
    { label: "Lead search", ok: setup.leadDiscovery.available, title: setup.leadDiscovery.reason ?? "Google Maps lead search ready", href: "/getting-started" },
    ...(["email", "whatsapp", "linkedin"] as const).map((channel) => ({
      label: CHANNEL_LABEL[channel]!,
      ok: setup.channels[channel].available,
      title: setup.channels[channel].reason ?? `${setup.channels[channel].senders} connected`,
      href: channel === "email" ? "/settings/email-accounts" : channel === "whatsapp" ? "/settings/whatsapp-accounts" : "/settings/linkedin-accounts",
    })),
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Link key={item.label} href={item.href} title={item.title} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-label-xs ring-1 ring-inset", item.ok ? "text-success-base ring-success-light" : "text-text-soft-400 ring-stroke-soft-200")}>
          <span className={cn("size-1.5 rounded-full", item.ok ? "bg-success-base" : "bg-stroke-sub-300")} aria-hidden="true" />
          {item.label}
        </Link>
      ))}
    </div>
  );
}

const SUGGESTIONS = [
  "Find suitable leads and contact them.",
  "Use the contact list I'm attaching and run outreach.",
  "Here is what my business does and who we sell to: ",
];

export default function AssistantClient({ initial }: { initial: AssistantStatePayload }) {
  const [state, setState] = useState(initial);
  const [setup, setSetup] = useState<Setup | null>(initial.setup);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  /** The message being sent, shown until the polled thread holds it (`baseline`: messages before it). */
  const [pending, setPending] = useState<{ text: string; files: string[]; baseline: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autopilotBusy, setAutopilotBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
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

  const showPending = pending !== null && !state.messages.slice(pending.baseline).some((message) => message.role === "user");
  const count = state.messages.length + (showPending ? 1 : 0);
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [count, state.thread.id]);

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
    }
  }

  async function newThread() {
    const created = await readJson<{ threadId: string }>(await fetch("/api/assistant/threads", { method: "POST" }));
    const next = await readJson<AssistantStatePayload>(await fetch(`/api/assistant?threadId=${created.threadId}`, { cache: "no-store" }));
    setState(next);
  }

  async function openThread(id: string) {
    const next = await readJson<AssistantStatePayload>(await fetch(`/api/assistant?threadId=${id}`, { cache: "no-store" }));
    setState(next);
  }

  async function toggleAutopilot(enabled: boolean) {
    setAutopilotBusy(true);
    setError(null);
    try {
      await readJson(await fetch("/api/assistant/autopilot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }));
      await refresh(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAutopilotBusy(false);
    }
  }

  const visible = useMemo(() => state.messages, [state.messages]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-white-0">
      <header className="flex shrink-0 flex-col gap-2 border-b border-stroke-soft-200 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <RiRobot2Line className="size-5 text-primary-base" aria-hidden="true" />
          <h1 className="text-label-lg text-text-strong-950">Assistant</h1>
          <select
            aria-label="Conversation"
            value={state.thread.id}
            onChange={(event) => void openThread(event.target.value)}
            className="ml-1 max-w-48 truncate rounded-md bg-transparent px-1 py-0.5 text-paragraph-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200"
          >
            {state.threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
          </select>
          <div className="ml-auto flex items-center gap-2">
            {setup && (
              <label className={cn("flex items-center gap-1.5 text-label-xs", setup.autopilot ? "text-success-base" : "text-text-sub-600")} title="Answer ordinary replies automatically; anything unusual waits for you in Action required.">
                <input type="checkbox" checked={setup.autopilot} disabled={autopilotBusy || (!setup.autopilot && !setup.canManageAutopilot)} onChange={(event) => void toggleAutopilot(event.target.checked)} />
                Reply autopilot
              </label>
            )}
            <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => void newThread()} disabled={sending}>
              <Button.Icon as={RiAddLine} />
              New chat
            </Button.Root>
          </div>
        </div>
        <SetupStrip setup={setup} />
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {visible.length === 0 && !showPending && (
            <div className="rounded-2xl border border-dashed border-stroke-soft-200 p-5 text-paragraph-sm text-text-sub-600">
              <p className="text-label-md text-text-strong-950">Tell me about your business, then ask me to find leads or use your list.</p>
              <p className="mt-1">I remember what you tell me, read the documents you attach (PDF, Word, text) and import contact lists (CSV, Excel). I find businesses from public Google Maps listings and their websites, write the messages, and show you the plan. Nothing is sent until you press Start.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => setText(suggestion)} className="rounded-full px-3 py-1 text-label-xs text-text-strong-950 ring-1 ring-inset ring-stroke-soft-200 hover:bg-bg-weak-50">
                    {suggestion.replace(/: $/, "…")}
                  </button>
                ))}
              </div>
            </div>
          )}
          {visible.map((message) => {
            if (message.role === "user") {
              return (
                <div key={message.id} className="flex flex-col items-end gap-1">
                  {message.content && <div className="max-w-[min(36rem,85%)] whitespace-pre-wrap rounded-2xl bg-primary-alpha-10 px-3.5 py-2 text-paragraph-sm text-text-strong-950 ring-1 ring-inset ring-primary-alpha-16">{message.content}</div>}
                  {message.attachments.map((file) => (
                    <span key={file.name} className="inline-flex items-center gap-1 text-paragraph-xs text-text-sub-600">
                      {file.kind === "contacts" ? <RiTableLine className="size-3.5" /> : <RiFileTextLine className="size-3.5" />}
                      {file.name}
                    </span>
                  ))}
                </div>
              );
            }
            if (message.role === "assistant") {
              return <div key={message.id} className="max-w-[min(40rem,92%)] whitespace-pre-wrap text-paragraph-sm text-text-strong-950">{message.content}</div>;
            }
            if (message.role === "event") {
              return (
                <div key={message.id} className="flex items-start gap-2 rounded-lg bg-bg-weak-50 px-3 py-2 text-paragraph-xs text-text-sub-600">
                  <RiInformationLine className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>{message.content}</span>
                </div>
              );
            }
            return <ToolMessage key={message.id} message={message} jobs={state.jobs} runs={state.runs} canManageAutopilot={Boolean(setup?.canManageAutopilot)} onChanged={() => void refresh(true)} />;
          })}
          {showPending && pending && (
            <div className="flex flex-col items-end gap-1 opacity-70">
              {pending.text && <div className="max-w-[min(36rem,85%)] whitespace-pre-wrap rounded-2xl bg-primary-alpha-10 px-3.5 py-2 text-paragraph-sm text-text-strong-950">{pending.text}</div>}
              {pending.files.map((name) => <span key={name} className="text-paragraph-xs text-text-sub-600">{name}</span>)}
            </div>
          )}
          {(sending || state.busy) && (
            <p role="status" className="flex items-center gap-2 text-paragraph-xs text-text-soft-400">
              <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" /> Working…
            </p>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-stroke-soft-200 px-3 py-3 sm:px-6">
        <div className="mx-auto max-w-3xl">
          {error && <p role="alert" className="mb-2 text-paragraph-xs text-error-base">{error}</p>}
          {files.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {files.map((file) => (
                <span key={file.name} className="inline-flex items-center gap-1 rounded-full bg-bg-weak-50 py-0.5 pl-2 pr-1 text-label-xs text-text-sub-600">
                  {file.name}
                  <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((item) => item !== file))} className="rounded-full p-0.5 hover:bg-bg-soft-200"><RiCloseLine className="size-3.5" /></button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2 rounded-2xl bg-bg-white-0 p-2 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200 focus-within:ring-stroke-strong-950">
            <input ref={fileInput} type="file" multiple accept={ACCEPT} className="hidden" onChange={(event) => {
              const picked = Array.from(event.target.files ?? []);
              setFiles((current) => [...current, ...picked].slice(0, 5));
              event.target.value = "";
            }} />
            <Button.Root variant="neutral" mode="ghost" size="small" aria-label="Attach documents or a contact list" title="Attach a PDF, Word or text document, or a CSV/Excel contact list" onClick={() => fileInput.current?.click()} disabled={sending}>
              <Button.Icon as={RiAttachment2} />
            </Button.Root>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder="Message the assistant…"
              aria-label="Message the assistant"
              disabled={sending}
              className="max-h-48 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-paragraph-sm text-text-strong-950 outline-none placeholder:text-text-soft-400"
            />
            <Button.Root variant="primary" mode="filled" size="small" onClick={() => void send()} disabled={sending || (!text.trim() && !files.length)} aria-label="Send">
              {sending ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : <Button.Icon as={RiSendPlane2Fill} />}
            </Button.Root>
          </div>
          <p className="mt-1.5 flex items-center gap-1 text-paragraph-xs text-text-soft-400">
            Outreach starts only when you press Start on a plan.
            <Link href="/crm/actions" className="inline-flex items-center gap-0.5 underline">Action required <RiExternalLinkLine className="size-3" /></Link>
          </p>
        </div>
      </div>
    </div>
  );
}
