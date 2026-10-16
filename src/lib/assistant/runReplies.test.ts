import { describe, expect, test } from "bun:test";
import { replyState, type ReplyRecord } from "./runReplies";

const now = new Date("2026-10-15T10:00:00Z");
const base: ReplyRecord = { draftStatus: null, autoStatus: null, autoReason: null, jobStatus: null, sendAfter: null, receivedAt: "2026-10-15T09:58:00Z" };

describe("replyState", () => {
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
    expect(replyState({ ...base, agentStatus: "drafted", agentReason: "the run is in Review mode: the reply waits for you in Action required" }, false, now).text).toContain("Review mode");
    expect(replyState({ ...base, agentStatus: "drafted", draftStatus: "sent" }, false, now)).toMatchObject({ tone: "done", text: "Answered" });
    expect(replyState({ ...base, agentStatus: "told_owner", agentReason: "asks about a refund" }, true, now)).toMatchObject({ tone: "you" });
    expect(replyState({ ...base, agentStatus: "stopped", agentReason: "a newer message arrived; that one is answered instead" }, true, now)).toMatchObject({ tone: "done" });
    expect(replyState({ ...base, agentStatus: "failed", agentReason: "the send failed: refused" }, true, now)).toMatchObject({ tone: "failed" });
  });
});
