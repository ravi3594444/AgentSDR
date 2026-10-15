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
});
