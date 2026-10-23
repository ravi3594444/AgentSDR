import { NO_ANSWER_NEEDED } from "./handoff";

/**
 * What became of each reply to an outreach run, in words the owner can act
 * on: answered, going out at a time, waiting for them (and why), or
 * failed. Pure, from the records runReplies.server.ts reads.
 */

export type ReplyRecord = {
  draftStatus: string | null;
  autoStatus: string | null;
  autoReason: string | null;
  jobStatus: string | null;
  jobError?: string | null;
  sendAfter: string | null;
  receivedAt: string;
  /** The reply agent's outcome for this message (reply_agent_runs), when it handled it. */
  agentStatus?: string | null;
  agentReason?: string | null;
  agentMs?: number | null;
  /** The agent's action (reply_agent_runs.action): "wrong_number" is shown as such, never as an answer. */
  agentAction?: string | null;
  classificationStatus?: string | null;
  classificationError?: string | null;
  /** The account of this conversation, never another record with the same display number. */
  senderStatus?: string | null;
};

export type ReplyState = {
  tone: "done" | "waiting" | "you" | "failed";
  text: string;
  /** When the automatic answer is due (the client shows it in local time). */
  at?: string;
  /** The owner took this chat over; "Let the assistant reply" hands it back. */
  release?: boolean;
};

/** A reply with no draft yet is still being read for this long; after that it is shown as not answered. */
const READING_MS = 5 * 60_000;

function seconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  return ` in ${ms < 10_000 ? (ms / 1_000).toFixed(1) : Math.round(ms / 1_000)} s`;
}

/** A wrong number (crm/wrongNumberAck.server.ts): outreach to it stopped, and where the one apology stands. */
function wrongNumberState(record: ReplyRecord): ReplyState {
  const head = "Wrong number — outreach stopped";
  const detail = (record.agentReason ?? "").split("; ").slice(1).join("; ");
  if (record.agentStatus === "replied" || record.draftStatus === "sent") return { tone: "done", text: `${head}; apology sent` };
  if (record.agentStatus === "drafted") return { tone: "you", text: `${head}; the apology waits for you in the Inbox (Needs you)` };
  if (/uncertain/.test(detail)) return { tone: "you", text: `${head}; ${detail}` };
  if (/could not be sent/.test(detail)) return { tone: "failed", text: `${head}; ${detail}` };
  return { tone: "done", text: detail ? `${head}; ${detail}` : head };
}

/** What the reply agent did with the message (replyAgent/agent.server.ts). */
function agentState(record: ReplyRecord): ReplyState | null {
  const reason = record.agentReason ?? "";
  if (record.agentAction === "wrong_number" && record.agentStatus !== "running") return wrongNumberState(record);
  switch (record.agentStatus) {
    case "running": return { tone: "waiting", text: "Reading the reply and answering…" };
    case "replied": return { tone: "done", text: `Answered automatically${seconds(record.agentMs)}${reason.includes("the owner was told") ? "; you were told in Needs you" : ""}` };
    case "drafted":
      if (record.draftStatus === "sent") return { tone: "done", text: "Answered" };
      if (record.autoStatus === "failed") return { tone: "failed", text: `The queued answer failed${record.autoReason ? `: ${record.autoReason}` : ""}` };
      if (record.autoStatus === "held" && record.autoReason && !record.autoReason.startsWith("Waiting for the sender's gap")) return { tone: "you", text: `Answer not sent: ${record.autoReason}` };
      if (record.jobStatus === "queued" && record.sendAfter) return { tone: "waiting", text: "Answer written; waiting for the sender until", at: record.sendAfter };
      if (record.jobStatus === "running") return { tone: "waiting", text: "Checking the queued answer before sending…" };
      if (record.draftStatus === "stale" || record.draftStatus === "discarded") return { tone: "done", text: "This answer was set aside; it will not be sent" };
      return { tone: "you", text: reason.includes("Review mode") ? "Review mode: the answer waits for you in the Inbox (Needs you)" : `Answer written, not sent: ${reason}` };
    case "no_reply": return { tone: "done", text: `No answer needed${reason ? `: ${reason}` : ""}` };
    case "told_owner": return { tone: "you", text: `Waiting for you in Needs you${reason ? `: ${reason}` : ""}` };
    case "failed": return { tone: "failed", text: `The automatic answer failed${reason ? `: ${reason}` : ""}` };
    case "stopped":
      if (reason.includes("handling this conversation yourself")) return { tone: "you", text: "You took this chat over, so the assistant is not replying", release: true };
      if (reason.includes("newer message") || reason.includes("already answered")) return { tone: "done", text: `Not answered separately: ${reason}` };
      return { tone: "you", text: `Not answered: ${reason}` };
    default: return null;
  }
}

