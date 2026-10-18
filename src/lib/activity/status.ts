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
  | "scheduled"
  | "retrying"
  | "needs_approval"
  | "paused"
  | "completed"
  | "not_searched"
  | "failed"
  | "cancelled"
  | "stale";

export const WORK_STATE_LABELS: Record<WorkState, string> = {
  queued: "Queued",
  executing: "Working",
  waiting_slot: "Waiting for a run slot",
  waiting_quota: "Waiting for a provider limit",
  scheduled: "Scheduled",
  retrying: "Retrying",
  needs_approval: "Needs your Start",
  paused: "Paused",
  completed: "Done",
  not_searched: "Not searched",
  failed: "Failed",
  cancelled: "Cancelled",
  stale: "Stalled",
};

/** States that may still change by themselves; a finished item will not. */
export const OPEN_STATES: ReadonlySet<WorkState> = new Set(["queued", "executing", "waiting_slot", "waiting_quota", "scheduled", "retrying", "needs_approval", "paused", "stale"]);

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
      return job.result?.notSearched === true || job.result?.handedToJobId ? { state: "not_searched", reason: typeof job.result?.note === "string" ? job.result.note : null } : { state: "completed", reason: null };
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

export type ReplyState = "answered" | "needs_you" | "processing" | "waiting";

export const REPLY_STATE_LABELS: Record<ReplyState, string> = {
  answered: "Answered",
  needs_you: "Needs you",
  processing: "Being handled",
  waiting: "No answer yet",
};

/**
 * Where an inbound reply stands: answered when a later outbound message
 * exists in its conversation; otherwise from its record's workflow state.
 * The record's state belongs to its newest reply, so an older reply that
 * was answered stays Answered; on the newest, needs-you wins over answered.
 */
export function replyState(input: { answered: boolean; latest: boolean; workflowState: string | null }): ReplyState {
  if (input.answered && !input.latest) return "answered";
  if (input.workflowState === "action_required") return "needs_you";
  if (input.answered) return "answered";
  if (input.workflowState === "classifying" || input.workflowState === "unclassified") return "processing";
  return "waiting";
}
