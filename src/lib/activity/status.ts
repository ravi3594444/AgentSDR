/**
 * What a piece of background work is doing right now, told from its record
 * only (never from a guess): a search job, or an outreach plan. A stored
 * "running" with an old heartbeat is stale, not working; a run is not a
 * confirmed send. Pure and client-safe; activity.server.ts reads the rows.
 */

import { outcomeOf, STOP_REASONS, STOP_WORDS, type StopReason } from "@/lib/assistant/objective";
import { DAILY_LEAD_LIMIT_GATE } from "@/lib/channels/dailyLeadLimit";

export type WorkState =
  | "queued"
  | "executing"
  | "waiting_slot"
  | "waiting_quota"
  | "waiting_send"
  | "daily_lead_limit"
  | "scheduled"
  | "retrying"
  | "needs_approval"
  | "paused"
  | "completed"
  | "partial"
  | "not_searched"
  | "failed"
  | "cancelled"
  | "stale";

export const WORK_STATE_LABELS: Record<WorkState, string> = {
  queued: "Queued",
  executing: "Working",
  waiting_slot: "Waiting for a run slot",
  waiting_quota: "Waiting for a provider limit",
  waiting_send: "Waiting to send",
  daily_lead_limit: "Daily lead limit reached",
  scheduled: "Scheduled",
  retrying: "Retrying",
  needs_approval: "Needs your Start",
  paused: "Paused",
  completed: "Done",
  partial: "Partly done",
  not_searched: "Not searched",
  failed: "Failed",
  cancelled: "Cancelled",
  stale: "Stalled",
};

/** States that may still change by themselves; a finished item will not. */
export const OPEN_STATES: ReadonlySet<WorkState> = new Set(["queued", "executing", "waiting_slot", "waiting_quota", "waiting_send", "daily_lead_limit", "scheduled", "retrying", "needs_approval", "paused", "stale"]);

const STALE_MS = 3 * 60_000;

export type JobFacts = {
  status: string;
  runAfter: Date | null;
  heartbeatAt: Date | null;
  attempts: number;
  progress: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
};

/** A background job's state and the reason to show beside it. */
export function jobState(job: JobFacts, now: Date): { state: WorkState; reason: string | null } {
  const waiting = job.progress?.waiting as { kind?: unknown; reason?: unknown; until?: unknown } | undefined;
  const reason = typeof waiting?.reason === "string" ? waiting.reason : null;
  switch (job.status) {
    case "succeeded":
      if (job.result?.notSearched === true || job.result?.handedToJobId) return { state: "not_searched", reason: typeof job.result?.note === "string" ? job.result.note : null };
      if (typeof job.result?.stopReason === "string") return requestOutcome(job.result);
      return partialSearch(job) ?? { state: "completed", reason: null };
    case "failed":
      return { state: "failed", reason: null };
    case "cancelled":
      return { state: "cancelled", reason: null };
    case "running":
      return job.heartbeatAt && now.getTime() - job.heartbeatAt.getTime() > STALE_MS
        ? { state: "stale", reason: "no worker has reported on it for a few minutes; it is picked up again automatically" }
        : { state: "executing", reason: null };
    default: {
      // A request's driver: its searches run, or the assistant picks the next one; the request is being worked on.
      if (waiting?.kind === "objective") return { state: "executing", reason };
      if (waiting?.kind === "slot") return { state: "waiting_slot", reason };
      if (waiting?.kind === "quota") return { state: "waiting_quota", reason };
      if (typeof job.progress?.lastError === "string" && job.attempts > 0) return { state: "retrying", reason: job.progress.lastError };
      if (job.runAfter && job.runAfter.getTime() > now.getTime() + 5_000) return { state: "scheduled", reason: null };
      return { state: "queued", reason: null };
    }
  }
}

/** How an owner request's research ended (the objective job's result): short of its target with the reason it stopped is partly done. */
function requestOutcome(result: Record<string, unknown>): { state: WorkState; reason: string | null } {
  const reason = result.stopReason as StopReason;
  if (!STOP_REASONS.includes(reason)) return { state: "completed", reason: null };
  const found = typeof result.leads === "number" && typeof result.leadTarget === "number" ? `${result.leads} of ${result.leadTarget} leads; ` : "";
  const outcome = outcomeOf(reason);
  if (outcome === "completed") return { state: "completed", reason: found ? `${found}${STOP_WORDS[reason]}` : null };
  return { state: outcome, reason: `${found}stopped because ${STOP_WORDS[reason]}` };
}

