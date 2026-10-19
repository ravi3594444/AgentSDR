/**
 * What a piece of background work is doing right now, told from its record
 * only (never from a guess): a search job, or an outreach plan. A stored
 * "running" with an old heartbeat is stale, not working; a run is not a
 * confirmed send. Pure and client-safe; activity.server.ts reads the rows.
 */

export type WorkState =
  | "queued"
  | "executing"
  | "waiting_slot"
  | "waiting_quota"
  | "outside_hours"
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
  outside_hours: "Outside sending hours",
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
export const OPEN_STATES: ReadonlySet<WorkState> = new Set(["queued", "executing", "waiting_slot", "waiting_quota", "outside_hours", "scheduled", "retrying", "needs_approval", "paused", "stale"]);

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
      if (waiting?.kind === "slot") return { state: "waiting_slot", reason };
      if (waiting?.kind === "quota") return { state: "waiting_quota", reason };
      if (typeof job.progress?.lastError === "string" && job.attempts > 0) return { state: "retrying", reason: job.progress.lastError };
      if (job.runAfter && job.runAfter.getTime() > now.getTime() + 5_000) return { state: "scheduled", reason: null };
      return { state: "queued", reason: null };
    }
  }
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
export const CANCELLABLE_JOB_KINDS = ["discovery", "web_discovery", "linkedin_search", "apify_instagram"] as const;

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

type Sender = { gates: readonly string[]; nextAt: string | null };

const HOURS_GATE = /^outside .*hours/i;

function earliest(senders: readonly Sender[]): string | null {
  const times = senders.flatMap((sender) => (sender.nextAt ? [sender.nextAt] : [])).sort((a, b) => Date.parse(a) - Date.parse(b));
  return times[0] ?? null;
}

/**
 * A plan's state with what its senders say (the plan card's Sending status,
 * diagnoseDelivery): running with a channel that failed to launch is
 * partial; running with every sender outside its hours (and held by nothing
 * without a known end) waits for them; held by anything else, it is working
 * and names the holds. `senders` null: not
 * looked at, the run's status alone.
 */
export function planState(input: { status: string; error: string | null; senders: readonly Sender[] | null }, now: Date): { state: WorkState; reason: string | null; open: boolean } {
  void now;
  const open = ["proposed", "starting", "running", "paused"].includes(input.status);
  const state = runState(input.status);
  if (input.status !== "running") return { state, reason: input.status === "starting" || input.status === "proposed" ? null : input.error, open };
  if (input.error) return { state: "partial", reason: `running on its other channels; ${input.error}`, open };
  const senders = input.senders ?? [];
  if (!senders.length || senders.some((sender) => !sender.gates.length)) return { state, reason: "sending within each channel's hours and daily limits; sent messages show in Replies and Overview", open };
  const next = earliest(senders);
  const when = next ? `; the next send is allowed at ${next}` : "";
  // Only hours (and holds that end at a known time): a sender also held without an end, such as a disconnection, is not merely waiting for its hours.
  if (senders.every((sender) => sender.nextAt && sender.gates.some((gate) => HOURS_GATE.test(gate)))) return { state: "outside_hours", reason: `every sender is outside its sending hours${when}`, open };
  return { state, reason: `no sender can send right now: ${[...new Set(senders.flatMap((sender) => sender.gates))].join("; ")}${when}`, open };
}

/**
 * A plan's people, those contacted (a message at least accepted for
 * sending; an uncertain or failed send is not one) and those who replied,
 * from each lead's progress as the plan card shows it.
 */
export function planCounts(leads: readonly { progress: { tone: string } }[]): { leads: number; contacted: number; replied: number } {
  const replied = leads.filter((lead) => lead.progress.tone === "replied" || lead.progress.tone === "good").length;
  return { leads: leads.length, contacted: replied + leads.filter((lead) => lead.progress.tone === "sent").length, replied };
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