export function replyState(record: ReplyRecord, automatic: boolean, now: Date = new Date()): ReplyState {
  if (record.agentStatus !== "replied" && record.draftStatus !== "sent" && record.autoStatus !== "sent") {
    if (record.jobStatus === "failed") return { tone: "failed", text: `Queued reply processing failed${record.jobError ? `: ${record.jobError}` : "; see the Inbox (Needs you)"}` };
    if (record.classificationStatus === "failed") return { tone: "failed", text: `Reply processing failed${record.classificationError ? `: ${record.classificationError}` : "; see the Inbox (Needs you)"}` };
    if (record.agentStatus === "failed" && (record.classificationStatus === "queued" || record.classificationStatus === "running")) {
      return { tone: "waiting", text: "Retrying reply processing after an error…" };
    }
  }
  const agent = agentState(record);
  if (agent?.tone === "done") return agent;
  if (record.senderStatus && record.senderStatus !== "connected" && record.draftStatus !== "sent" && record.autoStatus !== "sent") {
    return { tone: "failed", text: `The WhatsApp connection for this reply is recorded as ${record.senderStatus}; check this conversation's sender in the Inbox` };
  }
  if (agent) return agent;
  const handover = record.autoReason?.startsWith("handover") ?? false;
  if (handover && (record.autoStatus === "sent" || (record.draftStatus === "sent" && record.autoStatus === "reserved"))) {
    return { tone: "you", text: "Told them you will reply personally; waiting for you in Needs you" };
  }
  if (record.autoStatus === "sent" || (record.draftStatus === "sent" && record.autoStatus === "reserved")) return { tone: "done", text: "Answered automatically" };
  if (record.draftStatus === "sent") return { tone: "done", text: "Answered" };
  if (record.autoStatus === "held" && record.autoReason?.startsWith(NO_ANSWER_NEEDED)) return { tone: "done", text: "No answer needed (they only acknowledged the last answer)" };
  if (record.autoStatus === "held" && record.autoReason?.includes("waits for you in Needs you")) return { tone: "you", text: "Waiting for you in Needs you" };
  if (record.autoStatus === "held" && record.autoReason?.includes("handling this conversation yourself")) return { tone: "you", text: "You took this chat over, so the assistant is not replying", release: true };
  if (record.autoStatus === "held") return { tone: "you", text: `Waiting for you: ${record.autoReason ?? "the answer needs your decision"}` };
  if (record.autoStatus === "failed") return { tone: "failed", text: `The automatic answer failed${record.autoReason ? `: ${record.autoReason}` : ""}` };
  if (record.autoStatus === "reserved") return { tone: "waiting", text: "Sending the answer…" };
  if ((record.jobStatus === "queued" || record.jobStatus === "running") && record.sendAfter) {
    return new Date(record.sendAfter).getTime() > now.getTime()
      ? { tone: "waiting", text: "Answer written; it goes out at", at: record.sendAfter }
      : { tone: "waiting", text: "Checking the answer before it goes out…" };
  }
  if (record.classificationStatus === "queued" || record.classificationStatus === "running") return { tone: "waiting", text: "The incoming reply is queued for processing…" };
  if (record.draftStatus === "generating" || (!record.draftStatus && now.getTime() - new Date(record.receivedAt).getTime() < READING_MS)) {
    return { tone: "waiting", text: "Reading the reply and writing an answer…" };
  }
  if (record.draftStatus === "failed") return { tone: "failed", text: "The answer could not be written; see the Inbox (Needs you)" };
  if (record.draftStatus === "awaiting_review") {
    return { tone: "you", text: automatic ? "Waiting for you in the Inbox (Needs you)" : "Review mode: the answer waits for you in the Inbox (Needs you)" };
  }
  if (record.draftStatus === "discarded" || record.draftStatus === "stale") return { tone: "done", text: "No answer needed (draft set aside)" };
  return { tone: "you", text: "No answer was written; see the Inbox (Needs you)" };
}