/**
 * A finished search that did not cover all it set out to: an Apify run cut
 * short by its spending cap or time limit, or some of a web search's
 * queries failing. What it found is kept either way.
 */
function partialSearch(job: JobFacts): { state: WorkState; reason: string } | null {
  if (job.progress?.partial === true || job.result?.partial === true) return { state: "partial", reason: "the provider's run was cut short (its spending cap or time limit); what it found is kept" };
  const searches = Array.isArray(job.result?.searches) ? (job.result.searches as { error?: unknown }[]) : [];
  const failed = searches.filter((search) => typeof search?.error === "string" && search.error);
  if (!failed.length) return null;
  return { state: "partial", reason: `${failed.length} of ${searches.length} searches failed (${String(failed[0]!.error).slice(0, 160)}); what the others found is kept` };
}

/**
 * The jobs Activity may cancel: searches. Starting an outreach plan is
 * controlled through the plan itself (Pause, Resume, Stop), never by
 * cancelling its job, which would leave the run starting or launching.
 */
export const CANCELLABLE_JOB_KINDS = ["discovery", "web_discovery", "linkedin_search", "apify_instagram", "social_research"] as const;

export function isCancellableJobKind(kind: string): boolean {
  return (CANCELLABLE_JOB_KINDS as readonly string[]).includes(kind);
}

/** Whether Activity offers Cancel on a job: a search that is still queued or running. */
export function canCancelJob(job: { kind: string; status: string }): boolean {
  return isCancellableJobKind(job.kind) && (job.status === "queued" || job.status === "running");
}

/** An outreach plan's state: proposed plans wait for Start; running is sending within its rules, not proof of a send. */
export function runState(status: string): WorkState {
  switch (status) {
    case "proposed": return "needs_approval";
    case "starting":
    case "running": return "executing";
    case "paused": return "paused";
    case "completed":
    case "stopped": return "completed";
    case "cancelled": return "cancelled";
    case "failed": return "failed";
    default: return "queued";
  }
}

type Sender = { gates: readonly string[]; nextAt: string | null; queued?: number | null };

/**
 * A plan's lead as the plan card and Activity read it (runLeads.server.ts):
 * its progress, whether it was contacted, and whether its channel engine
 * still has anything to send it (`open`). Where its channel reports timing
 * (email, runLeads.ts leadTiming): when its next follow-up is due if that is
 * ahead (`nextAt`; null: due now), whether its next message is prepared for
 * sending (`queued`), and whether that is its first (`firstMessage`).
 */
export type PlanLead = {
  progress: { tone: string; text: string };
  reach?: { contacted: boolean; replied: boolean };
  open?: boolean;
  nextAt?: string | null;
  queued?: boolean;
  firstMessage?: boolean;
};

function earliestOf(times: readonly (string | null | undefined)[]): string | null {
  return times.filter((time): time is string => Boolean(time)).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

function earliest(senders: readonly Sender[]): string | null {
  return earliestOf(senders.map((sender) => sender.nextAt));
}

const isLeadLimit = (gate: string) => gate.startsWith(DAILY_LEAD_LIMIT_GATE);

/** In a plan's reason when due messages are missing from the queue: they are prepared again on their own, so it is no sender problem. */
export const NOT_PREPARED = "not prepared for sending yet";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const contactedLead = (lead: PlanLead) => lead.reach?.contacted ?? (lead.progress.tone === "replied" || lead.progress.tone === "good" || lead.progress.tone === "sent");

/** A failed lead's recorded reason, short: its first sentence, without the "Could not send" prefix. */
function failureText(text: string): string {
  const reason = text.replace(/^Could not send:?\s*/i, "").trim();
  if (!reason) return "no reason recorded";
  const sentence = reason.split(/(?<=[a-z0-9)])\.\s/i)[0]!.replace(/\.$/, "");
  return sentence.length > 120 ? `${sentence.slice(0, 119)}…` : sentence;
}

