import { describe, expect, test } from "bun:test";
import { replyState, type ReplyRecord } from "./runReplies";

const now = new Date("2026-10-15T10:00:00Z");
const base: ReplyRecord = { draftStatus: null, autoStatus: null, autoReason: null, jobStatus: null, sendAfter: null, receivedAt: "2026-10-15T09:58:00Z" };

describe("replyState", () => {
  test("a reply waiting for sender spacing shows its queued time, not an owner decision", () => {
    const state = replyState({ ...base, draftStatus: "awaiting_review", agentStatus: "drafted", agentReason: "Waiting between messages", jobStatus: "queued", sendAfter: "2026-10-15T10:00:25Z" }, true, now);
    expect(state).toEqual({ tone: "waiting", text: "Answer written; waiting for the sender until", at: "2026-10-15T10:00:25Z" });
    expect(replyState({ ...base, agentStatus: "drafted", draftStatus: "sent", jobStatus: "succeeded" }, true, now)).toMatchObject({ tone: "done", text: "Answered" });
    expect(replyState({ ...base, agentStatus: "drafted", autoStatus: "held", autoReason: "outreach is paused", jobStatus: "succeeded" }, true, now)).toMatchObject({ tone: "you", text: "Answer not sent: outreach is paused" });
  });

  test("incoming processing failures and retries are not mistaken for a healthy sending queue", () => {
    expect(replyState({ ...base, classificationStatus: "failed", classificationError: "AI unavailable" }, true, now)).toEqual({ tone: "failed", text: "Reply processing failed: AI unavailable" });
    expect(replyState({ ...base, classificationStatus: "queued", agentStatus: "failed" }, true, now)).toMatchObject({ tone: "waiting", text: "Retrying reply processing after an error…" });
    expect(replyState({ ...base, classificationStatus: "running" }, true, now).text).toContain("queued for processing");
    expect(replyState({ ...base, classificationStatus: "failed", draftStatus: "sent" }, true, now)).toMatchObject({ tone: "done", text: "Answered" });
    expect(replyState({ ...base, jobStatus: "failed", jobError: "worker stopped" }, true, now)).toEqual({ tone: "failed", text: "Queued reply processing failed: worker stopped" });
  });

  test("a disconnected sender applies only to this reply's account, and never erases a recorded answer", () => {
    expect(replyState({ ...base, senderStatus: "disconnected" }, true, now)).toMatchObject({ tone: "failed" });
    expect(replyState({ ...base, senderStatus: "connected" }, true, now)).toMatchObject({ tone: "waiting" });
    expect(replyState({ ...base, senderStatus: "disconnected", agentStatus: "replied" }, true, now)).toMatchObject({ tone: "done" });
    expect(replyState({ ...base, senderStatus: "disconnected", draftStatus: "sent" }, true, now)).toMatchObject({ tone: "done" });
  });
  test("says what became of a reply, in order of what happened last", () => {
    expect(replyState({ ...base, draftStatus: "sent", autoStatus: "sent" }, true, now)).toMatchObject({ tone: "done", text: "Answered automatically" });
    expect(replyState({ ...base, draftStatus: "sent" }, false, now)).toMatchObject({ tone: "done", text: "Answered" });
    expect(replyState({ ...base, draftStatus: "awaiting_review", autoStatus: "held", autoReason: "they asked for a call your information does not offer" }, true, now))
      .toEqual({ tone: "you", text: "Waiting for you: they asked for a call your information does not offer" });
    expect(replyState({ ...base, draftStatus: "awaiting_review", jobStatus: "queued", sendAfter: "2026-10-15T10:08:00Z" }, true, now))
      .toEqual({ tone: "waiting", text: "Answer written; it goes out at", at: "2026-10-15T10:08:00Z" });
    expect(replyState(base, true, now)).toMatchObject({ tone: "waiting", text: "Reading the reply and writing an answer…" });
    expect(replyState({ ...base, receivedAt: "2026-10-15T09:00:00Z" }, true, now)).toMatchObject({ tone: "you" });
    expect(replyState({ ...base, draftStatus: "awaiting_review" }, false, now).text).toContain("Review mode");
    expect(replyState({ ...base, draftStatus: "awaiting_review", autoStatus: "failed", autoReason: "Unipile refused it" }, true, now)).toMatchObject({ tone: "failed" });
  });

  test("the reply agent's outcome comes first, with how long the answer took", () => {
    expect(replyState({ ...base, agentStatus: "replied", agentMs: 4_230 }, true, now)).toEqual({ tone: "done", text: "Answered automatically in 4.2 s" });
    expect(replyState({ ...base, agentStatus: "replied", agentMs: 12_400, agentReason: "sent; the owner was told: wants a visit" }, true, now).text)
      .toBe("Answered automatically in 12 s; you were told in Needs you");
    expect(replyState({ ...base, agentStatus: "running" }, true, now)).toMatchObject({ tone: "waiting" });
    expect(replyState({ ...base, agentStatus: "no_reply", agentReason: "they only said thanks" }, true, now)).toEqual({ tone: "done", text: "No answer needed: they only said thanks" });
    expect(replyState({ ...base, agentStatus: "drafted", agentReason: "the run is in Review mode: the reply waits for you in the Inbox (Needs you)" }, false, now).text).toContain("Review mode");
    expect(replyState({ ...base, agentStatus: "drafted", draftStatus: "sent" }, false, now)).toMatchObject({ tone: "done", text: "Answered" });
    expect(replyState({ ...base, agentStatus: "told_owner", agentReason: "asks about a refund" }, true, now)).toMatchObject({ tone: "you" });
    expect(replyState({ ...base, agentStatus: "stopped", agentReason: "a newer message arrived; that one is answered instead" }, true, now)).toMatchObject({ tone: "done" });
    expect(replyState({ ...base, agentStatus: "failed", agentReason: "the send failed: refused" }, true, now)).toMatchObject({ tone: "failed" });
  });

  test("a wrong number says so, with where its one apology stands", () => {
    const wrong = { ...base, agentAction: "wrong_number" };
    expect(replyState({ ...wrong, agentStatus: "replied", agentReason: "Wrong number: outreach to this number stopped; one apology sent" }, true, now))
      .toEqual({ tone: "done", text: "Wrong number — outreach stopped; apology sent" });
    expect(replyState({ ...wrong, agentStatus: "drafted" }, false, now)).toEqual({ tone: "you", text: "Wrong number — outreach stopped; the apology waits for you in the Inbox (Needs you)" });
    expect(replyState({ ...wrong, agentStatus: "drafted", draftStatus: "sent" }, false, now).text).toBe("Wrong number — outreach stopped; apology sent");
    expect(replyState({ ...wrong, agentStatus: "stopped", agentReason: "Wrong number: outreach to this number stopped; no apology (they asked not to be contacted)" }, true, now))
      .toEqual({ tone: "done", text: "Wrong number — outreach stopped; no apology (they asked not to be contacted)" });
    expect(replyState({ ...wrong, agentStatus: "stopped", agentReason: "Wrong number: outreach to this number stopped; whether the apology arrived is uncertain, so it is not resent" }, true, now).tone).toBe("you");
    expect(replyState({ ...wrong, agentStatus: "stopped", agentReason: "Wrong number: outreach to this number stopped; the apology could not be sent and is not retried (refused)" }, true, now).tone).toBe("failed");
  });
});

// Review of pilot L05: the chat's reply lines sent people to "Action
// required"; what waits for a person is in the Inbox, under Needs you.
describe("where a reply that waits for a person is", () => {
  test("every line names the Inbox (Needs you), never Action required", () => {
    const records: [ReplyRecord, boolean][] = [
      [{ ...base, draftStatus: "awaiting_review" }, false],
      [{ ...base, draftStatus: "awaiting_review" }, true],
      [{ ...base, draftStatus: "failed" }, true],
      [{ ...base, receivedAt: "2026-10-15T09:00:00Z" }, true],
      [{ ...base, agentStatus: "drafted", agentReason: "the run is in Review mode: the reply waits for you in the Inbox (Needs you)" }, false],
      [{ ...base, agentAction: "wrong_number", agentStatus: "drafted" }, false],
    ];
    for (const [record, automatic] of records) {
      const { text } = replyState(record, automatic, now);
      expect(text).not.toContain("Action required");
      expect(text).toContain("the Inbox (Needs you)");
    }
    expect(replyState({ ...base, draftStatus: "awaiting_review" }, false, now).text).toBe("Review mode: the answer waits for you in the Inbox (Needs you)");
  });
});
