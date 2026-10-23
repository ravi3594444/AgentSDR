import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HISTORY_FETCH_LIMIT, replyConversationSnapshot } from "./replyConversation";

type RawMessage = {
  id: string;
  channel: string;
  direction: "inbound" | "outbound";
  sentAt: string;
  subject: string | null;
  bodyText: string;
};

function message(index: number, overrides: Partial<RawMessage> = {}): RawMessage {
  return {
    id: `m-${index}`,
    channel: "email",
    direction: index % 2 === 0 ? "inbound" : "outbound",
    sentAt: new Date(1_700_000_000_000 + index * 60_000).toISOString(),
    subject: index === 0 ? "Original subject" : null,
    bodyText: `message ${index}`,
    ...overrides,
  };
}

describe("replyConversationSnapshot limits", () => {
  it("keeps the newest twenty messages, in order", () => {
    const all = Array.from({ length: 35 }, (_, index) => message(index));
    const snapshot = replyConversationSnapshot(all);
    assert.equal(snapshot.length, 20);
    assert.equal(snapshot[0]?.bodyText, "message 15");
    assert.equal(snapshot[19]?.bodyText, "message 34");
  });

  it("feeding only the newest twenty raw messages changes nothing", () => {
    // The bounded loaders fetch the tail of the thread instead of all of it;
    // the snapshot must be identical either way.
    const all = Array.from({ length: 60 }, (_, index) => message(index));
    assert.deepEqual(replyConversationSnapshot(all.slice(-20)), replyConversationSnapshot(all));
  });

  it("call summaries appended after the messages consume window slots, bounded fetch included", () => {
    const all = Array.from({ length: 30 }, (_, index) => message(index));
    const calls = Array.from({ length: 5 }, (_, index) => message(1_000 + index, { channel: "whatsapp_call", bodyText: `call ${index}` }));
    const combined = [...all, ...calls];
    // Call entries sit at the tail of the combined list the loaders build;
    // fetching the newest twenty messages plus the calls slices identically.
    assert.deepEqual(
      replyConversationSnapshot([...all.slice(-20), ...calls]),
      replyConversationSnapshot(combined),
    );
  });

  it("skips blank bodies and caps each message and the total characters", () => {
    const all = [
      message(0, { bodyText: "   " }),
      message(1, { bodyText: "x".repeat(11_000) }),
      message(2, { bodyText: "y".repeat(5_000) }),
    ];
    const snapshot = replyConversationSnapshot(all);
    assert.equal(snapshot.length, 2);
    assert.ok(snapshot.every((item) => item.bodyText.length <= 2_000));

    const many = Array.from({ length: 10 }, (_, index) => message(index, { bodyText: "z".repeat(2_000) }));
    const capped = replyConversationSnapshot(many);
    assert.equal(capped.length, 6);
    assert.equal(capped.reduce((total, item) => total + item.bodyText.length, 0), 12_000);
  });

  it("handles empty and short threads", () => {
    assert.deepEqual(replyConversationSnapshot([]), []);
    assert.deepEqual(replyConversationSnapshot("nope"), []);
    assert.equal(replyConversationSnapshot([message(0), message(1)]).length, 2);
  });
});

describe("the history fetch limit", () => {
  it("covers the classification context's worst-case selection", () => {
    // The classifier's context cap is at most 32,000 tokens (~128,000
    // characters); a selected message serializes to at least ~170
    // characters, so its selection can never reach past ~750 messages.
    assert.ok(HISTORY_FETCH_LIMIT >= 750);
  });
});