/** "6 failed (WhatsApp rejected this recipient)": the count and the most common recorded reason. Null when none failed. */
export function failedSummary(leads: readonly PlanLead[]): string | null {
  const failed = leads.filter((lead) => lead.progress.tone === "failed");
  if (!failed.length) return null;
  const reasons = new Map<string, number>();
  for (const lead of failed) {
    const reason = failureText(lead.progress.text);
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const [top] = [...reasons.entries()].sort((a, b) => b[1] - a[1]);
  return `${failed.length} failed (${top![0]}${reasons.size > 1 ? `; ${reasons.size - 1} other ${reasons.size === 2 ? "reason" : "reasons"}` : ""})`;
}

/**
 * How a plan ended once its channel engines have nothing left to send to
 * any of its leads: completed when every lead was contacted and none
 * failed, failed when none was contacted, partial otherwise. Null while
 * any lead still has something coming (a first message, a follow-up, an
 * invitation awaiting acceptance), or when that is not known. It describes
 * delivery work only; the plan itself may stay running for replies.
 */
export function planOutcome(leads: readonly PlanLead[]): { state: "completed" | "partial" | "failed"; reason: string } | null {
  if (!leads.length || leads.some((lead) => lead.open !== false)) return null;
  const contacted = leads.filter(contactedLead).length;
  const failed = failedSummary(leads);
  const stopped = leads.filter((lead) => lead.progress.tone === "stopped" && !contactedLead(lead)).length;
  const others = [failed, stopped ? `${stopped} stopped before a message` : null].filter(Boolean);
  if (contacted === leads.length && !failed) return { state: "completed", reason: `all ${contacted} contacted; nothing left to send` };
  if (contacted === 0) return { state: "failed", reason: `${others.join(", ")}, 0 contacted; nothing left to send` };
  return { state: "partial", reason: `${contacted} contacted, ${others.join(", ")}; nothing left to send` };
}

/**
 * A plan's state from where its leads stand (runLeads) first, then what its
 * senders say (the plan card's Sending status, diagnoseDelivery):
 * - nothing left to send to any lead (and no sender with leads waiting):
 *   its outcome, completed, partial or failed, with the counts and the
 *   recorded failure reason; never "Working";
 * - running with a channel that failed to launch: partial;
 * - where every open lead's timing is known (email): every one waiting on a
 *   follow-up still ahead is scheduled, with the earliest follow-up; due
 *   work missing from the queue is "not prepared yet" (the send tick's
 *   repair or the next build prepares it), unless the daily lead limit or
 *   a sender's own hold explains it;
 * - every sender held: by the daily lead limit only, its own state with
 *   the reset time; otherwise waiting to send, naming the holds (a pause
 *   between sends shows only while a prepared message waits on it);
 * - otherwise working, which is not proof of a send.
 * `nextAt` is when that wait ends (a follow-up, a reset, a sender's next
 * allowed send), for the page to show. `senders` null: not looked at;
 * `leads` null: not looked at.
 */
export function planState(input: { status: string; error: string | null; senders: readonly Sender[] | null; leads?: readonly PlanLead[] | null; now?: Date }): { state: WorkState; reason: string | null; open: boolean; nextAt: string | null } {
  const open = ["proposed", "starting", "running", "paused"].includes(input.status);
  const state = runState(input.status);
  if (input.status !== "running") return { state, reason: input.status === "starting" || input.status === "proposed" ? null : input.error, open, nextAt: null };
  const outcome = input.leads ? planOutcome(input.leads) : null;
  const waiting = input.senders?.reduce((sum, sender) => sum + (sender.queued ?? 0), 0) ?? 0;
  if (outcome && waiting === 0) {
    // Still running (its controls apply, replies are still handled), but no delivery work remains.
    const reason = input.error ? `${outcome.reason}; ${input.error}` : outcome.reason;
    return { state: input.error && outcome.state === "completed" ? "partial" : outcome.state, reason, open: false, nextAt: null };
  }
  const failed = input.leads ? failedSummary(input.leads) : null;
  const withFailures = (reason: string) => (failed ? `${reason}; ${failed} so far` : reason);
  if (input.error) return { state: "partial", reason: withFailures(`running on its other channels; ${input.error}`), open, nextAt: null };
  const senders = input.senders ?? [];
  const held = senders.length > 0 && senders.every((sender) => sender.gates.length > 0);

  // The leads first, where their channel says when their next message is due.
  const openLeads = (input.leads ?? []).filter((lead) => lead.open !== false);
  if (openLeads.length && openLeads.every((lead) => lead.queued !== undefined)) {
    const now = (input.now ?? new Date()).getTime();
    const due = openLeads.filter((lead) => !lead.nextAt || Date.parse(lead.nextAt) <= now);
    if (!due.length) {
      return { state: "scheduled", reason: withFailures(`${openLeads.length} contacted — waiting for a reply`), open, nextAt: earliestOf(openLeads.map((lead) => lead.nextAt)) };
    }
    if (!due.some((lead) => lead.queued)) {
      const limited = senders.flatMap((sender) => sender.gates).find(isLeadLimit);
      if (limited && due.every((lead) => lead.firstMessage)) {
        return { state: "daily_lead_limit", reason: withFailures(limited), open, nextAt: earliest(senders.filter((sender) => sender.gates.some(isLeadLimit))) };
      }
      if (!held) {
        const n = due.length;
        return { state: "waiting_send", reason: withFailures(`${plural(n, "due message is", "due messages are")} ${NOT_PREPARED}; ${n === 1 ? "it is" : "they are"} prepared again automatically`), open, nextAt: null };
      }
    }
  }

  if (!held) return { state, reason: withFailures("sending within each channel's daily limits; sent messages show in Replies and Overview"), open, nextAt: null };
  const nextAt = earliest(senders);
  const gates = [...new Set(senders.flatMap((sender) => sender.gates))];
  // Held by nothing but the daily lead limit: first messages wait for the next day; follow-ups are not held by it.
  if (gates.every(isLeadLimit)) return { state: "daily_lead_limit", reason: withFailures(gates.join("; ")), open, nextAt };
  return { state: "waiting_send", reason: withFailures(`no sender can send right now: ${gates.join("; ")}`), open, nextAt };
}

/** What a plan's `nextAt` is, in the words shown before it: "…; next follow-up Wed 23 Oct 21:54 (Asia/Kolkata)". */
export function nextAtPhrase(state: WorkState): string {
  if (state === "scheduled") return "next follow-up";
  if (state === "daily_lead_limit") return "resets";
  return "the next send is allowed";
}

/**
 * A plan's people, those contacted (a message at least accepted for
 * sending; an uncertain or failed send is not one), those who replied and
 * those whose send failed: each lead's reach (runLeads.ts leadReach, which
 * survives a stop), else its progress as the plan card shows it.
 */
export function planCounts(leads: readonly PlanLead[]): { leads: number; contacted: number; replied: number; failed: number } {
  const replied = (lead: PlanLead) => lead.reach?.replied ?? (lead.progress.tone === "replied" || lead.progress.tone === "good");
  return { leads: leads.length, contacted: leads.filter(contactedLead).length, replied: leads.filter(replied).length, failed: leads.filter((lead) => lead.progress.tone === "failed").length };
}

export type ReplyState = "answered" | "needs_you" | "action_required" | "processing" | "waiting";

export const REPLY_STATE_LABELS: Record<ReplyState, string> = {
  answered: "Answered",
  needs_you: "Needs you",
  action_required: "Action required",
  processing: "Being handled",
  waiting: "No answer yet",
};

/**
 * Where an inbound reply stands: answered when a later outbound message
 * exists in its conversation; otherwise from its record's workflow state.
 * The record's state belongs to its newest reply, so an older reply that
 * was answered stays Answered; on the newest, needs-you wins over answered.
 * `needsYou` is the CRM's Needs you (an open owner decision or a draft
 * awaiting review), and only it says Needs you: a quote the assistant could
 * not give is the owner's even after its holding reply went out. A record in
 * Action required without one (a classification to confirm, a takeover) is
 * Action required, as in the CRM.
 */
export function replyState(input: { answered: boolean; latest: boolean; workflowState: string | null; needsYou?: boolean }): ReplyState {
  if (input.answered && !input.latest) return "answered";
  if (input.needsYou) return "needs_you";
  if (input.workflowState === "action_required") return "action_required";
  if (input.answered) return "answered";
  if (input.workflowState === "classifying" || input.workflowState === "unclassified") return "processing";
  return "waiting";
}

/**
 * How far a look at the Replies list marks replies seen: up to the newest
 * recorded time it showed, and only when it showed every channel and
 * something new. A channel-filtered list marks nothing, so a reply it hid
 * stays new in the list and in the badge. Null: nothing to mark.
 */
export function repliesSeenUntil(channel: string, replies: readonly { recordedAt: string; isNew: boolean }[]): string | null {
  if (channel !== "all" || !replies.some((reply) => reply.isNew)) return null;
  let newest = replies[0]!.recordedAt;
  for (const reply of replies) if (Date.parse(reply.recordedAt) > Date.parse(newest)) newest = reply.recordedAt;
  return newest;
}
