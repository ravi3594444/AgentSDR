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
  sendAfter: string | null;
  receivedAt: string;
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

export function replyState(record: ReplyRecord, automatic: boolean, now: Date = new Date()): ReplyState {
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
  if (record.draftStatus === "generating" || (!record.draftStatus && now.getTime() - new Date(record.receivedAt).getTime() < READING_MS)) {
    return { tone: "waiting", text: "Reading the reply and writing an answer…" };
  }
  if (record.draftStatus === "failed") return { tone: "failed", text: "The answer could not be written; see Action required" };
  if (record.draftStatus === "awaiting_review") {
    return { tone: "you", text: automatic ? "Waiting for you in Action required" : "Review mode: the answer waits for you in Action required" };
  }
  if (record.draftStatus === "discarded" || record.draftStatus === "stale") return { tone: "done", text: "No answer needed (draft set aside)" };
  return { tone: "you", text: "No answer was written; see Action required" };
}
